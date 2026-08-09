// The failure mode under test: a synthesized agent that asks for something it is not
// allowed to have, and finds out at runtime.
//
// Three ceilings, all of them stated in the design and none of them checked here until
// Phase 4. The transport one was found the expensive way: running a non-coding mission
// against a real model, `synthesize` chose `agent-sdk` for every research/general task
// — a perfectly reasonable reading of §7's five-row registry table, of which Phase 2
// ships one — and every task died at *dispatch*, burned its typed retry, took the
// replan with it, and the mission escalated at the reset cap having produced nothing.
// Seven rounds to discover a fact known before the first dispatch.
//
// The envelope one was worse, because nothing discovered it at all: §7's claim is that
// "synthesis draws only from the envelope and can never widen it", and `violations()`
// had no caller outside its own test. The lease one is the same shape a third time —
// §8 fully built and never fired, because `owns` was hardcoded empty.
//
// So these assert one thing in three places: the ceiling is an *input* to the call,
// and a spec outside it fails at validation rather than at runtime.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import {
  anAgentSpec,
  anEnvelope,
  aPlannedTask,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { type Calls } from "./calls.js";
import { type MissionStore } from "./run.js";
import {
  EnvelopeViolationError,
  SynthesisError,
  synthesizeTasks,
  UnavailableTransportError,
  UndeclaredLeaseError,
} from "./synthesize.js";

function testStore(seed: readonly EventInput[]): MissionStore & { inputs: EventInput[] } {
  const inputs = [...seed];
  return {
    inputs,
    emit: (event) => {
      inputs.push(event);
    },
    state: () => fold(stamp(inputs)),
  };
}

/** Answers with the given specs in order, recording what it was asked. */
function scriptedSynthesize(specs: readonly ReturnType<typeof anAgentSpec>[]) {
  const seen: Parameters<Calls["synthesize"]>[0][] = [];
  let index = 0;

  const calls: Pick<Calls, "synthesize"> = {
    synthesize: async (input) => {
      seen.push(input);
      const spec = specs[index++];
      if (!spec) throw new Error(`no scripted spec for call ${index}`);
      return spec;
    },
  };

  return { calls, seen };
}

const deps = (store: MissionStore, calls: Pick<Calls, "synthesize">) => ({ store, calls });

describe("synthesizeTasks", () => {
  test("tells the model which transports actually exist", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.deepEqual(seen[0]!.transports, ["cli"]);
  });

  // Prior art, not a roster (§7). Passing them is the whole of the mechanism; what
  // makes it safe is the next test — the returned spec is validated identically.
  test("offers saved profiles to the model when it has any", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);
    const profile = anAgentSpec({ role: "invoice-reconciler" });

    await synthesizeTasks({ ...deps(store, calls), profiles: [profile] }, [aPlannedTask()], 0);

    assert.deepEqual(seen[0]!.profiles, [profile]);
  });

  test("omits profiles entirely when there are none, rather than sending an empty list", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal("profiles" in seen[0]!, false);
  });

  // A profile is a hint and never a mandate: a spec that came back looking exactly
  // like a saved one still meets every ceiling, or the library becomes a way to
  // launder a capability past the envelope.
  test("a profile does not exempt the spec it inspired from validation", async () => {
    const store = testStore([missionCreated({ envelope: anEnvelope({ toolClasses: ["fs.read"] }) })]);
    const outsized = anAgentSpec({ worker: "research", tools: ["Bash"], owns: undefined });
    const { calls } = scriptedSynthesize([outsized, outsized]);

    await assert.rejects(
      synthesizeTasks(
        { ...deps(store, calls), profiles: [outsized] },
        [aPlannedTask({ worker: "research" })],
        0,
      ),
      EnvelopeViolationError,
    );
  });

  test("plans the task when the spec names an available transport", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ transport: { id: "cli", target: "claude" } })]);

    const added = await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal(added, 1);
    assert.equal(store.state().tasks.length, 1);
  });

  // The one retry every structured return gets, and for the same reason: a model
  // that named an unbuilt transport was not told which ones were built.
  test("rejects an unavailable transport and re-asks once, naming it", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "agent-sdk" } }),
      anAgentSpec({ transport: { id: "cli", target: "claude" } }),
    ]);

    const added = await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal(added, 1);
    assert.equal(seen.length, 2);
    assert.match(seen[1]!.rejected ?? "", /agent-sdk/);
    assert.match(seen[1]!.rejected ?? "", /cli/);
  });

  // Failing here is the whole point: at dispatch it costs a worker slot, a typed
  // retry, and a replan to learn the same thing.
  test("fails at validation rather than letting dispatch discover it", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "agent-sdk" } }),
      anAgentSpec({ transport: { id: "acp" } }),
    ]);

    await assert.rejects(
      () => synthesizeTasks(deps(store, calls), [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof UnavailableTransportError);
        assert.match(error.message, /acp/);
        // §2a rule 5: the message names the fix.
        assert.match(error.message, /cli/);
        return true;
      },
    );

    assert.equal(store.state().tasks.length, 0);
  });

  test("leaves tasks already on the board alone", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec()]);
    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    const again = await synthesizeTasks(deps(store, calls), [aPlannedTask()], 1);

    assert.equal(again, 0);
  });
});

describe("synthesis against the envelope", () => {
  // The envelope is written in classes and the spec comes back in tool names, so
  // something has to resolve one to the other before the model is asked. Offering the
  // class list — which is what this did until Phase 4 — asks for tools and shows
  // categories.
  test("offers the concrete tools the envelope's classes resolve to", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.deepEqual(seen[0]!.toolCatalogue, ["Read", "Glob", "Grep", "Write", "Edit", "Bash"]);
  });

  test("accepts a spec whose tools all sit inside the envelope", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ tools: ["Read", "Grep"] })]);

    assert.equal(await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0), 1);
  });

  test("re-asks once when a tool needs a class the envelope does not grant", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ toolClasses: ["fs.read"] }) }),
    ]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ tools: ["Read", "Bash"] }),
      anAgentSpec({ tools: ["Read"] }),
    ]);

    const added = await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal(added, 1);
    assert.equal(seen.length, 2);
    // The retry names the tool, the class that would have to be granted, and what is
    // on offer instead. A rejection that says only "denied" spends the retry teaching
    // nothing.
    assert.match(seen[1]!.rejected ?? "", /Bash/);
    assert.match(seen[1]!.rejected ?? "", /shell\.run/);
    assert.match(seen[1]!.rejected ?? "", /Read, Glob, Grep/);
  });

  // Not a near-miss and not a typo to be forgiven: it is not a tool we ship, so there
  // is no class to check it against and nothing that could grant it.
  test("refuses a tool that is not in the catalogue at all", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ tools: ["Read", "Frobnicate"] }),
      anAgentSpec({ tools: ["Read"] }),
    ]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.match(seen[1]!.rejected ?? "", /not in the catalogue/);
    assert.match(seen[1]!.rejected ?? "", /Frobnicate/);
  });

  // The point of the whole file: at dispatch this costs a worker slot, a typed retry,
  // and a replan to learn something knowable before the task existed.
  test("fails at validation when the second spec is still outside the envelope", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ toolClasses: ["fs.read"] }) }),
    ]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ tools: ["Bash"] }),
      anAgentSpec({ tools: ["Write"] }),
    ]);

    await assert.rejects(
      () => synthesizeTasks(deps(store, calls), [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof EnvelopeViolationError);
        assert.match(error.message, /Write/);
        // §2a rule 5, and §7's rule that widening is never automatic.
        assert.match(error.message, /human decision/);
        return true;
      },
    );

    assert.equal(store.state().tasks.length, 0);
  });

  // §7: the request "surfaces to the human as a question rather than being silently
  // granted or silently dropped". Widening is the one thing no code path may do, so
  // the only correct move is to stop and ask.
  test("records the violation and asks the human, blocking the task", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ toolClasses: ["fs.read"] }) }),
    ]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ tools: ["Bash"] }),
      anAgentSpec({ tools: ["Bash"] }),
    ]);

    await assert.rejects(() => synthesizeTasks(deps(store, calls), [aPlannedTask()], 0));

    const violation = store.inputs.find((event) => event.type === "envelope_violation");
    assert.ok(violation, "the violation is on the record, not only in the error");

    const asked = store.inputs.find((event) => event.type === "question_asked");
    assert.ok(asked);
    assert.deepEqual((asked as { blocks: string[] }).blocks, ["t1"]);
    assert.match((asked as { question: string }).question, /Bash/);
  });

  // A transport or a lease problem is the planner's to fix, so neither one belongs in
  // an inbox nobody can act on.
  test("does not ask the human about a transport it can replan around", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "acp" } }),
      anAgentSpec({ transport: { id: "acp" } }),
    ]);

    await assert.rejects(() => synthesizeTasks(deps(store, calls), [aPlannedTask()], 0));

    assert.equal(
      store.inputs.filter((event) => event.type === "question_asked").length,
      0,
    );
  });
});

describe("the lease a code agent declares", () => {
  test("carries the spec's lease onto the task, which is what §8 checks", async () => {
    const store = testStore([missionCreated()]);
    const owns = ["src/routes/health.ts", "test/health.test.ts"];
    const { calls } = scriptedSynthesize([anAgentSpec({ owns })]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "code" })], 0);

    const [task] = store.state().tasks;
    assert.deepEqual((task as unknown as { owns: string[] }).owns, owns);
  });

  // The bug this closes: `owns` was hardcoded `[]`, and an empty glob set matches
  // nothing. `readyTasks` skipped the overlap check (no declaration, no conflict) and
  // then `detectEscape` counted every changed file as an escape — so two code tasks
  // could edit the same file unnoticed, and any code task that wrote anything failed
  // without retry.
  test("re-asks once when a code agent declares no lease", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ owns: [] }),
      anAgentSpec({ owns: ["src/a.ts"] }),
    ]);

    const added = await synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "code" })], 0);

    assert.equal(added, 1);
    assert.match(seen[1]!.rejected ?? "", /owns/);
  });

  test("fails the task rather than dispatching a code worker with no lease", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ owns: [] }), anAgentSpec({ owns: [] })]);

    await assert.rejects(
      () => synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "code" })], 0),
      (error: Error) => {
        assert.ok(error instanceof UndeclaredLeaseError);
        assert.match(error.message, /Split the task/);
        return true;
      },
    );
  });

  // Git is a property of one worker kind and so is the lease it needs (§4). A
  // researcher that writes no files has nothing to declare, and demanding one would
  // fail every non-code task in the system.
  test("asks nothing of a task that is not code work", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ worker: "research", owns: [] })]);

    const added = await synthesizeTasks(
      deps(store, calls),
      [aPlannedTask({ worker: "research" })],
      0,
    );

    assert.equal(added, 1);
    assert.equal((store.state().tasks[0] as unknown as { owns?: string[] }).owns, undefined);
  });
});

describe("what the callers catch", () => {
  // All three park the mission instead of killing the process, so all three have to be
  // recognisable by one `instanceof` at the two call sites (`grantSignoff`, `replan`).
  test("every synthesis failure is a SynthesisError", async () => {
    const store = testStore([missionCreated()]);

    for (const specs of [
      [anAgentSpec({ transport: { id: "acp" } }), anAgentSpec({ transport: { id: "acp" } })],
      [anAgentSpec({ owns: [] }), anAgentSpec({ owns: [] })],
      [anAgentSpec({ tools: ["Nope"] }), anAgentSpec({ tools: ["Nope"] })],
    ]) {
      const { calls } = scriptedSynthesize(specs);
      await assert.rejects(
        () => synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "code" })], 0),
        (error: Error) => error instanceof SynthesisError,
      );
    }
  });
});

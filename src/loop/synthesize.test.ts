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
  aCodeTask,
  anAgentSpec,
  anEnvelope,
  aPlannedTask,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { type Calls } from "./calls.js";
import { type MissionStore } from "./run.js";
import {
  ArtifactEscapeError,
  ArtifactToolError,
  EnvelopeViolationError,
  SynthesisError,
  synthesizeTasks,
  UnavailableContainmentError,
  UnavailableModelError,
  UnavailableTargetError,
  UnavailableTransportError,
  UndeclaredLeaseError,
  UnknownRoleError,
} from "./synthesize.js";
import { type OfferedRole } from "../agents/offer.js";

/** Long enough that a body leaking into the index would be unmistakable in the
 *  assertion that it does not. */
const ROLE_BODY = "You reconcile invoices against ledger entries, line by line.";

const aRole = (patch: Partial<OfferedRole> = {}): OfferedRole => ({
  name: "invoice-reconciler",
  description: "Reconciles invoices against ledger entries.",
  worker: "code",
  suggests: ["fs.read"],
  body: ROLE_BODY,
  ...patch,
});

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

    assert.deepEqual(seen[0]!.transports, ["cli", "acp"]);
  });

  // The roster (§7, amended). Offering it is the whole of the saving; what makes it
  // safe is the two tests after — the returned spec is validated identically, and a
  // name that resolves to nothing is refused rather than degraded.
  test("offers the roster as rendered lines, never as role objects", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks({ ...deps(store, calls), roles: [aRole()] }, [aPlannedTask()], 0);

    // A string, because `describe()` JSON-dumps the input into the prompt and a list of
    // roles would carry every body with it — which is the entire cost this avoids.
    assert.equal(typeof seen[0]!.roster, "string");
    assert.match(seen[0]!.roster ?? "", /invoice-reconciler/);
    assert.ok(!(seen[0]!.roster ?? "").includes(ROLE_BODY));
  });

  // Model cards, the same seam and the same rule (PLAN-NEXT 2.4): rendered lines, never
  // objects. What they change is what synthesis is *shown* — `models` is still the
  // allowlist it is checked against, and a card id is a name at some provider's API
  // rather than one this harness is known to accept.
  test("offers verified model cards as rendered lines and never as an allowlist", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(
      {
        ...deps(store, calls),
        models: ["sonnet"],
        modelCards: [
          {
            id: "deepseek-ai/DeepSeek-V3",
            provider: "nebius",
            access: "api-key",
            tier: "worker",
            contextK: 128,
            costInPer1M: 0.13,
            costOutPer1M: 0.4,
            verifiedBy: "probes/v3.json",
          },
        ],
      },
      [aPlannedTask()],
      0,
    );

    assert.equal(typeof seen[0]!.modelCards, "string");
    assert.match(seen[0]!.modelCards ?? "", /deepseek-ai\/DeepSeek-V3 \(worker, 128k context/);
    // The door is unmoved: a card is a reference beside the allowlist, not an entry in it.
    assert.deepEqual(seen[0]!.models, ["sonnet"]);
  });

  test("omits the card menu when no provider has been probed", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal(seen[0]!.modelCards, undefined);
  });

  test("omits the roster entirely when there is none, rather than sending an empty list", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal("roster" in seen[0]!, false);
  });

  // The composition, and the reason it happens before the event is emitted: what the
  // log carries has to be a complete prompt, or a mission stops being readable from
  // its own log.
  test("a named role's body becomes the system prompt, with the addendum after it", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ basedOn: "invoice-reconciler", systemPrompt: "Only touch March." }),
    ]);

    await synthesizeTasks({ ...deps(store, calls), roles: [aRole()] }, [aPlannedTask()], 0);

    const planned = store.inputs.at(-1) as { task: { agentSpec: { systemPrompt: string } } };
    const prompt = planned.task.agentSpec.systemPrompt;
    assert.ok(prompt.includes(ROLE_BODY));
    assert.ok(prompt.indexOf(ROLE_BODY) < prompt.indexOf("Only touch March."));
  });

  test("a spec that named no role is emitted with its own prompt untouched", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ systemPrompt: "Written from scratch." })]);

    await synthesizeTasks({ ...deps(store, calls), roles: [aRole()] }, [aPlannedTask()], 0);

    const planned = store.inputs.at(-1) as { task: { agentSpec: { systemPrompt: string } } };
    assert.equal(planned.task.agentSpec.systemPrompt, "Written from scratch.");
  });

  // The failure this refuses is quiet: the model writes a one-paragraph addendum
  // *because* it expects a body to be attached, so passing an unresolvable name
  // through ships that paragraph as the worker's entire instructions and nothing
  // fails until the work comes back wrong.
  test("a basedOn naming nothing is re-asked with the list of real names", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ basedOn: "invoice-reconcilor", systemPrompt: "Only March." }),
      anAgentSpec({ basedOn: "invoice-reconciler", systemPrompt: "Only March." }),
    ]);

    await synthesizeTasks({ ...deps(store, calls), roles: [aRole()] }, [aPlannedTask()], 0);

    assert.match(seen[1]!.rejected ?? "", /invoice-reconciler/);
    assert.match(seen[1]!.rejected ?? "", /not a role in the roster/);
  });

  test("a basedOn that is still unknown after the retry parks the task", async () => {
    const store = testStore([missionCreated()]);
    const bogus = anAgentSpec({ basedOn: "nope", systemPrompt: "Only March." });
    const { calls } = scriptedSynthesize([bogus, bogus]);

    await assert.rejects(
      synthesizeTasks({ ...deps(store, calls), roles: [aRole()] }, [aPlannedTask()], 0),
      UnknownRoleError,
    );
  });

  // A role is a hint and never a mandate: a spec that came back naming one still meets
  // every ceiling, or the roster becomes a way to launder a capability past the
  // envelope.
  test("naming a role does not exempt the spec from validation", async () => {
    const store = testStore([missionCreated({ envelope: anEnvelope({ toolClasses: ["fs.read"] }) })]);
    const outsized = anAgentSpec({
      basedOn: "invoice-reconciler",
      worker: "research",
      tools: ["Bash"],
      owns: undefined,
    });
    const { calls } = scriptedSynthesize([outsized, outsized]);

    await assert.rejects(
      synthesizeTasks(
        { ...deps(store, calls), roles: [aRole()] },
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
      anAgentSpec({ transport: { id: "chrome-mcp" } }),
    ]);

    await assert.rejects(
      () => synthesizeTasks(deps(store, calls), [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof UnavailableTransportError);
        assert.match(error.message, /chrome-mcp/);
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

  // Defect 42's half of the ceiling. The leak shape it refuses is specific: the
  // variable is sitting in `process.env` right now, the spec asked for it by name, and
  // before this check there was nothing between the two.
  test("re-asks once when a spec names a variable the envelope does not grant", async () => {
    const store = testStore([missionCreated({ envelope: anEnvelope({ env: ["XERO_TOKEN"] }) })]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ env: ["XERO_TOKEN", "AWS_SECRET_ACCESS_KEY"] }),
      anAgentSpec({ env: ["XERO_TOKEN"] }),
    ]);

    const added = await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.equal(added, 1);
    assert.equal(seen.length, 2);
    assert.match(seen[1]!.rejected ?? "", /AWS_SECRET_ACCESS_KEY/);
    // What *is* granted, so the retry can be answered rather than only refused.
    assert.match(seen[1]!.rejected ?? "", /XERO_TOKEN/);
  });

  test("accepts a spec that names only variables the envelope granted", async () => {
    const store = testStore([missionCreated({ envelope: anEnvelope({ env: ["XERO_TOKEN"] }) })]);
    const { calls } = scriptedSynthesize([anAgentSpec({ env: ["XERO_TOKEN"] })]);

    assert.equal(await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0), 1);
  });

  // The common case: no envelope names a variable, so every spec that asks for one is
  // refused, and the retry says the list is empty rather than implying a near-miss.
  test("an envelope granting no variables refuses a spec that names one", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ env: ["DATABASE_URL"] }),
      anAgentSpec({ env: [] }),
    ]);

    await synthesizeTasks(deps(store, calls), [aPlannedTask()], 0);

    assert.match(seen[1]!.rejected ?? "", /grants no environment variables/);
  });

  // Same door as an out-of-envelope tool: widening is a human decision either way, so
  // it parks with a question rather than going back to the planner.
  test("a variable outside the envelope reaches the human like any other capability", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ env: ["DATABASE_URL"] }),
      anAgentSpec({ env: ["DATABASE_URL"] }),
    ]);

    await assert.rejects(
      () => synthesizeTasks(deps(store, calls), [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof EnvelopeViolationError);
        assert.match(error.message, /DATABASE_URL/);
        return true;
      },
    );

    assert.ok(store.inputs.find((event) => event.type === "envelope_violation"));
    const asked = store.inputs.find((event) => event.type === "question_asked");
    assert.ok(asked);
    assert.match((asked as { question: string }).question, /DATABASE_URL/);
  });

  // A transport or a lease problem is the planner's to fix, so neither one belongs in
  // an inbox nobody can act on.
  test("does not ask the human about a transport it can replan around", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "chrome-mcp" } }),
      anAgentSpec({ transport: { id: "chrome-mcp" } }),
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

// P2, and the 41-vs-27 collision resolved: a judge rubric may oblige an artifact, and
// a worker with no worktree may not write into the checkout — so it has exactly one
// legal place to write, and the spec names only what goes inside it.
describe("the declared output path", () => {
  test("a relative path inside the task's directory is accepted", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ worker: "research", outputPath: "findings/report.md" }),
    ]);

    const added = await synthesizeTasks(
      deps(store, calls),
      [aPlannedTask({ worker: "research" })],
      0,
    );

    assert.equal(added, 1);
    assert.equal(store.state().tasks[0]?.agentSpec.outputPath, "findings/report.md");
  });

  // The common case. Absent means the directory itself, which is what most tasks want.
  test("declaring nothing is legal", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ worker: "research" })]);

    assert.equal(
      await synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "research" })], 0),
      1,
    );
  });

  test("re-asks once when the spec names somewhere else", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ worker: "research", outputPath: "/tmp/report.md" }),
      anAgentSpec({ worker: "research", outputPath: "report.md" }),
    ]);

    const added = await synthesizeTasks(
      deps(store, calls),
      [aPlannedTask({ worker: "research" })],
      0,
    );

    assert.equal(added, 1);
    assert.match(seen[1]!.rejected ?? "", /relative to the artifact directory/);
  });

  // Adversarial, and the same door as an undeclared lease: no code path widens the
  // directory, so a spec that insists goes back to the planner.
  test("refuses a spec that insists on writing outside the directory", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ worker: "research", outputPath: "../../etc/passwd" }),
      anAgentSpec({ worker: "research", outputPath: "../../etc/passwd" }),
    ]);

    await assert.rejects(
      () => synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "research" })], 0),
      (error: Error) => {
        assert.ok(error instanceof ArtifactEscapeError);
        assert.ok(error instanceof SynthesisError, "the callers catch the base and park");
        assert.match(error.message, /artifact directory/);
        return true;
      },
    );
  });

  // A code task writes into its worktree and merges; the artifact directory is for
  // work that has no worktree. Nothing here demands a declaration from one.
  test("a code task is not required to declare an output path", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ owns: ["src/a.ts"] })]);

    assert.equal(
      await synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "code" })], 0),
      1,
    );
  });
});

describe("what the callers catch", () => {
  // All three park the mission instead of killing the process, so all three have to be
  // recognisable by one `instanceof` at the two call sites (`grantSignoff`, `replan`).
  // Defect 27: the judge grades files on disk, so a judge-verified agent must hold a
  // tool that can write one. Found on a correctly-answered recon task whose
  // least-privilege Read/Glob/Grep toolset left the judge an empty artifact list.
  describe("the judged-artifact rule", () => {
    const judged = (tools: string[]) =>
      anAgentSpec({
        worker: "research",
        tools,
        owns: undefined,
        verify: { kind: "judge", rubric: "the report file names all three exports" },
      });

    test("re-asks a judge-verified spec that cannot write its artifact, then accepts Write", async () => {
      const store = testStore([missionCreated()]);
      const { calls, seen } = scriptedSynthesize([
        judged(["Read", "Glob", "Grep"]),
        judged(["Read", "Glob", "Grep", "Write"]),
      ]);

      const added = await synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "research" })], 0);

      assert.equal(added, 1);
      assert.match(seen[1]!.rejected ?? "", /judge grades files on disk/);
    });

    test("fails the task when the second spec still cannot write", async () => {
      const store = testStore([missionCreated()]);
      const { calls } = scriptedSynthesize([judged(["Read"]), judged(["Read"])]);

      await assert.rejects(
        synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "research" })], 0),
        ArtifactToolError,
      );
    });

    test("a command-verified spec owes no writing tool", async () => {
      const store = testStore([missionCreated()]);
      const spec = anAgentSpec({
        worker: "research",
        tools: ["Read"],
        owns: undefined,
        verify: { kind: "command", command: "npm test" },
      });
      const { calls } = scriptedSynthesize([spec]);

      assert.equal(await synthesizeTasks(deps(store, calls), [aPlannedTask({ worker: "research" })], 0), 1);
    });
  });

  // Defect 26: a replan that reuses a task id must reach the task record, or the
  // scheduler keeps reading the old edges and the dependents of a failed task wait
  // forever. The loop-level repro lives in run.test.ts; these pin the emitter rules.
  describe("redefining an existing task", () => {
    const board = (): EventInput[] => [
      missionCreated(),
      { missionId: "m1", actor: "orchestrator", type: "task_planned", task: aCodeTask({ id: "recon", satisfies: [] }) },
      {
        missionId: "m1",
        actor: "orchestrator",
        type: "task_planned",
        task: aCodeTask({ id: "write", owns: ["src/x.ts"], branch: "write", dependsOn: ["recon"], status: "waiting" }),
      },
      { missionId: "m1", actor: "orchestrator", taskId: "recon", type: "task_status", from: "todo", to: "running", reason: "dispatched" },
      { missionId: "m1", actor: "orchestrator", taskId: "recon", type: "task_status", from: "running", to: "failed", reason: "left no artifact" },
    ];

    test("an edges-only change keeps the agent and costs no model call", async () => {
      const store = testStore(board());
      const { calls, seen } = scriptedSynthesize([]);

      const added = await synthesizeTasks(
        deps(store, calls),
        [aPlannedTask({ id: "write", goal: aCodeTask().goal, dependsOn: [] })],
        2,
      );

      assert.equal(added, 1);
      assert.equal(seen.length, 0);
      const task = store.state().tasks.find((t) => t.id === "write")!;
      assert.deepEqual(task.dependsOn, []);
      assert.equal(task.status, "todo");
    });

    test("a changed goal is re-staffed, and history rides along", async () => {
      const store = testStore(board());
      const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

      await synthesizeTasks(
        deps(store, calls),
        [aPlannedTask({ id: "recon", goal: "produce the report file this time" })],
        2,
      );

      assert.equal(seen.length, 1);
      const task = store.state().tasks.find((t) => t.id === "recon")!;
      assert.equal(task.goal, "produce the report file this time");
      assert.equal(task.status, "todo");
      // A failed first attempt is still an attempt; the §9.4 cap keeps reading it.
      assert.equal(task.attempts, 1);
    });

    test("an unchanged definition is left alone, and running or done work always is", async () => {
      const store = testStore([
        ...board(),
        { missionId: "m1", actor: "orchestrator", taskId: "write", type: "task_status", from: "waiting", to: "running", reason: "dispatched" },
      ]);
      const { calls } = scriptedSynthesize([]);

      const added = await synthesizeTasks(
        deps(store, calls),
        [
          // recon redefined the same way it already reads: no event owed.
          aPlannedTask({ id: "recon", goal: aCodeTask().goal, satisfies: [] }),
          // write is running: even a changed definition may not touch it.
          aPlannedTask({ id: "write", goal: "something else entirely" }),
        ],
        2,
      );

      assert.equal(added, 0);
      assert.equal(store.inputs.some((e) => e.type === "task_replanned"), false);
    });
  });

  test("every synthesis failure is a SynthesisError", async () => {
    const store = testStore([missionCreated()]);

    for (const specs of [
      [
        anAgentSpec({ transport: { id: "chrome-mcp" } }),
        anAgentSpec({ transport: { id: "chrome-mcp" } }),
      ],
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

// The two ceilings a human sets rather than the design does (UI plan: harness and
// model on the compose card).
//
// They are checked here, beside the transport, because they fail in exactly the same
// way and the alternative is exactly as expensive. `transport.target` was named in the
// prompt as prose — "claude or codex" — so a machine holding only one of them still
// invited a spec for the other, which is defect 21 one field along: a spawn error at
// dispatch, a burned retry, a replan.
//
// `model` was worse, because it had no door at all. It is a required non-empty string
// that becomes `--model` on a real CLI, written by a model, checked by nothing — an
// invented name passed validation and reached the log. It is also where a human's
// choice is enforced: `allowedModels` collapses a pinned model to a one-entry list, so
// "run this on haiku" is a ceiling in code rather than a preference a model may
// reconsider.
describe("synthesis against what the machine and the human allow", () => {
  test("refuses an agent this machine cannot start, and re-asks once naming what it can", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "cli", target: "claude" } }),
      anAgentSpec({ transport: { id: "cli", target: "codex" } }),
    ]);

    const added = await synthesizeTasks(
      { ...deps(store, calls), targets: ["codex"] },
      [aPlannedTask()],
      0,
    );

    assert.equal(added, 1);
    assert.equal(seen.length, 2);
    assert.match(seen[1]!.rejected ?? "", /claude/);
    assert.match(seen[1]!.rejected ?? "", /codex/);
  });

  test("a target that never resolves parks the task rather than dispatching it", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "cli", target: "claude" } }),
      anAgentSpec({ transport: { id: "cli", target: "claude" } }),
    ]);

    await assert.rejects(
      () => synthesizeTasks({ ...deps(store, calls), targets: ["codex"] }, [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof UnavailableTargetError);
        assert.match(error.message, /claude/);
        // §2a rule 5: the message names the fix.
        assert.match(error.message, /codex/);
        return true;
      },
    );

    assert.equal(store.state().tasks.length, 0);
  });

  test("a spec with no target at all is refused, not defaulted", async () => {
    // Defaulting would pick an agent on the spec's behalf and look like it worked.
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ transport: { id: "cli" } }),
      anAgentSpec({ transport: { id: "cli", target: "claude" } }),
    ]);

    await synthesizeTasks({ ...deps(store, calls), targets: ["claude"] }, [aPlannedTask()], 0);

    assert.match(seen[1]!.rejected ?? "", /transport\.target/);
  });

  test("tells the model which targets and models it may pick", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([anAgentSpec()]);

    await synthesizeTasks(
      { ...deps(store, calls), targets: ["claude"], models: ["haiku", "sonnet"] },
      [aPlannedTask()],
      0,
    );

    assert.deepEqual(seen[0]!.targets, ["claude"]);
    assert.deepEqual(seen[0]!.models, ["haiku", "sonnet"]);
  });

  test("refuses a model outside the allowlist and re-asks once, quoting it", async () => {
    const store = testStore([missionCreated()]);
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ model: "gpt-9-turbo" }),
      anAgentSpec({ model: "haiku" }),
    ]);

    const added = await synthesizeTasks(
      { ...deps(store, calls), models: ["haiku"] },
      [aPlannedTask()],
      0,
    );

    assert.equal(added, 1);
    assert.match(seen[1]!.rejected ?? "", /gpt-9-turbo/);
    assert.match(seen[1]!.rejected ?? "", /haiku/);
    // A pinned model is a person's decision, and the retry has to say so — otherwise
    // the obvious reading is "here is a suggestion I may improve on".
    assert.match(seen[1]!.rejected ?? "", /composed this mission/);
  });

  test("a model the human pinned is enforced, not negotiated", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([
      anAgentSpec({ model: "opus" }),
      anAgentSpec({ model: "opus" }),
    ]);

    await assert.rejects(
      () => synthesizeTasks({ ...deps(store, calls), models: ["haiku"] }, [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof UnavailableModelError);
        assert.match(error.message, /opus/);
        assert.match(error.message, /haiku/);
        return true;
      },
    );

    assert.equal(store.state().tasks.length, 0);
  });

  // Empty means "nothing is known", never "nothing is allowed". No list of codex
  // models has been verified, and refusing every one of them to enforce the Anthropic
  // half would fail correct work — the same rule that keeps absent token usage absent
  // instead of zero (§9.5).
  test("an empty model list constrains nothing", async () => {
    const store = testStore([missionCreated()]);
    const { calls } = scriptedSynthesize([anAgentSpec({ model: "some-model-we-know-nothing-of" })]);

    const added = await synthesizeTasks({ ...deps(store, calls), models: [] }, [aPlannedTask()], 0);

    assert.equal(added, 1);
  });
});

// PLAN-NEXT 3.2 and 3.3. Two refusals that look alike and are not: one is a spec asking
// to be let out of the mission's sandbox, which a re-ask can fix and a human decides;
// the other is a machine that cannot provide the sandbox at all, which nothing a model
// says can fix. Both fail here rather than at dispatch, where every task would spawn a
// backend that is not running — defect 21's shape one layer down.
describe("containment", () => {
  const contained = () =>
    testStore([missionCreated({ envelope: anEnvelope({ containment: "container" }) })]);
  const withBackend = (calls: Pick<Calls, "synthesize">, store: MissionStore) => ({
    store,
    calls,
    containment: ["docker"],
  });

  test("re-asks once when a spec asks to run outside the mission's container", async () => {
    const store = contained();
    const { calls, seen } = scriptedSynthesize([
      anAgentSpec({ containment: "none" }),
      anAgentSpec({}),
    ]);

    const added = await synthesizeTasks(withBackend(calls, store), [aPlannedTask()], 0);

    assert.equal(added, 1);
    assert.equal(seen.length, 2);
    assert.match(seen[1]!.rejected ?? "", /outside one/);
  });

  test("a spec that says nothing inherits the mission's containment", async () => {
    const { calls } = scriptedSynthesize([anAgentSpec({})]);

    assert.equal(await synthesizeTasks(withBackend(calls, contained()), [aPlannedTask()], 0), 1);
  });

  test("asking twice to be let out parks on a human, like any other capability", async () => {
    const { calls } = scriptedSynthesize([
      anAgentSpec({ containment: "none" }),
      anAgentSpec({ containment: "none" }),
    ]);

    await assert.rejects(
      () => synthesizeTasks(withBackend(calls, contained()), [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof EnvelopeViolationError);
        return true;
      },
    );
  });

  // Not a re-ask: the model cannot install Docker, so spending a call to be told the
  // same thing twice is the one thing this must not do.
  test("a machine with no backend refuses before the first staffing call", async () => {
    const { calls, seen } = scriptedSynthesize([anAgentSpec({})]);

    await assert.rejects(
      () => synthesizeTasks(deps(contained(), calls), [aPlannedTask()], 0),
      (error: Error) => {
        assert.ok(error instanceof UnavailableContainmentError);
        assert.match(error.message, /ORCHESTRA_CONTAINER_IMAGE/);
        return true;
      },
    );
    assert.equal(seen.length, 0);
  });

  test("a mission that asked for no container is not held to a backend it never needed", async () => {
    const { calls } = scriptedSynthesize([anAgentSpec({})]);

    assert.equal(await synthesizeTasks(deps(testStore([missionCreated()]), calls), [aPlannedTask()], 0), 1);
  });
});

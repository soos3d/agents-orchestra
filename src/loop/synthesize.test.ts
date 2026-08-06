// The failure mode under test: synthesis naming a transport that does not exist.
//
// Found by running a non-coding mission against a real model. `synthesize` chose
// `agent-sdk` for every research/general task — a perfectly reasonable reading of
// §7's registry table, which lists five transports — and Phase 2 ships one. Each
// task then died at *dispatch* with a transport error, burned its one typed retry,
// took the replan with it, and the mission escalated at the reset cap having
// produced nothing. Seven rounds to discover a fact known before the first dispatch.
//
// §7 already says which side that decision belongs on: "Synthesis reads this from
// the registry; it is not left to the planner's judgment." The registry was simply
// never passed in. So these assert the same shape the envelope gets — the ceiling is
// an input, and a spec outside it fails at validation rather than at runtime.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { anAgentSpec, aPlannedTask, missionCreated, stamp } from "../testing/fixtures.js";
import { type Calls } from "./calls.js";
import { type MissionStore } from "./run.js";
import { synthesizeTasks, UnavailableTransportError } from "./synthesize.js";

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

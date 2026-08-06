// Everything before the first worker runs, and the gate that matters most: an
// outcome spec the runtime cannot evaluate is rejected here rather than discovered
// twenty rounds later, when every internal check has been reporting success.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import {
  aCriterion,
  aPlannedTask,
  anAgentSpec,
  aProgressLedger,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { type Calls, type PlanResult, type ResearchResult } from "./calls.js";
import { prepareMission } from "./prepare.js";
import { type MissionStore } from "./run.js";

function testStore(seed: readonly EventInput[] = [missionCreated()]) {
  const inputs = [...seed];
  const store: MissionStore & { inputs: EventInput[] } = {
    inputs,
    emit: (event) => {
      inputs.push(event);
    },
    state: () => fold(stamp(inputs)),
  };
  return store;
}

const aResearchResult = (patch: Partial<ResearchResult> = {}): ResearchResult => ({
  brief: "The repo has a router but no health route.",
  findings: [
    { claim: "Routes live in src/routes", source: "src/routes/index.ts", sourceKind: "codebase", confidence: "high" },
  ],
  confidence: "high",
  criteria: [aCriterion()],
  guesses: [],
  outOfScope: ["rewriting the router"],
  ...patch,
});

function callsFor(options: {
  research?: ResearchResult[];
  plan?: PlanResult[];
}): Calls & { synthesized: number } {
  let researchIndex = 0;
  let planIndex = 0;
  const counters = { synthesized: 0 };

  return {
    get synthesized() {
      return counters.synthesized;
    },
    research: async () => {
      const answer = options.research?.[researchIndex++] ?? aResearchResult();
      return answer;
    },
    plan: async () => {
      const answer = options.plan?.[planIndex++] ?? { tasks: [aPlannedTask()] };
      return answer;
    },
    synthesize: async () => {
      counters.synthesized++;
      return anAgentSpec();
    },
    progress: async () => aProgressLedger(),
    judge: async () => {
      throw new Error("prepare does not judge");
    },
  };
}

const types = (store: { inputs: EventInput[] }) => store.inputs.map((event) => event.type);

describe("prepareMission", () => {
  test("researches, writes the spec, plans, and estimates", async () => {
    const store = testStore();

    const result = await prepareMission({ store, calls: callsFor({}) });

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.estimate.taskCount === 1);
    assert.ok(result.ok && result.estimate.wallMs > 0);
    assert.deepEqual(types(store).slice(0, 4), [
      "mission_created",
      "mission_status",
      "research_completed",
      "mission_status",
    ]);
    assert.ok(types(store).includes("outcome_spec_written"));
  });

  test("puts sourced findings into the ledger as verified facts", async () => {
    const store = testStore();

    await prepareMission({ store, calls: callsFor({}) });

    const facts = store.state().mission.ledger.factsVerified;
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.source.ref, "src/routes/index.ts");
    assert.equal(facts[0]?.source.kind, "research");
  });

  test("reaches executing with a synthesized agent per task", async () => {
    const store = testStore();
    const calls = callsFor({ plan: [{ tasks: [aPlannedTask({ id: "t1" }), aPlannedTask({ id: "t2" })] }] });

    await prepareMission({ store, calls });

    assert.equal(calls.synthesized, 2);
    assert.equal(store.state().mission.status, "executing");
    assert.equal(store.state().tasks.length, 2);
  });

  // Criteria freeze from sign-off, so it has to be granted before any work runs.
  test("records sign-off, which is what freezes the criteria", async () => {
    const store = testStore();

    await prepareMission({ store, calls: callsFor({}) });

    assert.ok(store.state().mission.signedOffAt);
  });

  describe("the outcome spec gate", () => {
    test("rejects an uncheckable criterion and retries research once", async () => {
      const store = testStore();
      const vague = aResearchResult({
        criteria: [{ id: "c1", statement: "the checkout flow is less janky" }],
      });

      const result = await prepareMission({
        store,
        calls: callsFor({ research: [vague, aResearchResult()] }),
      });

      assert.equal(result.ok, true);
      assert.ok(types(store).includes("outcome_spec_rejected"));
    });

    test("gives up after the second rejection rather than planning against nothing", async () => {
      const store = testStore();
      const vague = aResearchResult({ criteria: [{ id: "c1", statement: "make it nicer" }] });

      const result = await prepareMission({
        store,
        calls: callsFor({ research: [vague, vague] }),
      });

      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.rejected?.length === 1);
      assert.ok(!result.ok && /could never legitimately report success/.test(result.reason));
      assert.equal(types(store).includes("outcome_spec_written"), false);
    });
  });

  describe("plan validation", () => {
    test("retries once, quoting the offending edge", async () => {
      const store = testStore();
      const calls = callsFor({
        plan: [
          { tasks: [aPlannedTask({ id: "t1", dependsOn: ["t9"] })] },
          { tasks: [aPlannedTask({ id: "t1" })] },
        ],
      });

      const result = await prepareMission({ store, calls });

      assert.equal(result.ok, true);
      assert.equal(calls.synthesized, 1);
    });

    test("stops before synthesizing anything when the plan cycles", async () => {
      const store = testStore();
      const cyclic: PlanResult = {
        tasks: [
          aPlannedTask({ id: "t1", dependsOn: ["t2"] }),
          aPlannedTask({ id: "t2", dependsOn: ["t1"] }),
        ],
      };
      const calls = callsFor({ plan: [cyclic, cyclic] });

      const result = await prepareMission({ store, calls });

      assert.equal(result.ok, false);
      assert.ok(!result.ok && /cycle/.test(result.reason));
      assert.equal(calls.synthesized, 0);
    });
  });

  describe("--plan-only", () => {
    test("produces a spec, a plan, and an estimate without synthesizing an agent", async () => {
      const store = testStore();
      const calls = callsFor({});

      const result = await prepareMission({ store, calls, planOnly: true });

      assert.equal(result.ok, true);
      assert.ok(result.ok && result.plan.length === 1);
      assert.equal(calls.synthesized, 0);
      assert.equal(store.state().tasks.length, 0);
    });

    test("stops at the sign-off request, so nothing is approved and nothing runs", async () => {
      const store = testStore();

      await prepareMission({ store, calls: callsFor({}), planOnly: true });

      assert.ok(types(store).includes("signoff_requested"));
      assert.equal(types(store).includes("signoff_granted"), false);
      assert.equal(store.state().mission.status, "specifying");
    });
  });
});

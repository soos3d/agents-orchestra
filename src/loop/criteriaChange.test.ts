// The failure mode under test: defect 29, a parked mission with no door in.
//
// A replan proposed amending a signed-off criterion. The freeze worked — the change
// was refused, `criteria_change_requested` was emitted, and the mission returned to
// `awaiting_signoff` (§3). And then nothing on any surface could answer it: the CLI
// printed "needs the sign-off screen (Phase 3b)" and exited 1, on `run` and on
// `resume` alike, with a dashboard attached and never consulted.
//
// So these assert the door: the diff reaches a human through the same port sign-off
// uses, approving applies it, rejecting records the dead end §3 asks for, and neither
// answer can be produced by nobody being there.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import {
  aCriterion,
  aPlannedTask,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { resolveCriteriaChange } from "./criteriaChange.js";
import { type HumanPort, type SignoffDecision, type SignoffPresentation } from "./human.js";
import { type MissionStore } from "./run.js";

const orchestrator = { missionId: "m1", actor: "orchestrator" as const };

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

const amended = aCriterion({ id: "c1", statement: "GET /health returns 200 and a build sha" });

/** A mission that signed off, ran, and had a replan ask to edit the contract. */
const reopened = (): EventInput[] => [
  missionCreated(),
  {
    ...orchestrator,
    type: "outcome_spec_written",
    criteria: [aCriterion({ id: "c1" })],
    guesses: [],
    outOfScope: [],
    estimate: { taskCount: 1, wallMs: 60_000, expectedGates: 0 },
  },
  {
    ...orchestrator,
    type: "ledger_revised",
    reason: "spec",
    ledger: {
      factsGiven: [],
      factsVerified: [],
      factsToLookUp: [],
      factsToDerive: [],
      guesses: [],
      deadEnds: [],
      criteria: [aCriterion({ id: "c1" })],
      plan: [aPlannedTask()],
    },
  },
  { ...orchestrator, type: "signoff_granted", unattended: false },
  { ...orchestrator, type: "mission_status", from: "awaiting_signoff", to: "executing", reason: "approved" },
  {
    ...orchestrator,
    type: "criteria_change_requested",
    diff: [
      {
        op: "amend",
        criterionId: "c1",
        from: aCriterion({ id: "c1" }),
        to: amended,
        reason: "the deploy check reads the sha, and no plan can meet c1 without it",
      },
    ],
    reasoning: "c1 as written cannot be satisfied",
  },
  {
    ...orchestrator,
    type: "mission_status",
    from: "executing",
    to: "awaiting_signoff",
    reason: "the replan proposed changing a signed-off criterion",
  },
];

function human(decide: (p: SignoffPresentation) => SignoffDecision | Promise<SignoffDecision>) {
  const shown: SignoffPresentation[] = [];
  const port: HumanPort = {
    askIntake: async () => {
      throw new Error("intake is not reopened by a criteria change");
    },
    awaitSignoff: async (presentation) => {
      shown.push(presentation);
      return decide(presentation);
    },
  };
  return { port, shown };
}

describe("resolveCriteriaChange", () => {
  test("shows the human the diff and the reasoning from the log alone", async () => {
    const store = testStore(reopened());
    const h = human(() => ({ kind: "approve" }));

    await resolveCriteriaChange({ store, human: h.port });

    const shown = h.shown[0]!;
    assert.equal(shown.proposedChange?.reasoning, "c1 as written cannot be satisfied");
    assert.equal(shown.proposedChange?.diff[0]?.op, "amend");
    // The rest of the screen is the context for the decision, so it is the same
    // presentation the initial sign-off builds.
    assert.equal(shown.criteria[0]?.statement, aCriterion().statement);
    assert.equal(shown.plan.length, 1);
  });

  test("approving applies the diff and returns the mission to executing", async () => {
    const store = testStore(reopened());
    const h = human(() => ({ kind: "approve" }));

    const outcome = await resolveCriteriaChange({ store, human: h.port });

    assert.deepEqual(outcome, { ok: true, approved: true });
    const state = store.state();
    assert.equal(state.mission.ledger.criteria[0]?.statement, amended.statement);
    assert.equal(state.mission.status, "executing");
    const resolved = store.inputs.find((e) => e.type === "criteria_change_resolved");
    assert.ok(resolved && "approved" in resolved && resolved.approved === true);
  });

  // §3: a rejection is recorded as a dead end, so the next replan does not walk back
  // into proposing the same change.
  test("rejecting keeps the original criteria and records the refusal as a dead end", async () => {
    const store = testStore(reopened());
    const h = human(() => ({ kind: "revise", feedback: "c1 stands; the sha is a separate mission" }));

    const outcome = await resolveCriteriaChange({ store, human: h.port });

    assert.deepEqual(outcome, { ok: true, approved: false });
    const state = store.state();
    assert.equal(state.mission.ledger.criteria[0]?.statement, aCriterion().statement);
    assert.equal(state.mission.status, "executing");

    const deadEnd = state.mission.ledger.deadEnds[0];
    assert.ok(deadEnd, "the rejection was not recorded as a dead end");
    assert.match(deadEnd.evidence, /c1 stands/);
    assert.match(deadEnd.approach, /c1/);
    assert.equal(deadEnd.source, "human");

    const resolved = store.inputs.find((e) => e.type === "criteria_change_resolved");
    assert.ok(resolved && "approved" in resolved && resolved.approved === false);
  });

  test("a second rejection does not reuse the first dead end's id", async () => {
    const store = testStore(reopened());
    await resolveCriteriaChange({
      store,
      human: human(() => ({ kind: "revise", feedback: "no" })).port,
    });

    store.emit({
      ...orchestrator,
      type: "criteria_change_requested",
      diff: [{ op: "remove", criterionId: "c1", reason: "still unreachable" }],
      reasoning: "c1 is still unreachable",
    });
    await resolveCriteriaChange({
      store,
      human: human(() => ({ kind: "revise", feedback: "still no" })).port,
    });

    const ids = store.state().mission.ledger.deadEnds.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `dead end ids collided: ${ids.join(", ")}`);
  });

  test("nothing pending is a refusal to ask, not an approval", async () => {
    const store = testStore([missionCreated()]);
    const h = human(() => ({ kind: "approve" }));

    const outcome = await resolveCriteriaChange({ store, human: h.port });

    assert.equal(outcome.ok, false);
    assert.equal(h.shown.length, 0);
    assert.equal(store.inputs.some((e) => e.type === "criteria_change_resolved"), false);
  });

  // A diff written against a ledger that has since moved. Emitting the approval would
  // record a contract change as landed while nothing changed, so it parks instead —
  // still pending, still answerable, and the message names what to do.
  test("a diff that no longer applies parks rather than recording a hollow approval", async () => {
    const store = testStore([
      ...reopened(),
      { ...orchestrator, actor: "human", type: "criteria_change_resolved", approved: true },
      {
        ...orchestrator,
        type: "criteria_change_requested",
        diff: [{ op: "remove", criterionId: "c9", reason: "gone" }],
        reasoning: "c9 should go",
      },
    ]);

    const outcome = await resolveCriteriaChange({
      store,
      human: human(() => ({ kind: "approve" })).port,
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.reason : "", /c9/);
    assert.equal(
      store.inputs.filter((e) => e.type === "criteria_change_resolved").length,
      1,
    );
    assert.ok(store.state().pendingCriteriaChange, "the change stopped being answerable");
  });

  // The ports race (§10, `anyOf`), so a surface that cannot answer must reject rather
  // than decide. A rejected port here means the mission stays parked and approvable.
  test("a port that cannot answer leaves the change pending", async () => {
    const store = testStore(reopened());
    const port: HumanPort = {
      askIntake: async () => [],
      awaitSignoff: async () => {
        throw new Error("standard input ended without an answer");
      },
    };

    const outcome = await resolveCriteriaChange({ store, human: port });

    assert.equal(outcome.ok, false);
    assert.equal(store.inputs.some((e) => e.type === "criteria_change_resolved"), false);
    assert.equal(store.state().mission.status, "awaiting_signoff");
    assert.ok(store.state().pendingCriteriaChange);
  });
});

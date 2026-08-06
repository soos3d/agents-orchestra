// Folding is where "no field changes without an event" is either true or a slogan.
// These tests cover the transitions that resume depends on, and the two ledger
// rules that stop a mission moving its own goalposts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "./fold.js";
import { LogCorruptionError } from "./log.js";
import { emptyLedger } from "../domain/ledger.js";
import { zeroSpend } from "../domain/budget.js";
import {
  aCodeTask,
  aCriterion,
  aReport,
  anEnvelope,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { type EventInput } from "./schema.js";

const orchestrator = { missionId: "m1", actor: "orchestrator" } as const;

const spend = (wallMs: number, measured = 0) => ({
  ...zeroSpend(),
  wallMs,
  tokens: { measured, estimated: 0, unmeasured: 0 },
  dispatches: 1,
});

const signedOff = (criteria = [aCriterion()]): EventInput[] => [
  missionCreated(),
  {
    ...orchestrator,
    type: "outcome_spec_written",
    criteria,
    guesses: [],
    outOfScope: [],
    estimate: { taskCount: 1, tokens: 0, wallMs: 1000, expectedGates: 0 },
  },
  { ...orchestrator, type: "signoff_granted", unattended: false },
];

const foldOf = (inputs: EventInput[]) => fold(stamp(inputs));

describe("fold", () => {
  test("seeds the mission from mission_created", () => {
    const state = foldOf([missionCreated()]);

    assert.equal(state.mission.id, "m1");
    assert.equal(state.mission.status, "scanning");
    assert.equal(state.mission.round, 0);
    assert.deepEqual(state.mission.capabilityEnvelope, anEnvelope());
  });

  test("an empty log raises rather than producing an empty mission", () => {
    assert.throws(() => fold([]), LogCorruptionError);
  });

  test("a log that does not open with mission_created raises", () => {
    assert.throws(
      () => foldOf([{ ...orchestrator, type: "round_started", round: 1 } as EventInput]),
      /always opens with mission_created/,
    );
  });

  test("does not mutate the events it folds", () => {
    const events = stamp([missionCreated(), { ...orchestrator, type: "task_planned", task: aCodeTask() }]);
    const snapshot = JSON.stringify(events);

    fold(events);

    assert.equal(JSON.stringify(events), snapshot);
  });

  describe("tasks", () => {
    test("records a planned task and its status transitions with timings", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        { ...orchestrator, taskId: "t1", type: "task_status", from: "todo", to: "running", reason: "dispatched" },
        { ...orchestrator, taskId: "t1", type: "task_status", from: "running", to: "done", reason: "verified" },
      ]);

      const task = state.tasks[0];
      assert.equal(task.status, "done");
      assert.ok(task.startedAt);
      assert.ok(task.endedAt);
      assert.ok(task.endedAt! > task.startedAt!);
    });

    // There is no `task_dispatched` event: the move into `running` is the dispatch.
    // Without counting it here, `attempts` stays where task_planned left it and the
    // §9.4 transport retry cap never binds.
    test("counts a dispatch as an attempt", () => {
      const dispatched = (from: string, to: string) => ({
        ...orchestrator,
        taskId: "t1",
        type: "task_status" as const,
        from,
        to,
        reason: "r",
      });

      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        dispatched("todo", "running"),
        dispatched("running", "failed"),
        dispatched("failed", "todo"),
        dispatched("todo", "running"),
      ] as EventInput[]);

      assert.equal(state.tasks[0].attempts, 2);
    });

    test("a status event for an unknown task is corruption", () => {
      assert.throws(
        () =>
          foldOf([
            missionCreated(),
            { ...orchestrator, taskId: "ghost", type: "task_status", from: "todo", to: "running", reason: "?" },
          ]),
        /unknown task 'ghost'/,
      );
    });

    test("collects artifacts onto the task that produced them", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        {
          ...orchestrator,
          taskId: "t1",
          type: "artifact_written",
          artifact: { kind: "report", id: "a1", text: "done" },
        },
      ]);

      assert.equal(state.tasks[0].artifacts.length, 1);
    });

    // A lease held past completion rejects every later task touching the same files.
    test("releases the lease when the task reaches a terminal status", () => {
      const inputs: EventInput[] = [
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        { ...orchestrator, taskId: "t1", type: "lease_granted", owns: ["src/routes/health.ts"] },
      ];

      assert.deepEqual(foldOf(inputs).leases, { t1: ["src/routes/health.ts"] });
      assert.deepEqual(
        foldOf([
          ...inputs,
          { ...orchestrator, taskId: "t1", type: "task_status", from: "running", to: "done", reason: "ok" },
        ]).leases,
        {},
      );
    });

    test("keeps worker reports with the round they landed in", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        { ...orchestrator, type: "round_started", round: 3 },
        { ...orchestrator, taskId: "t1", type: "worker_report", actor: "worker", report: aReport() },
      ]);

      assert.deepEqual(state.reports.map((r) => [r.taskId, r.round]), [["t1", 3]]);
    });
  });

  describe("the ledger rules", () => {
    test("criteria may be revised freely before sign-off", () => {
      const state = foldOf([
        missionCreated(),
        {
          ...orchestrator,
          type: "ledger_revised",
          reason: "spec",
          ledger: { ...emptyLedger(), criteria: [aCriterion({ statement: "revised" })] },
        },
      ]);

      assert.equal(state.mission.ledger.criteria[0].statement, "revised");
    });

    // The failure this prevents: three unattended replans quietly rewrite the spec a
    // human approved, and every internal check then agrees the mission succeeded.
    test("a revision that changes a criterion after sign-off is refused", () => {
      assert.throws(
        () =>
          foldOf([
            ...signedOff(),
            {
              ...orchestrator,
              type: "ledger_revised",
              reason: "replan",
              ledger: { ...emptyLedger(), criteria: [aCriterion({ statement: "something easier" })] },
            },
          ]),
        /may not revise the contract/,
      );
    });

    test("a revision that keeps the criteria intact is allowed after sign-off", () => {
      const state = foldOf([
        ...signedOff(),
        {
          ...orchestrator,
          type: "ledger_revised",
          reason: "replan",
          ledger: {
            ...emptyLedger(),
            criteria: [aCriterion()],
            factsToLookUp: [{ id: "u1", text: "which export format?", addedRound: 1 }],
          },
        },
      ]);

      assert.equal(state.mission.ledger.factsToLookUp.length, 1);
    });

    test("a revision that forgets a dead end is refused", () => {
      const deadEnd = {
        id: "d1",
        text: "Ramp API has no read scope on this plan",
        addedRound: 1,
        approach: "Ramp API",
        evidence: "403 on every call",
        source: "worker" as const,
      };

      assert.throws(
        () =>
          foldOf([
            missionCreated(),
            { ...orchestrator, type: "dead_end_added", deadEnd },
            { ...orchestrator, type: "ledger_revised", reason: "replan", ledger: emptyLedger() },
          ]),
        /append-only/,
      );
    });
  });

  describe("criteria and spend", () => {
    test("a criterion check records met, evidence, and the round it ran in", () => {
      const state = foldOf([
        ...signedOff(),
        { ...orchestrator, type: "round_started", round: 4 },
        {
          ...orchestrator,
          type: "criterion_checked",
          criterionId: "c1",
          met: true,
          evidence: { artifactIds: ["a1"], checkOutput: "exit=0", reasoning: "tests pass", byTask: ["t1"] },
        },
      ]);

      const criterion = state.mission.ledger.criteria[0];
      assert.equal(criterion.met, true);
      assert.equal(criterion.lastCheckedRound, 4);
    });

    test("spend accumulates per phase and in total", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "scan_completed", findings: [], spend: spend(500, 100) },
        { ...orchestrator, type: "spend_recorded", phase: "orchestration", spend: spend(200, 900) },
        { ...orchestrator, type: "spend_recorded", phase: "orchestration", spend: spend(300, 50) },
      ]);

      assert.equal(state.mission.spend.wallMs, 1000);
      assert.equal(state.mission.spend.tokens.measured, 1050);
      assert.equal(state.mission.spendByPhase.orchestration.wallMs, 500);
      assert.equal(state.mission.spendByPhase.scan.tokens.measured, 100);
    });
  });

  describe("the inbox", () => {
    test("a question opens an item and its answer resolves it", () => {
      const asked = foldOf([
        missionCreated(),
        { ...orchestrator, taskId: "t1", type: "question_asked", questionId: "q1", question: "FX rounding?", blocks: ["t1"] },
      ]);
      assert.equal(asked.inbox[0].resolvedAt, undefined);

      const answered = foldOf([
        missionCreated(),
        { ...orchestrator, taskId: "t1", type: "question_asked", questionId: "q1", question: "FX rounding?", blocks: ["t1"] },
        { ...orchestrator, actor: "human", type: "question_answered", questionId: "q1", answer: "yes" },
      ]);
      assert.ok(answered.inbox[0].resolvedAt);
    });

    test("a denied gate is resolved and recorded as not approved", () => {
      const state = foldOf([
        missionCreated(),
        {
          ...orchestrator,
          taskId: "t1",
          type: "gate_requested",
          gateId: "g1",
          actionClass: "commit",
          description: "Submit expense £240",
          screenshotPath: ".orchestra/shots/g1.png",
        },
        { ...orchestrator, actor: "human", type: "gate_resolved", gateId: "g1", approved: false, by: "davide" },
      ]);

      assert.equal(state.inbox[0].approved, false);
    });

    // Running out of budget is a question, not a failure (§9.4).
    test("mission budget exhaustion opens an extend request that the extension closes", () => {
      const exhausted: EventInput[] = [
        missionCreated(),
        {
          ...orchestrator,
          type: "budget_exceeded",
          scope: "mission",
          limit: { wallMs: 1000 },
          actual: spend(1000),
        },
      ];

      assert.equal(foldOf(exhausted).inbox[0].kind, "budget_extension");

      const extended = foldOf([
        ...exhausted,
        {
          ...orchestrator,
          actor: "human",
          type: "budget_extended",
          added: { wallMs: 1_800_000 },
          extensions: 1,
          by: "davide",
        },
      ]);

      assert.ok(extended.inbox[0].resolvedAt);
      assert.equal(extended.mission.extensions, 1);
      assert.equal(extended.mission.budget.wallMs, anEnvelope().maxSpend.wallMs + 1_800_000);
    });
  });
});

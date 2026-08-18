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
    estimate: { taskCount: 1, wallMs: 1000, expectedGates: 0 },
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

  // PLAN-NEXT 4.1. The failure mode is a mission that runs its first half on a staffed
  // card and its second on the default model, because the choice lived in process memory
  // and `orchestra resume` folds the log — and the mirror of it, an older log gaining a
  // staffing nobody chose.
  test("carries the staffing a mission was composed with", () => {
    const state = foldOf([missionCreated({ staffing: { plan: "some/card-1" } } as Partial<EventInput>)]);

    assert.deepEqual(state.mission.staffing, { plan: "some/card-1" });
  });

  test("a log written before staffing existed folds to no staffing, not to undefined", () => {
    assert.deepEqual(foldOf([missionCreated()]).mission.staffing, {});
  });

  // PLAN-NEXT 8.2, and `staffing`'s failure mode one field along: a mission composed as
  // a moonshot and resumed the next morning would otherwise carry on as a standard one,
  // paying for the profile's first critic round and none of its second.
  test("carries the profile a mission was composed with", () => {
    const state = foldOf([missionCreated({ moonshot: true } as Partial<EventInput>)]);

    assert.equal(state.mission.moonshot, true);
  });

  test("a log written before the profile existed folds to a standard mission", () => {
    assert.equal(foldOf([missionCreated()]).mission.moonshot, false);
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

    // P1: a criterion checked `false` has to know whether anything landed since, and
    // the only durable answer is which round each contributing task finished in.
    // Same fold-derived shape as `attempts` — no new event, because `task_status`
    // already carries the transition this reads.
    test("records the round a task reached done in", () => {
      const status = (from: string, to: string) => ({
        ...orchestrator,
        taskId: "t1",
        type: "task_status" as const,
        from,
        to,
        reason: "r",
      });

      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "round_started", round: 4 },
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        status("todo", "running"),
        status("running", "done"),
      ] as EventInput[]);

      assert.equal(state.tasks[0].completedRound, 4);
    });

    // Work redone after a revert lands in a later round, and a criterion re-check
    // has to see the landing that is current rather than the one it already graded.
    test("a task that is redone records the later round", () => {
      const status = (from: string, to: string) => ({
        ...orchestrator,
        taskId: "t1",
        type: "task_status" as const,
        from,
        to,
        reason: "r",
      });

      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "round_started", round: 2 },
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        status("todo", "running"),
        status("running", "done"),
        { ...orchestrator, type: "round_started", round: 5 },
        status("done", "todo"),
        status("todo", "running"),
        status("running", "done"),
      ] as EventInput[]);

      assert.equal(state.tasks[0].completedRound, 5);
    });

    // A replan redefines a task whole (defect 26). Carrying the old completion round
    // into the new definition would tell a criterion check that work it has never
    // seen already landed.
    test("a replan drops the completion round of the task it redefines", () => {
      const status = (from: string, to: string) => ({
        ...orchestrator,
        taskId: "t1",
        type: "task_status" as const,
        from,
        to,
        reason: "r",
      });

      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "round_started", round: 3 },
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        status("todo", "running"),
        status("running", "done"),
        {
          ...orchestrator,
          type: "task_replanned",
          task: { ...aCodeTask(), goal: "narrower", status: "todo" },
          reason: "the first attempt was too broad",
        },
      ] as EventInput[]);

      assert.equal(state.tasks[0].completedRound, undefined);
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

    // Defect 41: recorded so a human can see which files a mis-staffed worker left in
    // the checkout, and inert in state because a working tree is not mission state.
    // The task's own failure arrives through task_status, as every other one does.
    test("a repo escape changes no state and replays identically", () => {
      const inputs: EventInput[] = [
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask({ worker: "review" }) },
        { ...orchestrator, taskId: "t1", type: "repo_escaped", worker: "review", touched: ["a.js"] },
      ];

      const after = foldOf(inputs);
      const before = foldOf(inputs.slice(0, 2));
      // Everything except the log's own position: `lastSeq` and `updatedAt` advance for
      // every event, which is the log recording that something happened rather than the
      // payload having an effect.
      assert.deepEqual(after.tasks, before.tasks);
      assert.deepEqual(after.leases, before.leases);
      assert.deepEqual(after.inbox, before.inbox);
      assert.deepEqual(after.mission.status, before.mission.status);
      assert.deepEqual(after, foldOf(inputs));
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

  // The one door through the freeze (§3). A replan may *ask*; only an approved
  // `criteria_change_resolved` moves the contract, and the fold is where it moves —
  // defect 29 was a mission parked at that door with nothing on the other side of it.
  describe("a criteria change", () => {
    const amend = (statement: string): EventInput => ({
      ...orchestrator,
      type: "criteria_change_requested",
      diff: [
        {
          op: "amend",
          criterionId: "c1",
          from: aCriterion(),
          to: aCriterion({ statement }),
          reason: "the endpoint returns a build sha as well",
        },
      ],
      reasoning: "the criterion as written cannot be met by any plan",
    });

    test("a request opens an inbox item and leaves the criteria alone", () => {
      const state = foldOf([...signedOff(), amend("something easier")]);

      assert.equal(state.mission.ledger.criteria[0]!.statement, aCriterion().statement);
      assert.equal(state.inbox.filter((item) => item.kind === "criteria_change").length, 1);
      assert.deepEqual(state.pendingCriteriaChange?.diff[0]?.op, "amend");
    });

    test("an approved change applies the diff and closes the item", () => {
      const state = foldOf([
        ...signedOff(),
        amend("GET /health returns 200 and a build sha"),
        { ...orchestrator, actor: "human", type: "criteria_change_resolved", approved: true },
      ]);

      assert.equal(state.mission.ledger.criteria[0]!.statement, "GET /health returns 200 and a build sha");
      assert.equal(state.pendingCriteriaChange, undefined);
      assert.equal(state.inbox[0]?.resolvedAt !== undefined, true);
    });

    // The rejection is the answer §3 asks for: the contract stands, and the loop
    // carries on being judged against what the human approved.
    test("a rejected change leaves the criteria exactly as signed off", () => {
      const state = foldOf([
        ...signedOff(),
        amend("something easier"),
        { ...orchestrator, actor: "human", type: "criteria_change_resolved", approved: false },
      ]);

      assert.equal(state.mission.ledger.criteria[0]!.statement, aCriterion().statement);
      assert.equal(state.pendingCriteriaChange, undefined);
    });

    // Replay rule 1 applied to the freeze: after an approved change the *new* criteria
    // are the frozen ones, so a later revision that restates them is legal and one
    // that quietly reverts them is not.
    test("the applied criteria are what the freeze then protects", () => {
      const approved = [
        ...signedOff(),
        amend("GET /health returns 200 and a build sha"),
        { ...orchestrator, actor: "human", type: "criteria_change_resolved", approved: true },
      ] as EventInput[];

      const legal = foldOf([
        ...approved,
        {
          ...orchestrator,
          type: "ledger_revised",
          reason: "replan",
          ledger: {
            ...emptyLedger(),
            criteria: [aCriterion({ statement: "GET /health returns 200 and a build sha" })],
          },
        },
      ]);
      assert.equal(legal.mission.ledger.criteria.length, 1);

      assert.throws(
        () =>
          foldOf([
            ...approved,
            {
              ...orchestrator,
              type: "ledger_revised",
              reason: "replan",
              ledger: { ...emptyLedger(), criteria: [aCriterion()] },
            },
          ]),
        /may not revise the contract/,
      );
    });

    // A resolution with nothing pending is a log that says a decision was taken about
    // a change nobody requested. Quietly ignoring it would let a stray event look like
    // an applied contract change.
    test("a resolution with nothing pending raises", () => {
      assert.throws(
        () =>
          foldOf([
            ...signedOff(),
            { ...orchestrator, actor: "human", type: "criteria_change_resolved", approved: true },
          ]),
        /no criteria change was pending/,
      );
    });
  });

  // §6's rule, and the reason memory is worth having at all: a fact recalled from the
  // lore store enters the ledger tier the planner trusts, a stale one enters as a
  // guess, and both survive a resume because the recall is an event rather than a
  // variable that lived for one process.
  describe("memory", () => {
    const recalled = (): EventInput => ({
      ...orchestrator,
      type: "memory_recalled",
      facts: [
        {
          id: "m1",
          text: "the API client lives in src/net",
          addedRound: 0,
          source: { kind: "memory", ref: "lore-1" },
          observedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      guesses: [
        {
          id: "mg1",
          text: "Stripe retries webhooks for 3 days",
          addedRound: 0,
          confidence: "low",
          basis: "stale research lore lore-2 — re-verify before relying on it",
        },
      ],
      consulted: 2,
    });

    test("a recalled fact lands in factsVerified and a stale one in guesses", () => {
      const state = foldOf([missionCreated(), recalled()]);

      assert.deepEqual(
        state.mission.ledger.factsVerified.map((fact) => [fact.id, fact.source.kind]),
        [["m1", "memory"]],
      );
      assert.deepEqual(
        state.mission.ledger.guesses.map((guess) => [guess.id, guess.confidence]),
        [["mg1", "low"]],
      );
    });

    test("recall appends rather than replacing what the ledger already holds", () => {
      const state = foldOf([
        missionCreated(),
        {
          ...orchestrator,
          type: "ledger_revised",
          reason: "research",
          ledger: {
            ...emptyLedger(),
            factsVerified: [
              {
                id: "f1",
                text: "routes live in src/routes",
                addedRound: 0,
                source: { kind: "research", ref: "src/routes/index.ts" },
                observedAt: "2026-07-25T10:00:00.000Z",
              },
            ],
          },
        },
        recalled(),
      ]);

      assert.deepEqual(state.mission.ledger.factsVerified.map((fact) => fact.id), ["f1", "m1"]);
    });

    // The audit trail for the write-back. Promotion writes files a human can read and
    // delete, so the log has to say which ones this mission wrote.
    test("memory_written is recorded without changing mission state", () => {
      const before = foldOf([missionCreated()]);
      const after = foldOf([
        missionCreated(),
        {
          ...orchestrator,
          type: "memory_written",
          path: "/state/lore/routes-live-in-src-routes-abc123.md",
          loreType: "observation",
        },
      ]);

      assert.deepEqual(after.mission.ledger, before.mission.ledger);
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

    // A seat is one voice. Applied, `met` would read whichever judge answered last —
    // wrong on a third of 2-1 splits — and `lastCheckedRound` would move mid-panel, so
    // `shouldCheckCriterion` would refuse to re-convene the panel that was still voting.
    test("a panel seat is recorded and never applied", () => {
      const seat = (panelSeat: number, met: boolean) => ({
        ...orchestrator,
        type: "criterion_checked" as const,
        criterionId: "c1",
        met,
        panelSeat,
        lens: "correctness",
        evidence: { artifactIds: [], checkOutput: "", reasoning: `seat ${panelSeat}`, byTask: [] },
      });

      const state = foldOf([
        ...signedOff(),
        { ...orchestrator, type: "round_started", round: 4 },
        seat(0, true),
        seat(1, true),
        seat(2, false),
      ]);

      const criterion = state.mission.ledger.criteria[0];
      assert.equal(criterion.met, undefined);
      assert.equal(criterion.lastCheckedRound, undefined);
    });

    test("the resolved verdict after the seats is what the criterion holds", () => {
      const state = foldOf([
        ...signedOff(),
        { ...orchestrator, type: "round_started", round: 4 },
        {
          ...orchestrator,
          type: "criterion_checked",
          criterionId: "c1",
          met: false,
          panelSeat: 2,
          lens: "does-it-run",
          evidence: { artifactIds: [], checkOutput: "", reasoning: "the dissent", byTask: [] },
        },
        {
          ...orchestrator,
          type: "criterion_checked",
          criterionId: "c1",
          met: true,
          evidence: { artifactIds: [], checkOutput: "", reasoning: "2 for, 1 against", byTask: [] },
        },
      ]);

      const criterion = state.mission.ledger.criteria[0];
      assert.equal(criterion.met, true);
      assert.equal(criterion.evidence?.reasoning, "2 for, 1 against");
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

  // PLAN-NEXT 5.1. The note is a file and the fold keeps where it is, because a mission
  // planned last night and dispatched this morning has to give its workers the same path
  // — and only the log survives that gap.
  describe("the design note", () => {
    test("folds the path and the planner's summary", () => {
      const state = foldOf([
        missionCreated(),
        {
          ...orchestrator,
          type: "design_written",
          path: "/tmp/mission/artifacts/design.md",
          summary: "# Design\n\nOne module.",
        },
      ]);

      assert.deepEqual(state.design, {
        path: "/tmp/mission/artifacts/design.md",
        summary: "# Design\n\nOne module.",
      });
    });

    // A quick mission has no architect, and every log written before PLAN-NEXT 5 has no
    // such event — both have to fold to a mission whose workers are told nothing.
    test("a mission that never had one folds without it", () => {
      assert.equal(foldOf([missionCreated()]).design, undefined);
    });

    // The architect's retry writes a second note, and the mission's note is the one that
    // belongs to the criteria that were accepted.
    test("a second note replaces the first", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "design_written", path: "/a/design.md", summary: "first" },
        { ...orchestrator, type: "design_written", path: "/b/design.md", summary: "second" },
      ]);

      assert.equal(state.design?.summary, "second");
    });

    // The critic's objections drive the replan inside the call that raised them, so
    // nothing downstream reads them from state — the event is for the reader and for
    // `metrics`. It must still fold without disturbing anything.
    test("a critique changes no state and breaks no replay", () => {
      const state = foldOf([
        missionCreated(),
        {
          ...orchestrator,
          type: "plan_critiqued",
          objections: [{ kind: "colliding-lease", detail: "t1 and t2 both own src/api.ts", taskId: "t2" }],
          replanned: true,
        },
      ]);

      assert.equal(state.mission.status, "scanning");
      assert.equal(state.lastSeq, 2);
    });
  });

  // PLAN-NEXT 7.1. The names are folded because the question raised beside them may be
  // answered when no loop is running, and whoever resumes has to be able to say which
  // credentials this mission is mocking without re-reading the design note.
  describe("secrets the design asked for", () => {
    test("names accumulate across the architect's retry rather than being replaced", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "secret_required", names: ["STRIPE_KEY"] },
        {
          ...orchestrator,
          type: "secret_required",
          names: ["STRIPE_KEY", "SLACK_TOKEN"],
        },
      ]);

      assert.deepEqual(state.secretsRequired, ["STRIPE_KEY", "SLACK_TOKEN"]);
    });

    test("a mission that never asked has an empty list rather than an absent one", () => {
      assert.deepEqual(foldOf([missionCreated()]).secretsRequired, []);
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

  // §10: `ask_human` blocks the *task*, never the loop — and the blocking has to be
  // a property of the fold, because the answer may arrive when no loop is running
  // (a parked mission, answered from the dashboard, resumed later). A transition
  // only the live process applies is a transition resume loses.
  describe("ask_human parking", () => {
    const twoTasks = (): EventInput[] => [
      missionCreated(),
      { ...orchestrator, type: "task_planned", task: aCodeTask() },
      { ...orchestrator, type: "task_planned", task: aCodeTask({ id: "t2", owns: ["src/other.ts"] }) },
    ];
    const asked = (blocks: string[]): EventInput => ({
      ...orchestrator,
      type: "question_asked",
      questionId: "q1",
      question: "Which account?",
      blocks,
    });
    const answered: EventInput = {
      ...orchestrator,
      actor: "human",
      type: "question_answered",
      questionId: "q1",
      answer: "the staging one",
    };

    test("a question parks exactly the tasks it blocks", () => {
      const state = foldOf([...twoTasks(), asked(["t1"])]);

      assert.equal(state.tasks.find((t) => t.id === "t1")?.status, "blocked");
      assert.equal(state.tasks.find((t) => t.id === "t2")?.status, "todo");
    });

    test("the answer returns parked tasks to waiting, where the scheduler resumes them", () => {
      const state = foldOf([...twoTasks(), asked(["t1"]), answered]);

      // `waiting` rather than `todo`: the scheduler owns the promotion, and a task
      // whose dependencies regressed while it was parked must not skip the check.
      assert.equal(state.tasks.find((t) => t.id === "t1")?.status, "waiting");
      assert.ok(state.inbox[0].resolvedAt);
    });

    test("a question does not resurrect a done task or interrupt a running one", () => {
      const state = foldOf([
        ...twoTasks(),
        { ...orchestrator, taskId: "t1", type: "task_status", from: "todo", to: "running", reason: "dispatched" },
        { ...orchestrator, taskId: "t1", type: "task_status", from: "running", to: "done", reason: "verified" },
        { ...orchestrator, taskId: "t2", type: "task_status", from: "todo", to: "running", reason: "dispatched" },
        asked(["t1", "t2"]),
      ]);

      assert.equal(state.tasks.find((t) => t.id === "t1")?.status, "done");
      assert.equal(state.tasks.find((t) => t.id === "t2")?.status, "running");
    });

    test("a question adopts a task a worker already parked, so the answer can lift it", () => {
      // The dispatch path moves a task to `blocked` when its worker reports blocked;
      // the follow-up question has to associate with it or nothing ever resumes it.
      const state = foldOf([
        ...twoTasks(),
        { ...orchestrator, taskId: "t1", type: "task_status", from: "running", to: "blocked", reason: "worker blocked" },
        asked(["t1"]),
        answered,
      ]);

      assert.equal(state.tasks.find((t) => t.id === "t1")?.status, "waiting");
    });

    // PLAN-NEXT 7.1's question is raised for information and nothing ever answers it, so
    // the flag has to survive a refold: a resume reads it off the folded inbox, and a
    // question whose `advisory` did not reach state gates the mission it was told not to.
    test("an advisory question reaches the inbox as advisory, and an ordinary one does not", () => {
      const state = foldOf([
        ...twoTasks(),
        { ...orchestrator, type: "question_asked", questionId: "s1", question: "needs KEY?", blocks: [], advisory: true },
        asked(["t1"]),
      ]);

      assert.equal(state.inbox.find((item) => item.id === "s1")?.advisory, true);
      assert.equal(state.inbox.find((item) => item.id === "q1")?.advisory, undefined);
    });

    test("a second answer to the same question is a no-op", () => {
      const state = foldOf([
        ...twoTasks(),
        asked(["t1"]),
        answered,
        { ...orchestrator, taskId: "t1", type: "task_status", from: "waiting", to: "todo", reason: "deps landed" },
        answered,
      ]);

      assert.equal(state.tasks.find((t) => t.id === "t1")?.status, "todo");
    });

    // Defect 26's fold half: the redefined task replaces the record whole, and a
    // question that parked the old definition does not keep parking the new one.
    test("a redefined task drops its question association along with its old edges", () => {
      const state = foldOf([
        missionCreated(),
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        { ...orchestrator, type: "question_asked", questionId: "q1", question: "?", blocks: ["t1"] },
        {
          ...orchestrator,
          taskId: "t1",
          type: "task_replanned",
          task: aCodeTask({ goal: "re-scoped", status: "todo" }),
        },
      ]);

      assert.equal(state.tasks[0]?.goal, "re-scoped");
      assert.equal(state.tasks[0]?.status, "todo");
      assert.deepEqual(state.blockedBy, {});
    });

    test("a pause holds until lifted, and survives a refold the way a restart would see it", () => {
      const human = { ...orchestrator, actor: "human" } as const;
      const pausedState = foldOf([missionCreated(), { ...human, type: "pause_requested", by: "dashboard" }]);
      assert.equal(pausedState.paused, true);

      const lifted = foldOf([
        missionCreated(),
        { ...human, type: "pause_requested", by: "dashboard" },
        { ...human, type: "pause_lifted", by: "resume" },
      ]);
      assert.equal(lifted.paused, false);
    });

    test("a question blocking nothing parks nothing and still opens an inbox item", () => {
      const state = foldOf([...twoTasks(), asked([])]);

      assert.ok(state.tasks.every((t) => t.status === "todo"));
      assert.equal(state.inbox.length, 1);
    });
  });
});

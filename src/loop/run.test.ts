// The Phase 2 milestone checklist, run against a canned log and scripted answers
// with no model call and no spend.
//
// Several are deliberately adversarial. The important ones are not "does it finish"
// but "does it refuse to": a progress ledger claiming satisfaction while a criterion
// is unmet, and a replan trying to relax a criterion it cannot meet. Every other
// check in the system would agree with both.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Budget } from "../domain/budget.js";
import { type Criterion } from "../domain/ledger.js";
import { type Task } from "../domain/task.js";
import { fold, type MissionState } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import {
  aBudget,
  aCodeTask,
  aCriterion,
  aPlannedTask,
  aProgressLedger,
  aReport,
  anAgentSpec,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { type Calls, type PlanInput, type PlanResult } from "./calls.js";
import { type DispatchOutcome } from "./dispatch.js";
import { DecisionPointError } from "./resilience.js";
import { shouldCheckCriterion } from "./criteria.js";
import { runLoop, type ExtendRequest, type LoopDeps, type MissionStore } from "./run.js";

/** The log, in memory. `state()` refolds every time, exactly as the real store does,
 *  so nothing can survive a round in a variable by accident. */
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

const orchestrator = { missionId: "m1", actor: "orchestrator" as const };

interface SeedOptions {
  criteria?: Criterion[];
  tasks?: Task[];
  unattended?: boolean;
  budget?: Budget;
  quick?: boolean;
}

function seedMission({
  criteria = [aCriterion()],
  tasks = [aCodeTask()],
  unattended = false,
  budget = aBudget(),
  quick = false,
}: SeedOptions = {}): EventInput[] {
  return [
    missionCreated({ unattended, budget, ...(quick ? { quick: true } : {}) }),
    {
      ...orchestrator,
      type: "outcome_spec_written",
      criteria,
      guesses: [],
      outOfScope: [],
      estimate: { taskCount: tasks.length, wallMs: 60_000, expectedGates: 0 },
    },
    { ...orchestrator, type: "signoff_requested", estimate: { taskCount: tasks.length, wallMs: 60_000, expectedGates: 0 } },
    { ...orchestrator, type: "signoff_granted", unattended },
    ...tasks.map((task): EventInput => ({ ...orchestrator, type: "task_planned", task })),
    { ...orchestrator, type: "mission_status", from: "awaiting_signoff", to: "executing", reason: "approved" },
  ];
}

/** A dispatch that emits what a real one would, without git or a worker. */
function fakeDispatch(outcomes: Record<string, DispatchOutcome> = {}) {
  const dispatched: string[] = [];

  const run = (store: MissionStore) => async (task: Task): Promise<DispatchOutcome> => {
    dispatched.push(task.id);
    const outcome = outcomes[task.id] ?? { status: "done" as const };
    const base = { missionId: task.missionId, taskId: task.id, actor: "orchestrator" as const };

    store.emit({ ...base, type: "task_status", from: task.status, to: "running", reason: "dispatched" });
    store.emit({ ...base, actor: "worker", type: "worker_report", report: aReport() });
    store.emit({
      ...base,
      type: "spend_recorded",
      phase: task.id,
      spend: { tokens: { measured: 0, estimated: 0, unmeasured: 1 }, wallMs: 1000, dispatches: 1 },
    });

    const to =
      outcome.status === "done"
        ? "done"
        : outcome.status === "blocked"
          ? "blocked"
          : outcome.status === "conflicted"
            ? "conflicted"
            : "failed";
    store.emit({ ...base, type: "task_status", from: "running", to, reason: "fake dispatch" });
    return outcome;
  };

  return { run, dispatched };
}

interface Harness {
  deps: LoopDeps;
  store: MissionStore & { inputs: EventInput[] };
  dispatched: string[];
  calls: {
    plan: PlanInput[];
    synthesize: number;
    judged: string[];
    /** The seats the loop asked for, per check — how a panel's cost is asserted with
     *  no model behind it. */
    panels: (readonly (string | undefined)[] | undefined)[];
  };
}

function harness(options: {
  seed?: EventInput[];
  progress?: ReturnType<typeof aProgressLedger>[];
  plan?: PlanResult[];
  met?: boolean | ((criterion: Criterion) => boolean);
  outcomes?: Record<string, DispatchOutcome>;
  limits?: LoopDeps["limits"];
  requestExtension?: LoopDeps["requestExtension"];
  /** Scripted decision-point failure, so defect 36 is assertable with no model. */
  progressThrows?: Error;
}): Harness {
  const store = testStore(options.seed ?? seedMission());
  const fake = fakeDispatch(options.outcomes);
  const seen = {
    plan: [] as PlanInput[],
    synthesize: 0,
    judged: [] as string[],
    panels: [] as (readonly (string | undefined)[] | undefined)[],
  };

  let progressIndex = 0;
  let planIndex = 0;

  const calls: Calls = {
    research: async () => {
      throw new Error("the loop does not research");
    },
    architect: async () => {
      throw new Error("the loop does not architect; the spec is frozen at sign-off");
    },
    critique: async () => {
      throw new Error("the loop's replan is not critiqued — the critic runs before dispatch");
    },
    intake: async () => {
      throw new Error("the loop does not run intake; it happens once, before sign-off");
    },
    plan: async (input) => {
      seen.plan.push(input);
      const answer = options.plan?.[planIndex++];
      if (!answer) throw new Error(`no scripted plan for call ${planIndex}`);
      return answer;
    },
    synthesize: async () => {
      seen.synthesize++;
      return anAgentSpec();
    },
    progress: async () => {
      if (options.progressThrows) throw options.progressThrows;
      const answer = options.progress?.[progressIndex++];
      if (!answer) throw new Error(`no scripted progress ledger for round ${progressIndex}`);
      return answer;
    },
    judge: async () => {
      throw new Error("criterion checks are stubbed in these tests");
    },
  };

  const decide = options.met;
  return {
    store,
    dispatched: fake.dispatched,
    calls: seen,
    deps: {
      store,
      calls,
      dispatch: fake.run(store),
      cwd: process.cwd(),
      sleep: async () => {},
      checkCriterion: async (criterion, context) => {
        seen.judged.push(criterion.id);
        seen.panels.push(context.panel);
        const met = typeof decide === "function" ? decide(criterion) : (decide ?? true);
        const evidence = { artifactIds: [], checkOutput: "exit 0", reasoning: "stub", byTask: [] };
        // Only a judge check convenes a panel; a command exits 0 or it does not, and a
        // seat on it would be a model asked to second-guess an exit code.
        const seats = criterion.check.kind === "judge" ? (context.panel ?? [undefined]) : [];
        return {
          met,
          evidence,
          ...(seats.length > 1
            ? {
                votes: seats.map((lens, seat) => ({
                  seat,
                  ...(lens ? { lens } : {}),
                  met,
                  evidence,
                })),
              }
            : {}),
        };
      },
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.requestExtension ? { requestExtension: options.requestExtension } : {}),
    },
  };
}

const typesIn = (state: MissionState, store: { inputs: EventInput[] }) =>
  store.inputs.map((event) => event.type);

describe("runLoop", () => {
  // Defect 36. The mission this was found on had a signed-off contract, a plan, and
  // work on disk; one throttled `progress` call unwound through `main` and ended the
  // process. §9.4 parks a mission that cannot continue and asks — it never crashes on
  // one, and the difference is whether `orchestra resume` has anything to resume.
  test("parks blocked when a decision point will not answer, rather than throwing", async () => {
    const h = harness({
      progressThrows: new DecisionPointError("progress", 2, new Error("429 rate_limit_error")),
    });

    const result = await runLoop(h.deps);

    assert.equal(result.status, "blocked");
    assert.match(result.reason, /rate_limit_error/);
    assert.match(result.reason, /orchestra resume/);
    // The park is on the log, so a resumed mission reads a status rather than a run
    // that stopped mid-sentence.
    assert.ok(typesIn(h.store.state(), h.store).includes("mission_status"));
    // And the round's work still happened — the park is after the dispatch, not
    // instead of it.
    assert.deepEqual(h.dispatched, ["t1"]);
  });

  // The other half of the same rule: only a `DecisionPointError` parks. A programming
  // mistake that parked silently would be a bug nobody ever finds.
  test("a non-decision-point error still raises", async () => {
    const h = harness({ progressThrows: new TypeError("x is not a function") });

    await assert.rejects(() => runLoop(h.deps), TypeError);
  });

  test("completes when every criterion is met with evidence", async () => {
    const h = harness({
      progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
      met: true,
    });

    const result = await runLoop(h.deps);

    assert.equal(result.status, "complete");
    assert.deepEqual(h.dispatched, ["t1"]);
    assert.equal(h.store.state().mission.ledger.criteria[0]?.met, true);
  });

  // The case that matters: the plan was wrong rather than the work. Every task green
  // and the outcome still not met is the most informative signal the loop produces.
  test("all tasks done and the criterion unmet replans rather than completing", async () => {
    const h = harness({
      // Adversarial: the progress call claims satisfaction anyway.
      progress: [aProgressLedger({ isRequestSatisfied: true, isProgressBeingMade: false })],
      met: false,
      plan: [{ tasks: [aPlannedTask({ id: "t2", goal: "a different approach" })] }],
      limits: { maxStalls: 0, maxRounds: 1 },
    });

    const result = await runLoop(h.deps);

    assert.notEqual(result.status, "complete");
    assert.ok(typesIn(h.store.state(), h.store).includes("replan_started"));
    assert.equal(h.store.state().mission.ledger.criteria[0]?.met, false);
  });

  test("a criterion whose check never ran cannot count toward satisfaction", async () => {
    // No task satisfies c1, so its check never fires and `met` stays undefined.
    const h = harness({
      seed: seedMission({ tasks: [aCodeTask({ satisfies: [] })] }),
      progress: [
        aProgressLedger({ isRequestSatisfied: true }),
        aProgressLedger({ isRequestSatisfied: true }),
      ],
      limits: { maxRounds: 2 },
    });

    const result = await runLoop(h.deps);

    assert.equal(result.status, "abandoned");
    assert.equal(h.calls.judged.length, 0);
    assert.equal(h.store.state().mission.ledger.criteria[0]?.met, undefined);
  });

  test("checks a criterion once, when its last satisfying task lands", async () => {
    const h = harness({
      seed: seedMission({
        tasks: [
          aCodeTask({ id: "t1", owns: ["src/a.ts"], branch: "a" }),
          aCodeTask({ id: "t2", owns: ["src/b.ts"], branch: "b", dependsOn: ["t1"], status: "waiting" }),
        ],
      }),
      progress: [
        aProgressLedger({}),
        aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
      ],
      met: true,
    });

    await runLoop(h.deps);

    // Round 1 runs t1 and the criterion is still outstanding; round 2 promotes and
    // runs t2, and only then does the check fire — once.
    assert.deepEqual(h.dispatched, ["t1", "t2"]);
    assert.deepEqual(h.calls.judged, ["c1"]);
  });

  // Defect 32, and the reason a real mission produced no `criterion_checked` at all:
  // the satisfying set was every task the mission had ever planned, so one task the
  // replan had abandoned gated its criteria forever. The fixtures never caught it
  // because a fixture's task list never contains work the current plan has dropped.
  describe("criterion checks after a replan", () => {
    test("a criterion the current plan re-staffs is checked when the new task lands", async () => {
      const h = harness({
        seed: seedMission({ tasks: [aCodeTask({ id: "abandoned", satisfies: ["c1"] })] }),
        outcomes: {
          abandoned: { status: "failed", failure: "verification", message: "exit 1" },
        },
        progress: [
          aProgressLedger({ isProgressBeingMade: false, isInLoop: true }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [{ tasks: [aPlannedTask({ id: "fresh", satisfies: ["c1"] })] }],
        met: true,
      });

      const result = await runLoop(h.deps);

      assert.deepEqual(h.dispatched, ["abandoned", "fresh"]);
      assert.deepEqual(h.calls.judged, ["c1"]);
      assert.equal(result.status, "complete");
    });

    // The other half: a task the plan still carries has to keep gating, or the check
    // fires against half the work and a mission completes early.
    test("a task the plan still carries keeps the criterion outstanding", async () => {
      const h = harness({
        seed: seedMission({
          tasks: [
            aCodeTask({ id: "t1", owns: ["src/a.ts"], branch: "a", satisfies: ["c1"] }),
            aCodeTask({
              id: "t2",
              owns: ["src/b.ts"],
              branch: "b",
              satisfies: ["c1"],
              dependsOn: ["t1"],
              status: "waiting",
            }),
          ],
        }),
        progress: [aProgressLedger({}), aProgressLedger({})],
        limits: { maxRounds: 1 },
        met: true,
      });

      await runLoop(h.deps);

      assert.deepEqual(h.dispatched, ["t1"]);
      assert.deepEqual(h.calls.judged, []);
    });
  });

  // P1, and run 8's shape exactly: `readme-doc-quality` was checked `false` in round
  // 6, a replan produced a task to fix it, that task merged by round 11, and the
  // criterion was never graded again — so the mission could only spin to its reset
  // cap with the work it needed already on `main`. Defect 32's family: a check that
  // cannot fire is indistinguishable from a check that fired and failed.
  describe("re-checking a criterion", () => {
    test("an unmet criterion is checked again when the fix lands", async () => {
      let checks = 0;
      const h = harness({
        seed: seedMission({ tasks: [aCodeTask({ id: "t1", satisfies: ["c1"] })] }),
        progress: [
          // Round 1: the work landed, the check said no, and the mission is going
          // round in circles — replan.
          aProgressLedger({ isInLoop: true, isProgressBeingMade: false }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [{ tasks: [aPlannedTask({ id: "fix", satisfies: ["c1"] })] }],
        met: () => ++checks > 1,
      });

      const result = await runLoop(h.deps);

      assert.deepEqual(h.dispatched, ["t1", "fix"]);
      assert.deepEqual(h.calls.judged, ["c1", "c1"]);
      assert.equal(h.store.state().mission.ledger.criteria[0]?.met, true);
      assert.equal(result.status, "complete");
    });

    // The expensive complement, and the reason this is a decision rather than "check
    // every round": a judge is a model call per criterion, and a criterion that
    // already passed over work that has not moved has nothing new to say.
    test("a still-met criterion is not re-judged while nothing lands", async () => {
      const h = harness({
        seed: seedMission({
          tasks: [
            aCodeTask({ id: "t1", owns: ["src/a.ts"], branch: "a", satisfies: ["c1"] }),
            aCodeTask({
              id: "t2",
              owns: ["src/b.ts"],
              branch: "b",
              satisfies: [],
              dependsOn: ["t1"],
              status: "waiting",
            }),
          ],
        }),
        // c1's only contributor lands in round 1 and passes; t2 lands in round 2 and
        // satisfies nothing, so round 2 has no reason to grade c1 again.
        progress: [
          aProgressLedger({}),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        met: true,
      });

      await runLoop(h.deps);

      assert.deepEqual(h.dispatched, ["t1", "t2"]);
      assert.deepEqual(h.calls.judged, ["c1"]);
    });

    // And the failing case that is *not* a re-check: no new landing means no new
    // evidence, so grading it again would buy the same answer at the same price.
    test("an unmet criterion is not re-judged when nothing new landed", async () => {
      const h = harness({
        seed: seedMission({
          tasks: [
            aCodeTask({ id: "t1", owns: ["src/a.ts"], branch: "a", satisfies: ["c1"] }),
            aCodeTask({
              id: "t2",
              owns: ["src/b.ts"],
              branch: "b",
              satisfies: [],
              dependsOn: ["t1"],
              status: "waiting",
            }),
          ],
        }),
        progress: [aProgressLedger({}), aProgressLedger({})],
        limits: { maxRounds: 2 },
        met: false,
      });

      await runLoop(h.deps);

      // t2 landed in round 2, but it satisfies nothing — c1's own contributor has not
      // moved since the verdict.
      assert.deepEqual(h.dispatched, ["t1", "t2"]);
      assert.deepEqual(h.calls.judged, ["c1"]);
    });
  });

  describe("stalls and loops", () => {
    // Not progressing means the work is hard. Repeating means nothing more will come
    // of continuing, so it replans immediately rather than burning the stall budget.
    test("trips isInLoop and replans without waiting for the stall counter", async () => {
      const h = harness({
        progress: [
          aProgressLedger({ isInLoop: true, isProgressBeingMade: true }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [{ tasks: [aPlannedTask({ id: "t2" })] }],
        met: true,
      });

      await runLoop(h.deps);

      assert.equal(h.store.state().mission.stalls, 0);
      assert.ok(typesIn(h.store.state(), h.store).includes("replan_started"));
    });

    test("replans after maxStalls consecutive non-progressing rounds", async () => {
      const h = harness({
        progress: [
          aProgressLedger({ isProgressBeingMade: false }),
          aProgressLedger({ isProgressBeingMade: false }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [{ tasks: [aPlannedTask({ id: "t2" })] }],
        met: true,
        limits: { maxStalls: 1 },
      });

      await runLoop(h.deps);

      const events = typesIn(h.store.state(), h.store);
      assert.ok(events.includes("stall_detected"));
      assert.ok(events.includes("replan_started"));
    });

    test("escalates to a human at the reset cap instead of spinning", async () => {
      const h = harness({
        progress: Array.from({ length: 4 }, () => aProgressLedger({ isInLoop: true })),
        plan: [{ tasks: [aPlannedTask({ id: "t2" })] }, { tasks: [aPlannedTask({ id: "t3" })] }],
        met: false,
        limits: { maxResets: 2 },
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "blocked");
      assert.match(result.reason, /reset cap/);
      const asked = h.store.inputs.find((event) => event.type === "question_asked");
      assert.ok(asked && "question" in asked && /different approach/.test(asked.question));
    });
  });

  // §10: ask_human parks one task while the rest of the mission keeps running. The
  // Phase 3 leftover — the events and the waiting/blocked split existed, and nothing
  // moved the tasks or raised a question mid-round.
  describe("ask_human", () => {
    test("a blocked worker raises a question that parks its task while the rest runs", async () => {
      const h = harness({
        seed: seedMission({
          tasks: [
            aCodeTask({ id: "t1", owns: ["src/a.ts"], branch: "a" }),
            aCodeTask({ id: "t2", owns: ["src/b.ts"], branch: "b" }),
          ],
        }),
        outcomes: { t1: { status: "blocked", message: "Which of the two staging accounts?" } },
        progress: [aProgressLedger()],
        met: true,
      });

      const result = await runLoop(h.deps);

      // Both dispatched in the same round: the question never blocks the loop.
      assert.deepEqual([...h.dispatched].sort(), ["t1", "t2"]);
      assert.equal(result.status, "blocked");

      const asked = h.store.inputs.find((e) => e.type === "question_asked");
      assert.ok(asked && "blocks" in asked, "no question_asked reached the log");
      assert.deepEqual(asked.blocks, ["t1"]);
      assert.match(asked.question, /staging accounts/);

      const state = h.store.state();
      assert.equal(state.tasks.find((t) => t.id === "t1")?.status, "blocked");
      assert.equal(state.tasks.find((t) => t.id === "t2")?.status, "done");
      assert.equal(state.blockedBy["t1"], asked.questionId);
    });

    test("an answer arriving while parked lets the resumed loop redispatch the task", async () => {
      const h = harness({
        seed: [
          ...seedMission(),
          {
            ...orchestrator,
            taskId: "t1",
            type: "question_asked",
            questionId: "q1",
            question: "Which account?",
            blocks: ["t1"],
          },
          { ...orchestrator, actor: "human", type: "question_answered", questionId: "q1", answer: "staging" },
        ],
        progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
        met: true,
      });

      const result = await runLoop(h.deps);

      assert.deepEqual(h.dispatched, ["t1"]);
      assert.equal(result.status, "complete");
    });
  });

  // Defect 26, reproduced at the loop level: the first real serve-driven mission
  // failed its recon task, and every replan correctly dropped it from the surviving
  // task's dependencies — in the ledger. The task records never heard, the scheduler
  // reads task records, and seven rounds dispatched nothing. The fixture that would
  // have caught it always replanned with fresh ids, which is exactly what a real
  // planner does not do.
  test("a replan that reuses a task id with new dependencies actually reschedules it", async () => {
    const h = harness({
      seed: seedMission({
        tasks: [
          aCodeTask({ id: "recon", owns: ["notes.md"], branch: "recon", satisfies: [] }),
          aCodeTask({ id: "write", owns: ["src/x.ts"], branch: "write", dependsOn: ["recon"], status: "waiting" }),
        ],
      }),
      outcomes: { recon: { status: "failed", failure: "verification", message: "left no artifact" } },
      progress: [
        aProgressLedger({ isInLoop: true, isProgressBeingMade: false }),
        aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
      ],
      // The replan reuses the surviving task's id and cuts the failed dependency.
      plan: [{ tasks: [aPlannedTask({ id: "write", goal: aCodeTask().goal })] }],
      met: true,
    });

    const result = await runLoop(h.deps);

    assert.deepEqual(h.dispatched, ["recon", "write"]);
    assert.equal(result.status, "complete");
    assert.ok(h.store.inputs.some((e) => e.type === "task_replanned"));
  });

  // Pause is not panic (§10): it drains and parks, reversibly, and the loop is the
  // thing that has to honour it — a paused flag nothing reads is a pause button
  // wired to nothing.
  describe("pause", () => {
    test("a paused mission parks before dispatching anything", async () => {
      const h = harness({
        seed: [
          ...seedMission(),
          { ...orchestrator, actor: "human", type: "pause_requested", by: "dashboard" },
        ],
        progress: [],
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "blocked");
      assert.match(result.reason, /[Pp]aused/);
      assert.match(result.reason, /orchestra resume/);
      assert.deepEqual(h.dispatched, []);
    });

    test("a lifted pause runs normally", async () => {
      const h = harness({
        seed: [
          ...seedMission(),
          { ...orchestrator, actor: "human", type: "pause_requested", by: "dashboard" },
          { ...orchestrator, actor: "human", type: "pause_lifted", by: "resume" },
        ],
        progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
        met: true,
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "complete");
      assert.deepEqual(h.dispatched, ["t1"]);
    });
  });

  describe("the criteria freeze", () => {
    // Adversarial: the planner cannot meet the criterion, so it returns a relaxed
    // one. Every other check in the system would then agree the mission succeeded.
    test("refuses a replan that edits a signed-off criterion, and reopens sign-off", async () => {
      const relaxed = aCriterion({ statement: "GET /health returns anything at all" });
      const h = harness({
        progress: [aProgressLedger({ isInLoop: true })],
        plan: [{ tasks: [aPlannedTask({ id: "t2" })], criteria: [relaxed] }],
        met: false,
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "awaiting_signoff");
      const requested = h.store.inputs.find((e) => e.type === "criteria_change_requested");
      assert.ok(requested && "diff" in requested && requested.diff[0]?.op === "amend");
      assert.equal(
        h.store.state().mission.ledger.criteria[0]?.statement,
        aCriterion().statement,
      );
    });

    test("under --unattended it parks in blocked rather than approving its own change", async () => {
      const h = harness({
        seed: seedMission({ unattended: true }),
        progress: [aProgressLedger({ isInLoop: true })],
        plan: [{ tasks: [aPlannedTask({ id: "t2" })], criteria: [aCriterion({ statement: "easier" })] }],
        met: false,
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "blocked");
      assert.match(result.reason, /--unattended/);
    });

    test("a plan that leaves the criteria alone revises the ledger and carries on", async () => {
      const h = harness({
        progress: [
          aProgressLedger({ isInLoop: true }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [{ tasks: [aPlannedTask({ id: "t2" })], criteria: [aCriterion()] }],
        met: true,
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "complete");
      assert.ok(typesIn(h.store.state(), h.store).includes("ledger_revised"));
    });
  });

  describe("planning", () => {
    test("rejects a dependency cycle before any agent is synthesized", async () => {
      const cyclic: PlanResult = {
        tasks: [
          aPlannedTask({ id: "t2", dependsOn: ["t3"] }),
          aPlannedTask({ id: "t3", dependsOn: ["t2"] }),
        ],
      };
      const h = harness({
        progress: [aProgressLedger({ isInLoop: true })],
        plan: [cyclic, cyclic],
        met: false,
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "abandoned");
      assert.match(result.reason, /cycle/);
      assert.equal(h.calls.synthesize, 0);
    });

    test("gives the planner one retry, quoting the offending edge", async () => {
      const h = harness({
        progress: [
          aProgressLedger({ isInLoop: true }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [
          { tasks: [aPlannedTask({ id: "t2", dependsOn: ["t9"] })] },
          { tasks: [aPlannedTask({ id: "t2" })] },
        ],
        met: true,
      });

      await runLoop(h.deps);

      assert.equal(h.calls.plan.length, 2);
      assert.match(h.calls.plan[1]?.reason ?? "", /depends on 't9'/);
      assert.equal(h.calls.synthesize, 1);
    });

    // A replan that can re-propose what just failed is a retry wearing a costume.
    test("carries recorded dead ends into the next plan", async () => {
      const h = harness({
        outcomes: {
          t1: { status: "failed", failure: "verification", message: "exit 1: two tests failed" },
        },
        progress: [aProgressLedger({ isProgressBeingMade: false, isInLoop: true })],
        plan: [{ tasks: [aPlannedTask({ id: "t2" })] }],
        met: true,
        limits: { maxRounds: 1 },
      });

      await runLoop(h.deps);

      const deadEnds = h.calls.plan[0]?.ledger.deadEnds ?? [];
      assert.equal(deadEnds.length, 1);
      assert.match(deadEnds[0]?.evidence ?? "", /two tests failed/);
    });

    // Defect 32's other half, and the shape the real mission replanned itself into: a
    // criterion no task claims can never be checked (§4), so the mission would run to
    // its cap with that criterion permanently outstanding.
    test("refuses a replan that leaves a criterion to no task, naming it", async () => {
      const orphaning: PlanResult = { tasks: [aPlannedTask({ id: "t2", satisfies: ["c1"] })] };
      const h = harness({
        seed: seedMission({ criteria: [aCriterion({ id: "c1" }), aCriterion({ id: "c2" })] }),
        progress: [aProgressLedger({ isInLoop: true })],
        plan: [orphaning, orphaning],
        met: false,
      });

      const result = await runLoop(h.deps);

      assert.equal(h.calls.plan.length, 2);
      assert.match(h.calls.plan[1]?.reason ?? "", /No task in the plan satisfies 'c2'/);
      assert.equal(result.status, "abandoned");
      assert.equal(h.calls.synthesize, 0);
    });

    test("a covered plan is not refused for a criterion already met", async () => {
      const h = harness({
        seed: seedMission({ criteria: [aCriterion({ id: "c1" }), aCriterion({ id: "c2" })] }),
        progress: [
          aProgressLedger({ isInLoop: true }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [{ tasks: [aPlannedTask({ id: "t2", satisfies: ["c1", "c2"] })] }],
        met: true,
      });

      const result = await runLoop(h.deps);

      assert.equal(h.calls.plan.length, 1);
      assert.equal(result.status, "complete");
    });

    test("a new task with dependencies is planned as waiting, not todo", async () => {
      const h = harness({
        progress: [
          aProgressLedger({ isInLoop: true }),
          aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        ],
        plan: [
          {
            tasks: [
              aPlannedTask({ id: "t2" }),
              aPlannedTask({ id: "t3", dependsOn: ["t2"] }),
            ],
          },
        ],
        met: true,
      });

      await runLoop(h.deps);

      const tasks = h.store.state().tasks;
      assert.equal(tasks.find((task) => task.id === "t3")?.status, "waiting");
    });
  });

  test("a task stranded behind a failure stays waiting and reaches the planner", async () => {
    const h = harness({
      seed: seedMission({
        tasks: [
          aCodeTask({ id: "t1", owns: ["src/a.ts"], branch: "a" }),
          aCodeTask({ id: "t2", owns: ["src/b.ts"], branch: "b", dependsOn: ["t1"], status: "waiting" }),
        ],
      }),
      outcomes: { t1: { status: "failed", failure: "verification", message: "exit 1" } },
      progress: [aProgressLedger({ isProgressBeingMade: false, isInLoop: true })],
      plan: [{ tasks: [aPlannedTask({ id: "t3" })] }],
      met: true,
      limits: { maxRounds: 1 },
    });

    await runLoop(h.deps);

    // Never dispatched, never cancelled — cancelling the branch is the planner's call.
    assert.equal(h.dispatched.includes("t2"), false);
    assert.equal(h.store.state().tasks.find((task) => task.id === "t2")?.status, "waiting");
    // And it reaches the planner as a named frontier rather than vanishing.
    assert.deepEqual(h.calls.plan[0]?.ledger.deadEnds.length, 1);
  });

  test("hitting the round ceiling abandons rather than running forever", async () => {
    const h = harness({
      progress: [aProgressLedger({}), aProgressLedger({})],
      limits: { maxRounds: 2 },
      met: true,
    });

    const result = await runLoop(h.deps);

    assert.equal(result.status, "abandoned");
    assert.match(result.reason, /2-round ceiling/);
  });

  describe("the budget", () => {
    const spentBudget = (seed: EventInput[]): EventInput[] => [
      ...seed,
      {
        ...orchestrator,
        type: "spend_recorded",
        phase: "t0",
        spend: { tokens: { measured: 0, estimated: 0, unmeasured: 5 }, wallMs: aBudget().wallMs, dispatches: 5 },
      },
    ];

    test("parks in blocked and asks, rather than failing hard", async () => {
      const asked: ExtendRequest[] = [];
      const h = harness({
        seed: spentBudget(seedMission()),
        progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
        met: true,
        requestExtension: async (request) => {
          asked.push(request);
          return undefined;
        },
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "abandoned");
      assert.match(result.reason, /declined/);
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0]?.unmetCriteria, ["c1"]);
      assert.ok(h.store.inputs.some((event) => event.type === "budget_exceeded"));
    });

    test("resumes at the same round when the extension is approved", async () => {
      const h = harness({
        seed: spentBudget(seedMission()),
        progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
        met: true,
        requestExtension: async () => ({ wallMs: 20 * 60_000 }),
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "complete");
      // Round 1, not round 2: the budget check runs before the round opens.
      assert.equal(result.rounds, 1);
      assert.ok(h.store.inputs.some((event) => event.type === "budget_extended"));
    });

    test("refuses a third extension", async () => {
      const twice: EventInput[] = [
        ...spentBudget(seedMission()),
        { ...orchestrator, type: "budget_extended", added: { wallMs: 1 }, extensions: 1, by: "human" },
        { ...orchestrator, type: "budget_extended", added: { wallMs: 1 }, extensions: 2, by: "human" },
      ];
      const h = harness({
        seed: twice,
        progress: [aProgressLedger({})],
        met: true,
        requestExtension: async () => ({ wallMs: 20 * 60_000 }),
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "abandoned");
      assert.match(result.reason, /overran its budget 2 times/);
    });

    // A flag that skips reading the plan is a reasonable trade. One that lets an
    // unwatched mission raise its own spending limit is not.
    test("under --unattended it parks rather than granting an extension", async () => {
      let asked = false;
      const h = harness({
        seed: spentBudget(seedMission({ unattended: true })),
        progress: [aProgressLedger({})],
        met: true,
        requestExtension: async () => {
          asked = true;
          return { wallMs: 1 };
        },
      });

      const result = await runLoop(h.deps);

      assert.equal(result.status, "blocked");
      assert.equal(asked, false);
    });
  });

  test("parks in blocked when a task is waiting on a person and nothing else can run", async () => {
    const h = harness({
      outcomes: { t1: { status: "blocked", message: "which account?" } },
      progress: [aProgressLedger({})],
      met: true,
    });

    const result = await runLoop(h.deps);

    assert.equal(result.status, "blocked");
    assert.match(result.reason, /Waiting on a human for t1/);
  });

  test("a transport failure is retried once and then left to the planner", async () => {
    const h = harness({
      outcomes: { t1: { status: "failed", failure: "transport", message: "claude not found" } },
      progress: [aProgressLedger({}), aProgressLedger({})],
      limits: { maxRounds: 2 },
      met: true,
    });

    await runLoop(h.deps);

    // Dispatched in round 1, requeued, dispatched again in round 2, then no more.
    assert.deepEqual(h.dispatched, ["t1", "t1"]);
    assert.equal(h.store.state().tasks[0]?.status, "failed");
  });
});

// PLAN-NEXT 6.1 and 6.2, both assertable against a canned log with no model: what a
// panel costs, and what a failing deterministic check stops it costing.
describe("judge panels and the deterministic gate", () => {
  const judged = (id: string) =>
    aCriterion({ id, statement: `${id} reads well`, check: { kind: "judge", rubric: "PASS if so" } });

  const seatsOf = (store: { inputs: EventInput[] }, criterionId: string) =>
    store.inputs
      .filter(
        (event): event is Extract<EventInput, { type: "criterion_checked" }> =>
          event.type === "criterion_checked" && event.criterionId === criterionId,
      )
      .map((event) => [event.panelSeat, event.lens] as const);

  test("a standard mission convenes three lensed seats and records each in the log", async () => {
    const h = harness({
      seed: seedMission({
        criteria: [judged("c1")],
        tasks: [aCodeTask({ id: "t1", satisfies: ["c1"] })],
      }),
      progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
      met: true,
    });

    await runLoop(h.deps);

    assert.deepEqual(h.calls.panels, [["correctness", "spec-compliance", "does-it-run"]]);
    // Three seats, then the panel's answer — the resolved verdict last and unseated,
    // which is the one `fold` applies.
    assert.deepEqual(seatsOf(h.store, "c1"), [
      [0, "correctness"],
      [1, "spec-compliance"],
      [2, "does-it-run"],
      [undefined, undefined],
    ]);
  });

  // The done-when this whole path is measured against: a quick mission's judge spend
  // is what it was before panels existed, and that is one event and one call.
  test("a quick mission convenes one unlensed seat and writes one verdict", async () => {
    const h = harness({
      seed: seedMission({
        quick: true,
        criteria: [judged("c1")],
        tasks: [aCodeTask({ id: "t1", satisfies: ["c1"] })],
      }),
      progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
      met: true,
    });

    await runLoop(h.deps);

    assert.deepEqual(h.calls.panels, [[undefined]]);
    assert.deepEqual(seatsOf(h.store, "c1"), [[undefined, undefined]]);
  });

  test("a failing command criterion stops the panel being convened that round", async () => {
    const h = harness({
      seed: seedMission({
        criteria: [judged("prose"), aCriterion({ id: "tests" })],
        tasks: [aCodeTask({ id: "t1", satisfies: ["prose", "tests"] })],
      }),
      progress: [aProgressLedger({}), aProgressLedger({})],
      limits: { maxRounds: 1 },
      met: (criterion) => criterion.id !== "tests",
    });

    await runLoop(h.deps);

    // The deterministic check ran, the panel did not, and nothing was recorded about a
    // criterion nobody graded.
    assert.deepEqual(h.calls.judged, ["tests"]);
    assert.deepEqual(seatsOf(h.store, "prose"), []);
  });

  test("with the deterministic check green the panel runs in the same round", async () => {
    const h = harness({
      seed: seedMission({
        criteria: [judged("prose"), aCriterion({ id: "tests" })],
        tasks: [aCodeTask({ id: "t1", satisfies: ["prose", "tests"] })],
      }),
      progress: [aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] })],
      met: true,
    });

    await runLoop(h.deps);

    // Deterministic first, whatever order the outcome spec wrote them in.
    assert.deepEqual(h.calls.judged, ["tests", "prose"]);
  });

  // The gate suppresses the panel; it must not suppress the *re-check*. A criterion
  // whose `lastCheckedRound` had moved while nothing graded it would be gated for the
  // rest of the mission — defect 32's shape, one layer along.
  test("a gated criterion is left untouched, so the next round can still convene it", async () => {
    const h = harness({
      seed: seedMission({
        criteria: [judged("prose"), aCriterion({ id: "tests" })],
        tasks: [aCodeTask({ id: "t1", satisfies: ["prose", "tests"] })],
      }),
      progress: [aProgressLedger({}), aProgressLedger({})],
      limits: { maxRounds: 1 },
      met: (criterion) => criterion.id !== "tests",
    });

    await runLoop(h.deps);

    const prose = h.store.state().mission.ledger.criteria.find((c) => c.id === "prose")!;
    assert.equal(prose.met, undefined);
    assert.equal(prose.lastCheckedRound, undefined);
    assert.equal(
      shouldCheckCriterion({ criterion: prose, allDone: true, landed: [{ completedRound: 1 }], round: 2 }),
      true,
    );
  });
});

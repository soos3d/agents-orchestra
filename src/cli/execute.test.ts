// The failure mode under test: a resume that does not resume.
//
// `orchestra resume` replayed the log, reconciled orphans, rebuilt the projections —
// and stopped. `--plan-only` ends by printing "Resume with 'orchestra resume <id>'",
// so the command that made the promise and the command that broke it were the same
// pair. These assert that folded state alone decides what happens next, and that the
// two cases a human would notice — a plan waiting to be run, and a mission that
// stopped on a question nobody can answer yet — are told apart.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { continuationFor, executeMission } from "./execute.js";
import {
  aCodeTask,
  aCriterion,
  aMission,
  aMissionState,
  anAgentSpec,
  aPlannedTask,
  aProgressLedger,
  aReport,
  missionCreated,
  stamp,
} from "../testing/fixtures.js";
import { emptyLedger } from "../domain/ledger.js";
import { fold } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { type Calls } from "../loop/calls.js";
import { type LoopDeps, type MissionStore } from "../loop/run.js";
import { type DiscoveredConfig } from "../config/discover.js";
import { type Task } from "../domain/task.js";

const planned = () => ({
  ...emptyLedger(),
  criteria: [aCriterion()],
  plan: [aPlannedTask()],
});

describe("continuationFor", () => {
  test("a mission that never got past research has nothing to continue", () => {
    const result = continuationFor(aMissionState({ mission: aMission({ status: "scanning" }) }));

    assert.equal(result.kind, "unplanned");
    // Research is not checkpointed mid-flight, so the honest next step names the
    // command that starts one rather than pretending to pick up where it left off.
    assert.match(result.message, /orchestra run/);
  });

  // The `--plan-only` handoff: a plan exists, nobody signed it off, and typing
  // `resume` is the human saying go. That IS the sign-off (§13).
  test("a planned but unsigned mission signs off and runs", () => {
    const state = aMissionState({
      mission: aMission({ status: "specifying", ledger: planned() }),
    });

    assert.equal(continuationFor(state).kind, "signoff");
  });

  test("a signed-off mission mid-execution goes straight to the loop", () => {
    const state = aMissionState({
      mission: aMission({
        status: "executing",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask()],
    });

    assert.equal(continuationFor(state).kind, "loop");
  });

  // A mission killed by SIGINT parks in `blocked` with nothing in the inbox. That is
  // the case resume exists for, and reading `blocked` as terminal would strand it.
  test("blocked by a shutdown resumes, because nobody is being waited on", () => {
    const state = aMissionState({
      mission: aMission({
        status: "blocked",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask()],
    });

    assert.equal(continuationFor(state).kind, "loop");
  });

  test("blocked on an unanswered question halts rather than re-asking it", () => {
    const state = aMissionState({
      mission: aMission({
        status: "blocked",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask()],
      inbox: [
        {
          id: "escalation-r4",
          kind: "question",
          summary: "This mission has replanned 3 times. Narrower goal, or different approach?",
          openedAt: "2026-07-25T11:00:00.000Z",
        },
      ],
    });

    const result = continuationFor(state);
    assert.equal(result.kind, "halted");
    assert.match(result.message, /question/);
  });

  test("an answered question is not still blocking", () => {
    const state = aMissionState({
      mission: aMission({
        status: "blocked",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask()],
      inbox: [
        {
          id: "escalation-r4",
          kind: "question",
          summary: "Narrower goal, or different approach?",
          openedAt: "2026-07-25T11:00:00.000Z",
          resolvedAt: "2026-07-25T11:30:00.000Z",
        },
      ],
    });

    assert.equal(continuationFor(state).kind, "loop");
  });

  test("a complete mission is not re-run, and says so with a zero exit", () => {
    const state = aMissionState({
      mission: aMission({ status: "complete", ledger: planned() }),
    });

    const result = continuationFor(state);
    assert.equal(result.kind, "halted");
    assert.equal(result.code, 0);
  });

  test("an abandoned mission exits non-zero so a pipeline notices", () => {
    const state = aMissionState({
      mission: aMission({ status: "abandoned", ledger: planned() }),
    });

    const result = continuationFor(state);
    assert.equal(result.kind, "halted");
    assert.equal(result.code, 1);
  });

  // A replan asked to change a signed-off criterion, which is the one thing after
  // sign-off that blocks (§3). Looping would re-propose the same change forever.
  test("a criteria change waits for the screen that resolves it", () => {
    const state = aMissionState({
      mission: aMission({
        status: "awaiting_signoff",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
    });

    const result = continuationFor(state);
    assert.equal(result.kind, "halted");
    assert.match(result.message, /criteri/i);
  });
});

/** The log, in memory. `state()` refolds every time, exactly as the real store does. */
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

/** A mission left exactly where `--plan-only` leaves one: spec written, plan in the
 *  ledger, sign-off requested and never granted. */
const planOnlyMission = (): EventInput[] => [
  missionCreated(),
  {
    ...orchestrator,
    type: "ledger_revised",
    ledger: { ...emptyLedger(), criteria: [aCriterion()], plan: [aPlannedTask()] },
    reason: "replan",
  },
  {
    ...orchestrator,
    type: "outcome_spec_written",
    criteria: [aCriterion()],
    guesses: [],
    outOfScope: [],
    estimate: { taskCount: 1, tokens: 1000, wallMs: 60_000, expectedGates: 0 },
  },
  {
    ...orchestrator,
    type: "mission_status",
    from: "researching",
    to: "specifying",
    reason: "research complete",
  },
];

describe("executeMission", () => {
  const config = { cwd: "/repo", stateDir: "/state", worktreeRoot: "/wt", agents: [], orchestratorModel: "opus", maxConcurrency: 4 } satisfies DiscoveredConfig;

  function harness(seed: EventInput[]) {
    const store = testStore(seed);
    const lines: string[] = [];
    const dispatched: string[] = [];

    const calls: Calls = {
      research: async () => {
        throw new Error("resume does not research a mission that already has a plan");
      },
      plan: async () => ({ tasks: [aPlannedTask()] }),
      synthesize: async () => anAgentSpec(),
      progress: async () => aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
      judge: async () => {
        throw new Error("the criterion carries a command check");
      },
    };

    const buildLoop = async (
      loopStore: MissionStore,
      loopCalls: Calls,
    ): Promise<LoopDeps> => ({
      store: loopStore,
      calls: loopCalls,
      cwd: "/repo",
      checkCriterion: async () => ({ met: true, evidence: { artifactIds: [], checkOutput: "ok", reasoning: "the check passed", byTask: [] } }),
      dispatch: async (task: Task) => {
        dispatched.push(task.id);
        const base = { missionId: "m1", taskId: task.id, actor: "orchestrator" as const };
        loopStore.emit({ ...base, type: "task_status", from: task.status, to: "running", reason: "dispatched" });
        loopStore.emit({ ...base, actor: "worker", type: "worker_report", report: aReport() });
        loopStore.emit({ ...base, type: "task_status", from: "running", to: "done", reason: "verified" });
        return { status: "done" };
      },
    });

    return {
      store,
      dispatched,
      lines,
      run: () =>
        executeMission({
          store,
          calls: () => calls,
          config,
          io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
          buildLoop,
        }),
    };
  }

  // The `--plan-only` promise, kept: the command that printed "resume with…" and the
  // command that picks it up now agree.
  test("resuming a --plan-only mission signs off, synthesizes, and runs it", async () => {
    const h = harness(planOnlyMission());

    const { code } = await h.run();

    assert.equal(code, 0);
    assert.deepEqual(h.dispatched, ["t1"]);
    assert.ok(h.store.inputs.some((e) => e.type === "signoff_granted"));
    assert.ok(h.store.inputs.some((e) => e.type === "task_planned"));
  });

  // Sign-off is what freezes the criteria (§3), so it has to be the same event
  // whether a screen granted it or a human typed `resume`.
  test("the sign-off it grants freezes the criteria", async () => {
    const h = harness(planOnlyMission());

    await h.run();

    assert.ok(h.store.state().mission.signedOffAt);
  });

  test("an already-complete mission is reported, not re-run", async () => {
    const h = harness([
      ...planOnlyMission(),
      { ...orchestrator, type: "mission_status", from: "executing", to: "complete", reason: "criteria met" },
    ]);

    const { code } = await h.run();

    assert.equal(code, 0);
    assert.deepEqual(h.dispatched, []);
    assert.match(h.lines.join("\n"), /already complete/);
  });
});

// The failure mode under test: a resume that does not resume.
//
// `orchestra resume` replayed the log, reconciled orphans, rebuilt the projections —
// and stopped. `--plan-only` ends by printing "Resume with 'orchestra resume <id>'",
// so the command that made the promise and the command that broke it were the same
// pair. These assert that folded state alone decides what happens next, and that the
// two cases a human would notice — a plan waiting to be run, and a mission that
// stopped on a question nobody can answer yet — are told apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { readLore } from "../memory/lore.js";
import { saveProfile } from "../memory/profiles.js";
import {
  buildLoopDeps,
  continuationFor,
  dispatchOptionsFor,
  executeMission,
  permissionPortFor,
} from "./execute.js";
import {
  aCodeTask,
  aCriterion,
  aMission,
  aMissionState,
  anAgentSpec,
  anEnvelope,
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
import { type DispatchDeps } from "../loop/dispatch.js";
import { type HumanPort } from "../loop/human.js";
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

  // PLAN-NEXT 7.1. `secret_required` raises a question that parks nothing, on a mission
  // that is still running — the whole point being that a missing credential is a question
  // and not a stop. This gate used to read any open item as "something is waiting", which
  // halted the mission with its mock-first plan already written and paid for.
  test("a question that parks nothing does not halt a running mission", () => {
    const state = aMissionState({
      mission: aMission({
        status: "executing",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask()],
      inbox: [
        {
          id: "secret-STRIPE_KEY",
          kind: "question",
          summary: "The design needs STRIPE_KEY, which this mission's envelope does not grant.",
          openedAt: "2026-07-25T11:00:00.000Z",
        },
      ],
    });

    assert.equal(continuationFor(state).kind, "loop");
  });

  // The same shape with a task actually parked on it is the case the gate exists for.
  test("a question a task is parked on still halts", () => {
    const state = aMissionState({
      mission: aMission({
        status: "executing",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask({ status: "blocked" })],
      blockedBy: { t1: "ask-t1-r2" },
      inbox: [
        {
          id: "ask-t1-r2",
          kind: "question",
          taskId: "t1",
          summary: "Task t1 is blocked: which account?",
          openedAt: "2026-07-25T11:00:00.000Z",
        },
      ],
    });

    assert.equal(continuationFor(state).kind, "halted");
  });

  // The same advisory question on a mission that parked for an unrelated reason — an API
  // 529, a budget stop, a shutdown all leave `blocked` behind. Reading the status as
  // "this question is being waited on" held a mission with 5 of 6 criteria met hostage
  // to a question whose own text says it will finish either way, and nothing ever
  // answers an advisory question, so the hold was permanent.
  test("an advisory question does not halt a mission that parked for another reason", () => {
    const state = aMissionState({
      mission: aMission({
        status: "blocked",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask()],
      inbox: [
        {
          id: "secret-STRIPE_SECRET_KEY",
          kind: "question",
          advisory: true,
          summary: "The design needs STRIPE_SECRET_KEY … it will finish either way.",
          openedAt: "2026-07-25T11:00:00.000Z",
        },
      ],
    });

    assert.equal(continuationFor(state).kind, "loop");
  });

  // The other direction, and the reason the status disjunct cannot simply be deleted:
  // the reset-cap escalation blocks every task that is not `done`, which is `[]` when
  // they all are. Nothing parks on it, so `blockedBy` is empty — the mission status is
  // the only thing left that catches it, and resuming past it runs on regardless of the
  // question the escalation exists to ask.
  test("a reset-cap escalation blocking no task still halts", () => {
    const state = aMissionState({
      mission: aMission({
        status: "blocked",
        ledger: planned(),
        signedOffAt: "2026-07-25T10:05:00.000Z",
      }),
      tasks: [aCodeTask({ status: "done" })],
      inbox: [
        {
          id: "escalation-r6",
          kind: "question",
          summary: "This mission has replanned 3 times. Narrower goal, or different approach?",
          openedAt: "2026-07-25T11:00:00.000Z",
        },
      ],
    });

    assert.equal(continuationFor(state).kind, "halted");
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

    // Already signed off *and* waiting for sign-off is only reachable one way: a
    // replan asking to edit a frozen criterion (§3). It goes to the diff screen, not
    // to the initial one.
    assert.equal(continuationFor(state).kind, "criteriaChange");
  });

  // The same status, one field apart, and it must not route to the same place: a
  // mission that has never been approved is at its first sign-off, and resume is how
  // a human comes back to one left overnight.
  test("an unsigned mission waiting for sign-off is presented, not treated as a diff", () => {
    const state = aMissionState({
      mission: aMission({ status: "awaiting_signoff", ledger: planned() }),
    });

    assert.equal(continuationFor(state).kind, "signoff");
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
    estimate: { taskCount: 1, wallMs: 60_000, expectedGates: 0 },
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
  // `agents` is not decoration here: the transports offered to synthesis are computed
  // from it (§7, defect 21), so a fixture claiming an empty PATH is a machine that can
  // staff nothing — which is a real state, asserted below, and not the one these
  // tests are about.
  // `stateDir` is a real directory, not a fixture path: a dispatch creates the task's
  // artifact directory under it before a worker with no worktree runs (P2), so a
  // `/state` that does not exist fails every dispatch on the mkdir instead of on the
  // thing being asserted.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-execute-"));
  const config = { cwd: "/repo", stateDir, worktreeRoot: "/wt", agents: ["claude"], orchestratorModel: "opus", maxConcurrency: 4 } satisfies DiscoveredConfig;

  function harness(seed: EventInput[], against: DiscoveredConfig = config, human?: HumanPort) {
    const store = testStore(seed);
    const lines: string[] = [];
    const dispatched: string[] = [];

    const calls: Calls = {
      research: async () => {
        throw new Error("resume does not research a mission that already has a plan");
      },
      architect: async () => {
        throw new Error("resume does not re-architect a mission that already has a spec");
      },
      critique: async () => ({ objections: [] }),
      intake: async () => {
        throw new Error("intake ran before the plan existed; resume does not repeat it");
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
          config: against,
          io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
          buildLoop,
          ...(human ? { human } : {}),
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

  // Promotion has no natural caller — the loop has ended and nothing reads what is
  // written until a later mission recalls it — which is exactly the shape of a
  // mechanism that gets built and switched off (defects 12b, 23, 24). So it is
  // asserted here, at the composition root both `run` and `resume` end in, rather
  // than only against `recordLearnings`.
  describe("the write-back to memory", () => {
    const learned = (): EventInput[] => [
      ...planOnlyMission(),
      {
        ...orchestrator,
        type: "ledger_revised",
        reason: "research",
        ledger: {
          ...emptyLedger(),
          criteria: [aCriterion()],
          plan: [aPlannedTask()],
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
    ];

    test("a completed mission leaves its facts in the lore store, with an event naming each file", async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-exec-"));
      try {
        const h = harness(learned(), { ...config, stateDir });

        const { code } = await h.run();

        assert.equal(code, 0);
        const written = h.store.inputs.filter((event) => event.type === "memory_written");
        assert.equal(written.length, 1);
        const { fresh } = readLore(path.join(stateDir, "lore"), new Date());
        assert.deepEqual(fresh.map((entry) => entry.claim), ["routes live in src/routes"]);
        assert.equal(fresh[0]?.source.missionId, "m1");
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });

    // Resume continues a mission; it does not re-open the one blocking call that
    // already happened. A second recall here would double every memory fact in the
    // ledger on every restart.
    test("continuing a mission never re-consults memory", async () => {
      const h = harness(learned());

      await h.run();

      assert.equal(h.store.inputs.some((event) => event.type === "memory_recalled"), false);
    });
  });

  // The composition-root lesson, a fourth time (defects 12b, 23, 24): `profiles` is an
  // optional dep, which is exactly the shape of a feature that gets finished and
  // switched off. The mechanism is asserted in synthesize.test.ts; what is asserted
  // here is that something actually loads them off disk on the path a real mission
  // takes — through the real `buildLoopDeps`, with only dispatch stubbed.
  test("a promoted profile on disk reaches the synthesize call", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-profiles-exec-"));
    try {
      saveProfile(stateDir, {
        name: "invoice-reconciler",
        spec: anAgentSpec({ role: "invoice-reconciler" }),
        promotedFrom: { missionId: "m0", taskId: "t7" },
        promotedAt: "2026-08-01T10:00:00.000Z",
      });

      const store = testStore(planOnlyMission());
      const seen: { roster?: unknown }[] = [];
      const calls: Calls = {
        research: async () => {
          throw new Error("resume does not research a mission that already has a plan");
        },
        architect: async () => {
          throw new Error("resume does not re-architect a mission that already has a spec");
        },
        critique: async () => ({ objections: [] }),
        intake: async () => {
          throw new Error("intake ran before the plan existed");
        },
        plan: async () => ({ tasks: [aPlannedTask()] }),
        synthesize: async (input) => {
          seen.push(input);
          return anAgentSpec();
        },
        progress: async () => aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }),
        judge: async () => {
          throw new Error("the criterion carries a command check");
        },
      };

      await executeMission({
        store,
        calls: () => calls,
        config: { ...config, stateDir },
        io: { out: () => {}, err: () => {} },
        // The real wiring, with only the worker replaced: a stubbed `buildLoop` would
        // assert nothing about what the entry point builds.
        buildLoop: async (loopStore, loopCalls, loopConfig) => ({
          ...(await buildLoopDeps(loopStore, loopCalls, loopConfig)),
          checkCriterion: async () => ({
            met: true,
            evidence: { artifactIds: [], checkOutput: "ok", reasoning: "the check passed", byTask: [] },
          }),
          dispatch: async (task: Task) => {
            const base = { missionId: "m1", taskId: task.id, actor: "orchestrator" as const };
            loopStore.emit({ ...base, type: "task_status", from: task.status, to: "running", reason: "dispatched" });
            loopStore.emit({ ...base, actor: "worker", type: "worker_report", report: aReport() });
            loopStore.emit({ ...base, type: "task_status", from: "running", to: "done", reason: "verified" });
            return { status: "done" };
          },
        }),
      });

      assert.equal(seen.length > 0, true);
      // Resume staffs through the same index `run` does: the shipped roster and the
      // promoted profile, merged. One path wired and the other not is the shape of
      // defects 12b, 23 and 24.
      const roster = String(seen[0]!.roster ?? "");
      assert.match(roster, /invoice-reconciler/);
      assert.match(roster, /code-reviewer/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // The same lesson a fifth time. `routeTransport` is what owns the transport id now,
  // and a router that no entry point builds is a router that never refuses anything:
  // the `cli` transport would go on answering for ids it is not, which is the shape
  // defect 21 took. So this asserts the wiring, not the mechanism.
  test("the dispatch built by the entry point routes on the transport id", async () => {
    const store = testStore(planOnlyMission());
    const calls = {} as Calls;
    const deps = await buildLoopDeps(store, calls, config);

    const task = aCodeTask({ agentSpec: anAgentSpec({ transport: { id: "chrome-mcp" } }) });
    const outcome = await deps.dispatch!(task, aMissionState());

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.message : "", /'chrome-mcp' is not built/);
    assert.match(outcome.status === "failed" ? outcome.message : "", /this build ships cli/);
  });

  // Defect 32 was not a missing wire, and this is here so it stays that way: a real
  // mission produced no `criterion_checked` at all, and "the checker was never built"
  // is the first thing to rule out when it happens again. The `cwd` matters as much
  // as the checker — a criterion is about the outcome, so its command runs in the
  // repo the work merged into and never in a worktree that no longer exists (§4).
  test("the entry point builds a criterion checker that runs in the repo", async () => {
    const store = testStore(planOnlyMission());
    const deps = await buildLoopDeps(store, {} as Calls, { ...config, cwd: process.cwd() });

    assert.equal(deps.cwd, process.cwd());
    const result = await deps.checkCriterion!(
      aCriterion({ check: { kind: "command", command: "node --version" } }),
      { tasks: [], cwd: deps.cwd! },
    );

    assert.equal(result.met, true);
    assert.match(result.evidence.checkOutput, /exit 0/);
  });

  // PLAN-NEXT 7.3, composition root. `secrets` is an optional field on two `Deps`
  // interfaces, which is precisely the shape in which `requestExtension`, `owns` and
  // `reformat` were each built, tested and left switched off (defects 12b, 23, 24). Here
  // the cost of that would be a scrubber that passes its own unit tests while every real
  // mission writes the key to disk — so this reads the wiring, through the real
  // `buildLoopDeps`, with a granted variable actually in the environment.
  test("the entry point hands the granted values to the checker that writes evidence", async () => {
    const KEY = "sk_live_wired_9d8f7a6b";
    const previous = process.env.ORCHESTRA_TEST_SECRET;
    process.env.ORCHESTRA_TEST_SECRET = KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-wired-"));

    try {
      const store = testStore([
        missionCreated({
          envelope: anEnvelope({ env: ["ORCHESTRA_TEST_SECRET"] }),
        } as Partial<EventInput>),
        ...planOnlyMission().slice(1),
      ]);
      const deps = await buildLoopDeps(store, {} as Calls, { ...config, cwd: process.cwd() });

      const result = await deps.checkCriterion!(
        aCriterion({
          check: { kind: "command", command: "node -p process.env.ORCHESTRA_TEST_SECRET" },
        }),
        { tasks: [], cwd: deps.cwd!, evidenceDir: dir },
      );

      // The check prints the granted value itself, which is the worst case and the real
      // one: a test command that echoes an environment it was given. It is gone from the
      // field the event carries and from the file the loop keeps.
      assert.equal(result.met, true);
      assert.match(result.evidence.checkOutput, /\[redacted:ORCHESTRA_TEST_SECRET\]/);
      assert.equal(result.evidence.checkOutput.includes(KEY), false);
      const kept = fs.readFileSync(path.join(dir, "criterion-c1.txt"), "utf8");
      assert.equal(kept.includes(KEY), false, "the granted value is in the evidence file");
    } finally {
      if (previous === undefined) delete process.env.ORCHESTRA_TEST_SECRET;
      else process.env.ORCHESTRA_TEST_SECRET = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // P2, composition root. The artifact directory is a contract with two ends — a
  // worker is told where to write and a check is told where to look — and both are
  // optional fields, which is the shape a feature gets finished and switched off in.
  test("the entry point gives the loop an artifact root under the mission's own state", async () => {
    const store = testStore(planOnlyMission());
    const deps = await buildLoopDeps(store, {} as Calls, config);

    assert.equal(deps.artifactRoot, path.join(stateDir, "missions", "m1", "artifacts"));
  });

  // The end a worker sees. A dispatch that computed a root and never handed it over
  // would leave every non-code task exactly where defect 41 left it: obliged to
  // produce a file and with nowhere legal to put one.
  test("the dispatch it builds creates the task's directory and tells the worker", async () => {
    const store = testStore(planOnlyMission());
    const deps = await buildLoopDeps(store, {} as Calls, config);

    // `chrome-mcp` is unbuilt, so the router refuses before any worker runs — but the
    // directory is created ahead of the transport, which is what this reads.
    await deps.dispatch!(
      aCodeTask({ id: "t-root", agentSpec: anAgentSpec({ transport: { id: "chrome-mcp" } }) }),
      aMissionState(),
    );

    const dir = path.join(stateDir, "missions", "m1", "artifacts", "t-root");
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  // PLAN-NEXT 5.2, and the same composition-root lesson: the design note is an optional
  // field on `DispatchDeps` and another on the transport's input, which is twice the
  // shape a feature gets finished and switched off in. `dispatchOptionsFor` exists so
  // that decision is assertable without spawning a worker.
  describe("the design note reaches dispatch", () => {
    const bare: DispatchDeps = {
      emit: () => {},
      transport: async () => ({ raw: "{}", elapsedMs: 1 }),
      verify: async () => ({ passed: true, output: "", spec: { kind: "none", reason: "n/a" } }),
    };

    test("a mission with a note hands the dispatch its path", () => {
      const options = dispatchOptionsFor(bare, {}, { path: "/state/m1/artifacts/design.md" });

      assert.equal(options.designNote, "/state/m1/artifacts/design.md");
    });

    // A quick mission has no architect and no note, and a worker is told nothing about
    // one rather than being handed an empty string to open.
    test("a mission without one carries no field at all", () => {
      assert.equal("designNote" in dispatchOptionsFor(bare, {}), false);
    });

    // And the value comes off the fold, which is what makes a resumed mission give its
    // workers the same path the run that planned it would have.
    test("the entry point reads it from the folded log", async () => {
      const store = testStore([
        ...planOnlyMission(),
        {
          missionId: "m1",
          actor: "orchestrator",
          type: "design_written",
          path: "/state/missions/m1/artifacts/design.md",
          summary: "# Design",
        },
      ]);

      const deps = await buildLoopDeps(store, {} as Calls, config);

      assert.ok(deps.dispatch);
      assert.equal(store.state().design?.path, "/state/missions/m1/artifacts/design.md");
    });
  });

  // P5, and the composition-root lesson again (defects 12b, 23, 24): the janitor is an
  // optional field on `DispatchDeps`, which is exactly the shape of a mechanism that
  // is built, unit-tested, and reachable only through a parameter nobody passes. The
  // gate itself is asserted in dispatch.test.ts; what is asserted here is that a
  // discovered command actually arrives.
  describe("the project's own check reaches dispatch", () => {
    test("a discovered verify command is passed to the dispatch", () => {
      const options = dispatchOptionsFor(
        { emit: () => {}, transport: async () => ({ raw: "", elapsedMs: 0 }), verify: async () => ({ passed: true, output: "" }) },
        { verify: { command: "npm test", source: "package.json test script" } },
      );

      assert.deepEqual(options.repoVerify, {
        command: "npm test",
        source: "package.json test script",
      });
    });

    // Absent means no gate, not a default. A project with no check of its own is a
    // supported configuration, and `npm test` invented for one would fail every task.
    test("no discovered command means no janitor, rather than an invented one", () => {
      const options = dispatchOptionsFor(
        { emit: () => {}, transport: async () => ({ raw: "", elapsedMs: 0 }), verify: async () => ({ passed: true, output: "" }) },
        {},
      );

      assert.equal("repoVerify" in options, false);
    });
  });

  // The same lesson a sixth time, and this one has teeth: the ACP permission port is
  // an optional dependency of an optional dependency. A build that routes `acp` but
  // hands its transport no port would deny — or worse, allow — every mid-run request
  // without a human hearing about it, which is defect 14 surviving the phase that was
  // supposed to close it.
  test("the entry point builds an acp transport, so an acp task reaches it", async () => {
    const store = testStore(planOnlyMission());
    const deps = await buildLoopDeps(store, {} as Calls, config);

    const task = aCodeTask({
      agentSpec: anAgentSpec({ transport: { id: "acp", target: "nobody-ships-this" } }),
    });
    const outcome = await deps.dispatch!(task, aMissionState());

    // It failed inside the acp transport (which names its targets), not at the router.
    assert.equal(outcome.status, "failed");
    const message = outcome.status === "failed" ? outcome.message : "";
    assert.doesNotMatch(message, /'acp' is not built/);
    assert.match(message, /nobody-ships-this/);
  });

  // Defect 21, one layer out, and the same composition-root lesson again: the offer
  // synthesis is given has to describe *this machine*, not the build. A laptop with no
  // coding CLI cannot start an ACP adapter — the adapter is a shim over `claude` or
  // `codex` — so offering `acp` there staffs every task with a transport that dies at
  // dispatch, burns its retry, and takes a replan with it. `availableTransports` is
  // unit-tested; what is asserted here is that the entry point actually calls it.
  test("the loop is offered no acp transport when no coding CLI was probed", async () => {
    const store = testStore(planOnlyMission());

    const deps = await buildLoopDeps(store, {} as Calls, { ...config, agents: [] });

    assert.deepEqual(deps.transports, []);
  });

  // The optional-`Deps` trap, for the card layer. `staffableCards` loads *and* narrows in
  // one call precisely so a root cannot wire half of it, but a root that calls neither is
  // the older failure — a feature finished and switched off at once. This asserts the
  // replan's root reaches the disk, and that an unprobed card never arrives.
  test("the loop is offered the cards this machine verified, and no others", async () => {
    const store = testStore(planOnlyMission());
    const card = {
      id: "deepseek-ai/DeepSeek-V3",
      provider: "nebius",
      access: "api-key",
      tier: "worker",
      contextK: 128,
      costInPer1M: 0.13,
      costOutPer1M: 0.4,
      verifiedBy: "probes/v3.json",
    };
    fs.mkdirSync(path.join(config.stateDir, "providers", "probes"), { recursive: true });
    fs.writeFileSync(
      path.join(config.stateDir, "providers", "nebius.json"),
      JSON.stringify([card, { ...card, id: "unprobed", verifiedBy: "probes/nope.json" }]),
    );
    fs.writeFileSync(path.join(config.stateDir, "providers", "probes", "v3.json"), "{}");

    const deps = await buildLoopDeps(store, {} as Calls, config);

    assert.deepEqual(deps.modelCards?.map((entry) => entry.id), ["deepseek-ai/DeepSeek-V3"]);
  });

  // PLAN-NEXT 3.3, and the composition-root half of it. `containmentFor` refuses rather
  // than returning "not contained", and that refusal is only worth anything if the root
  // actually calls it — a mission composed with a container, resumed on a machine that
  // has none, must stop here rather than quietly running every worker on the machine.
  test("a contained mission refuses to build a loop on a machine that cannot contain", async () => {
    const store = testStore([
      missionCreated({ envelope: anEnvelope({ containment: "container" }) }),
      ...planOnlyMission().slice(1),
    ]);

    await assert.rejects(
      () => buildLoopDeps(store, {} as Calls, { ...config, containers: [] }),
      /no container backend answering/,
    );
  });

  test("the loop is told which backends can contain, so synthesis can refuse early", async () => {
    const store = testStore(planOnlyMission());

    const deps = await buildLoopDeps(store, {} as Calls, {
      ...config,
      containers: ["docker"],
      containerImage: "org/worker",
    });

    assert.deepEqual(deps.containment, ["docker"]);
  });

  test("the loop is offered acp once a coding CLI with a pinned adapter is on PATH", async () => {
    const store = testStore(planOnlyMission());

    const deps = await buildLoopDeps(store, {} as Calls, { ...config, agents: ["claude"] });

    assert.deepEqual(deps.transports, ["cli", "acp"]);
  });

  test("the permission port asks the human the entry point was given", async () => {
    const store = testStore(planOnlyMission());
    const asked: string[] = [];
    const human: HumanPort = {
      askIntake: async () => [],
      awaitSignoff: async () => ({ kind: "approve" }),
      askPermission: async (request) => {
        asked.push(request.tool);
        return true;
      },
    };

    const port = permissionPortFor(store, human);
    const allowed = await port.requestPermission("t1", { tool: "Bash", detail: "npm ci" });

    assert.equal(allowed, true);
    assert.deepEqual(asked, ["Bash"]);
    assert.equal(store.inputs.some((e) => e.type === "permission_requested"), true);
    const resolved = store.inputs.find((e) => e.type === "permission_resolved");
    assert.ok(resolved && "approved" in resolved && resolved.approved === true);
  });

  // `--unattended` reaches here as an absent human, and a worker parked on nobody
  // costs the whole session (§9.4's shape: running out of a resource is an answer).
  test("with no human the port denies rather than parking a worker forever", async () => {
    const store = testStore(planOnlyMission());

    const allowed = await permissionPortFor(store).requestPermission("t1", {
      tool: "Bash",
      detail: "npm ci",
    });

    assert.equal(allowed, false);
    const resolved = store.inputs.find((e) => e.type === "permission_resolved");
    assert.ok(resolved && "reason" in resolved && /unattended/i.test(String(resolved.reason)));
  });

  test("executeMission hands the loop build the human, so the port has a surface", async () => {
    const store = testStore(planOnlyMission());
    const seen: (HumanPort | undefined)[] = [];
    const human: HumanPort = {
      askIntake: async () => [],
      awaitSignoff: async () => ({ kind: "approve" }),
      askPermission: async () => true,
    };

    await executeMission({
      store,
      calls: () => ({ plan: async () => ({ tasks: [aPlannedTask()] }), synthesize: async () => anAgentSpec(), progress: async () => aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] }) }) as unknown as Calls,
      config,
      io: { out: () => {}, err: () => {} },
      human,
      buildLoop: async (loopStore, loopCalls, _config, _onWarn, loopHuman) => {
        seen.push(loopHuman);
        return {
          store: loopStore,
          calls: loopCalls,
          cwd: "/repo",
          checkCriterion: async () => ({
            met: true,
            evidence: { artifactIds: [], checkOutput: "ok", reasoning: "the check passed", byTask: [] },
          }),
          dispatch: async () => ({ status: "done" }),
        };
      },
    });

    assert.deepEqual(seen, [human]);
  });

  // Defect 29, at the composition root it was found in. The mechanism is asserted in
  // `loop/criteriaChange.test.ts`; what is asserted here is that both entry points
  // actually reach it — the defect was that neither did, on a mission where the
  // freeze had done its job and the dashboard was attached and never consulted.
  describe("a replan that wants to change the contract", () => {
    const amended = aCriterion({ statement: "GET /health returns 200 and a build sha" });

    /** Where `resume` finds a mission a replan reopened: the request on the log, the
     *  status back at `awaiting_signoff`, and nothing able to answer it. */
    const reopened = (unattended = false): EventInput[] => [
      ...planOnlyMission(),
      { ...orchestrator, type: "signoff_granted", unattended },
      { ...orchestrator, type: "task_planned", task: aCodeTask() },
      { ...orchestrator, type: "mission_status", from: "specifying", to: "executing", reason: "approved" },
      {
        ...orchestrator,
        type: "criteria_change_requested",
        diff: [
          {
            op: "amend",
            criterionId: aCriterion().id,
            from: aCriterion(),
            to: amended,
            reason: "no plan can meet c1 without the sha",
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

    const answering = (decision: "approve" | string): HumanPort & { asked: number } => {
      const port = {
        asked: 0,
        askIntake: async () => [],
        awaitSignoff: async () => {
          port.asked++;
          return decision === "approve"
            ? ({ kind: "approve" } as const)
            : ({ kind: "revise", feedback: decision } as const);
        },
      };
      return port;
    };

    test("resume approves it, applies the diff, and carries on running the mission", async () => {
      const human = answering("approve");
      const h = harness(reopened(), config, human);

      const { code } = await h.run();

      assert.equal(human.asked, 1);
      assert.equal(h.store.state().mission.ledger.criteria[0]?.statement, amended.statement);
      assert.equal(h.store.inputs.some((e) => e.type === "criteria_change_resolved"), true);
      // The loop ran rather than the command exiting on the park, which is the whole
      // of defect 29.
      assert.deepEqual(h.dispatched, ["t1"]);
      assert.equal(code, 0);
    });

    test("rejecting it keeps the signed-off criteria, records the dead end, and still runs", async () => {
      const human = answering("c1 stands; the sha is a separate mission");
      const h = harness(reopened(), config, human);

      const { code } = await h.run();

      const state = h.store.state();
      assert.equal(state.mission.ledger.criteria[0]?.statement, aCriterion().statement);
      assert.equal(state.mission.ledger.deadEnds.length, 1);
      assert.deepEqual(h.dispatched, ["t1"]);
      assert.equal(code, 0);
    });

    // §3: a flag that skips reading the plan is a reasonable trade; one that lets an
    // unwatched mission rewrite its own contract is not.
    test("under --unattended it stays parked and nobody is asked", async () => {
      const human = answering("approve");
      const h = harness(reopened(true), config, human);

      const { code } = await h.run();

      assert.equal(human.asked, 0);
      assert.equal(code, 1);
      assert.deepEqual(h.dispatched, []);
      assert.equal(h.store.inputs.some((e) => e.type === "criteria_change_resolved"), false);
      assert.match(h.lines.join("\n"), /--unattended/);
    });

    test("with no human at all it parks rather than approving its own change", async () => {
      const h = harness(reopened());

      const { code } = await h.run();

      assert.equal(code, 1);
      assert.equal(h.store.inputs.some((e) => e.type === "criteria_change_resolved"), false);
      assert.deepEqual(h.dispatched, []);
    });
  });

  // The other half of the same defect: `run` never returns to `continuationFor`, so
  // the reopen it hits is the one the loop raises mid-flight. It has to be answered
  // there too, or an attended `orchestra run` exits on the park exactly as `resume`
  // did.
  test("a mission reopened mid-loop is answered and the loop resumes", async () => {
    const store = testStore([
      ...planOnlyMission(),
      { ...orchestrator, type: "signoff_granted", unattended: false },
      { ...orchestrator, type: "task_planned", task: aCodeTask() },
      { ...orchestrator, type: "mission_status", from: "specifying", to: "executing", reason: "approved" },
    ]);

    const relaxed = aCriterion({ statement: "GET /health returns anything at all" });
    let planCall = 0;
    let progressCall = 0;
    const calls: Calls = {
      research: async () => {
        throw new Error("no research in the loop");
      },
      architect: async () => {
        throw new Error("no architect in the loop");
      },
      critique: async () => ({ objections: [] }),
      intake: async () => {
        throw new Error("no intake in the loop");
      },
      // The first replan asks to relax the criterion; once that is settled it plans
      // within the contract.
      plan: async () => {
        planCall++;
        return planCall === 1
          ? { tasks: [aPlannedTask({ id: "t2" })], criteria: [relaxed] }
          : { tasks: [aPlannedTask({ id: "t2" })] };
      },
      synthesize: async () => anAgentSpec(),
      progress: async () => {
        progressCall++;
        return progressCall === 1
          ? aProgressLedger({ isInLoop: true })
          : aProgressLedger({ isRequestSatisfied: true, unmetCriteria: [] });
      },
      judge: async () => {
        throw new Error("the criterion carries a command check");
      },
    };

    const human: HumanPort & { asked: number } = {
      asked: 0,
      askIntake: async () => [],
      awaitSignoff: async () => {
        human.asked++;
        return { kind: "approve" };
      },
    };

    const lines: string[] = [];
    const { code } = await executeMission({
      store,
      calls: () => calls,
      config,
      io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      human,
      buildLoop: async (loopStore, loopCalls) => ({
        store: loopStore,
        calls: loopCalls,
        cwd: "/repo",
        checkCriterion: async () => ({
          met: true,
          evidence: { artifactIds: [], checkOutput: "ok", reasoning: "the check passed", byTask: [] },
        }),
        dispatch: async (task: Task) => {
          const base = { missionId: "m1", taskId: task.id, actor: "orchestrator" as const };
          loopStore.emit({ ...base, type: "task_status", from: task.status, to: "running", reason: "dispatched" });
          loopStore.emit({ ...base, actor: "worker", type: "worker_report", report: aReport() });
          loopStore.emit({ ...base, type: "task_status", from: "running", to: "done", reason: "verified" });
          return { status: "done" };
        },
      }),
    });

    assert.equal(human.asked, 1);
    assert.equal(store.state().mission.ledger.criteria[0]?.statement, relaxed.statement);
    assert.equal(code, 0);
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

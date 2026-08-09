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
import { buildLoopDeps, continuationFor, executeMission } from "./execute.js";
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

  function harness(seed: EventInput[], against: DiscoveredConfig = config) {
    const store = testStore(seed);
    const lines: string[] = [];
    const dispatched: string[] = [];

    const calls: Calls = {
      research: async () => {
        throw new Error("resume does not research a mission that already has a plan");
      },
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
      const seen: { profiles?: unknown }[] = [];
      const calls: Calls = {
        research: async () => {
          throw new Error("resume does not research a mission that already has a plan");
        },
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
      assert.deepEqual(seen[0]!.profiles, [anAgentSpec({ role: "invoice-reconciler" })]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
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

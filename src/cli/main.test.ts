// The command surface, tested end to end against a real state directory. `run` is
// the one command that cannot work yet, and it says so rather than failing obscurely.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { main, type Io } from "./main.js";
import { createEventLog } from "../events/log.js";
import { missionDir } from "../config/discover.js";
import { emptyLedger } from "../domain/ledger.js";
import {
  aCodeTask,
  aCriterion,
  aMission,
  aMissionState,
  anEnvelope,
  anAgentSpec,
  aPlannedTask,
  aProgressLedger,
  fixedClock,
  missionCreated,
} from "../testing/fixtures.js";
import { type EventInput } from "../events/schema.js";
import { type Calls } from "../loop/calls.js";
import { writeLore } from "../memory/lore.js";
import { parseProfile, saveProfile } from "../memory/profiles.js";
import { parseSavedMission, saveMission } from "../memory/savedMission.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-cli-"));
let stateDir: string;
let caseNo = 0;

function capture(): Io & { out: (line: string) => void; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { out: (l) => lines.push(l), err: (l) => errors.push(l), lines, errors };
}

beforeEach(() => {
  stateDir = path.join(tmpRoot, `case-${++caseNo}`);
  process.env.ORCHESTRA_STATE_DIR = stateDir;
});

after(() => {
  delete process.env.ORCHESTRA_STATE_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const orchestrator = { missionId: "m1", actor: "orchestrator" } as const;

/** Whatever the one mission in this case's state directory actually wrote. Read back
 *  off disk rather than from a store, because the wiring is what is under test. */
function loggedEvents(): { type: string; [key: string]: unknown }[] {
  const missions = fs.readdirSync(path.join(stateDir, "missions"));
  assert.equal(missions.length, 1);
  return fs
    .readFileSync(path.join(stateDir, "missions", missions[0]!, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
}

function seedMission(inputs: EventInput[] = []): void {
  const log = createEventLog(missionDir(stateDir, "m1"), { now: fixedClock() });
  log.appendAll([missionCreated(), ...inputs]);
}

describe("orchestra", () => {
  test("prints usage with no arguments and exits 0", async () => {
    const io = capture();

    assert.equal(await main([], io), 0);
    assert.match(io.lines.join("\n"), /orchestra doctor/);
  });

  test("rejects an unknown command with the usage text", async () => {
    const io = capture();

    assert.equal(await main(["frobnicate"], io), 1);
    assert.match(io.errors.join("\n"), /Unknown command 'frobnicate'/);
  });

  describe("doctor", () => {
    test("reports what is installed and exits on readiness", async () => {
      const io = capture();

      const code = await main(["doctor"], io);

      const report = io.lines.join("\n");
      assert.match(report, /node/);
      assert.match(report, /workers/);
      assert.equal(code === 0 || code === 1, true);
    });
  });

  describe("forget", () => {
    test("deletes everything a mission wrote", async () => {
      seedMission();
      const io = capture();

      assert.equal(await main(["forget", "m1"], io), 0);
      assert.equal(fs.existsSync(missionDir(stateDir, "m1")), false);
    });

    test("says so plainly when there is nothing to delete", async () => {
      const io = capture();

      assert.equal(await main(["forget", "ghost"], io), 0);
      assert.match(io.lines.join("\n"), /Nothing stored/);
    });

    test("needs a mission id", async () => {
      assert.equal(await main(["forget"], capture()), 1);
    });
  });

  describe("save", () => {
    const signedOff: EventInput[] = [
      {
        ...orchestrator,
        type: "outcome_spec_written",
        criteria: [aCriterion()],
        guesses: [],
        outOfScope: [],
        estimate: { taskCount: 1, tokens: 0, wallMs: 1000, expectedGates: 0 },
      },
      { ...orchestrator, type: "signoff_granted", unattended: false },
    ];

    test("writes a replayable file and prints where it went", async () => {
      seedMission(signedOff);
      const io = capture();

      assert.equal(await main(["save", "m1", "--as", "monthly"], io), 0);

      const file = path.join(stateDir, "saved", "monthly.md");
      assert.equal(fs.existsSync(file), true);
      assert.equal(parseSavedMission(fs.readFileSync(file, "utf8")).ok, true);
      assert.match(io.lines.join("\n"), /monthly\.md/);
    });

    // §7: `--unattended --saved` rests on criteria a human approved.
    test("refuses a mission that never reached sign-off, with the fix", async () => {
      seedMission();
      const io = capture();

      assert.equal(await main(["save", "m1", "--as", "monthly"], io), 1);
      assert.match(io.errors.join("\n"), /sign-off/);
      assert.equal(fs.existsSync(path.join(stateDir, "saved")), false);
    });

    test("reports an unknown mission rather than saving an empty one", async () => {
      const io = capture();

      assert.equal(await main(["save", "ghost", "--as", "monthly"], io), 1);
      assert.match(io.errors.join("\n"), /No mission 'ghost'/);
    });

    test("needs both a mission id and --as <name>", async () => {
      assert.equal(await main(["save"], capture()), 1);
      assert.equal(await main(["save", "m1"], capture()), 1);
    });
  });

  // §7: promotion is explicit and human-initiated. There is deliberately no path that
  // promotes a role on its own — §6 refuses automatic learning, so the only way a
  // profile is written is a human typing this.
  describe("promote", () => {
    test("keeps the task's synthesized agent as a reusable profile", async () => {
      seedMission([
        {
          ...orchestrator,
          type: "task_planned",
          task: aCodeTask({ agentSpec: anAgentSpec({ role: "invoice-reconciler" }) }),
        },
      ]);
      const io = capture();

      assert.equal(await main(["promote", "m1", "t1", "--as", "reconciler"], io), 0);

      const file = path.join(stateDir, "profiles", "reconciler.md");
      const parsed = parseProfile(fs.readFileSync(file, "utf8"));
      assert.equal(parsed.ok, true);
      assert.equal(parsed.ok && parsed.profile.spec.role, "invoice-reconciler");
      assert.deepEqual(parsed.ok && parsed.profile.promotedFrom, {
        missionId: "m1",
        taskId: "t1",
      });
      assert.match(io.lines.join("\n"), /reconciler\.md/);
    });

    test("reports an unknown mission rather than writing an empty profile", async () => {
      const io = capture();

      assert.equal(await main(["promote", "ghost", "t1", "--as", "reconciler"], io), 1);
      assert.match(io.errors.join("\n"), /No mission 'ghost'/);
      assert.equal(fs.existsSync(path.join(stateDir, "profiles")), false);
    });

    test("an unknown task names the ones the mission actually has", async () => {
      seedMission([{ ...orchestrator, type: "task_planned", task: aCodeTask() }]);
      const io = capture();

      assert.equal(await main(["promote", "m1", "t9", "--as", "reconciler"], io), 1);
      assert.match(io.errors.join("\n"), /t9/);
      assert.match(io.errors.join("\n"), /t1/);
    });

    test("refuses a name that is really a path", async () => {
      seedMission([{ ...orchestrator, type: "task_planned", task: aCodeTask() }]);
      const io = capture();

      assert.equal(await main(["promote", "m1", "t1", "--as", "../escape"], io), 1);
      assert.match(io.errors.join("\n"), /not a profile name/);
    });

    test("needs a mission id, a task id, and --as <name>", async () => {
      assert.equal(await main(["promote"], capture()), 1);
      assert.equal(await main(["promote", "m1"], capture()), 1);
      assert.equal(await main(["promote", "m1", "t1"], capture()), 1);
    });
  });

  describe("resume", () => {
    test("reports an unknown mission rather than creating one", async () => {
      const io = capture();

      assert.equal(await main(["resume", "nope"], io), 1);
      assert.match(io.errors.join("\n"), /No mission 'nope'/);
    });

    test("replays the log and rebuilds both projections", async () => {
      seedMission();
      const io = capture();

      assert.equal(await main(["resume", "m1"], io), 0);

      const dir = missionDir(stateDir, "m1");
      assert.equal(fs.existsSync(path.join(dir, "mission.json")), true);
      assert.equal(fs.existsSync(path.join(dir, "tasks.json")), true);
    });

    test("reconciles an orphaned task and says what it did", async () => {
      seedMission([
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        {
          ...orchestrator,
          taskId: "t1",
          type: "task_status",
          from: "todo",
          to: "running",
          reason: "dispatched",
        },
      ]);
      const io = capture();

      await main(["resume", "m1"], io);

      assert.match(io.lines.join("\n"), /t1: running → todo/);
    });

    test("reports no orphans when nothing was in flight", async () => {
      seedMission();
      const io = capture();

      await main(["resume", "m1"], io);

      assert.match(io.lines.join("\n"), /no orphaned tasks/);
    });

    // Research is not checkpointed mid-flight, so a mission that died before it had
    // a plan is a new `run`, not a resume — and saying so beats silently paying for
    // a second research call.
    test("points at run when the mission never got a plan, without calling a model", async () => {
      seedMission();
      const io = capture();
      const refuse = (): Calls => {
        throw new Error("resume must not reach a model here");
      };

      assert.equal(await main(["resume", "m1"], io, { createCalls: refuse }), 0);
      assert.match(io.lines.join("\n"), /orchestra run/);
    });

    test("reports a finished mission instead of re-running it", async () => {
      seedMission([
        {
          ...orchestrator,
          type: "mission_status",
          from: "executing",
          to: "complete",
          reason: "criteria met",
        },
      ]);
      const io = capture();
      const refuse = (): Calls => {
        throw new Error("a complete mission needs no model");
      };

      assert.equal(await main(["resume", "m1"], io, { createCalls: refuse }), 0);
      assert.match(io.lines.join("\n"), /already complete/);
    });

    // Reconciliation is itself recorded, so a second resume is a no-op rather than
    // requeueing work the first one already requeued.
    test("a second resume finds nothing left to reconcile", async () => {
      seedMission([
        { ...orchestrator, type: "task_planned", task: aCodeTask() },
        {
          ...orchestrator,
          taskId: "t1",
          type: "task_status",
          from: "todo",
          to: "running",
          reason: "dispatched",
        },
      ]);
      await main(["resume", "m1"], capture());

      const io = capture();
      await main(["resume", "m1"], io);

      assert.match(io.lines.join("\n"), /no orphaned tasks/);
    });
  });

  describe("run", () => {
    const createCalls = (): Calls => ({
      intake: async () => ({ questions: [] }),
      research: async () => ({
        brief: "there is a router and no health route",
        findings: [
          { claim: "routes live in src/routes", source: "src/routes", sourceKind: "codebase", confidence: "high" },
        ],
        confidence: "high",
        criteria: [aCriterion()],
        outOfScope: [],
        guesses: [],
      }),
      plan: async () => ({ tasks: [aPlannedTask({ id: "t1" })] }),
      synthesize: async () => anAgentSpec(),
      progress: async () => aProgressLedger(),
      judge: async () => {
        throw new Error("not reached under --plan-only");
      },
    });

    test("needs a goal", async () => {
      const io = capture();

      assert.equal(await main(["run"], io), 1);
      assert.match(io.errors.join("\n"), /Usage: orchestra run/);
    });

    // §17: a flag that skips reading the plan must never become the habitual default.
    test("refuses --unattended without --saved or --force", async () => {
      const io = capture();

      assert.equal(await main(["run", "a goal", "--unattended"], io), 1);
      assert.match(io.errors.join("\n"), /--saved/);
      assert.match(io.errors.join("\n"), /--force/);
    });

    test("rejects an unknown flag rather than ignoring it", async () => {
      const io = capture();

      assert.equal(await main(["run", "a goal", "--yolo"], io), 1);
      assert.match(io.errors.join("\n"), /Unknown flag '--yolo'/);
    });

    // Defect 36 at the composition root, which is the half that was actually missing:
    // `resilientCalls` retries and parks, and a mission only gets either if the entry
    // point wraps the calls it built. The mechanism being tested elsewhere is exactly
    // the shape defects 12b, 23 and 24 had — finished, and switched off by a wiring
    // nobody asserted.
    test("a decision point that keeps failing is retried, then parks the mission", async () => {
      const io = capture();
      let attempts = 0;

      const code = await main(["run", "a goal", "--plan-only", "--no-web"], io, {
        resilience: { sleep: async () => {} },
        createCalls: () => ({
          ...createCalls(),
          research: async () => {
            attempts++;
            throw new Error("429 rate_limit_error");
          },
        }),
      });

      assert.equal(code, 1);
      assert.equal(attempts, 2, "the entry point wrapped the calls, so §9.4's retry ran");
      // Parked, not crashed: the message names the call and the way back in.
      assert.match(io.errors.join("\n"), /'research' decision point failed/);
      assert.match(io.errors.join("\n"), /orchestra resume/);
      assert.ok(
        loggedEvents().some((event) => event.type === "mission_status" && event.to === "blocked"),
        "the park is on the log, so the state on disk means something to resume",
      );
    });

    describe("--saved", () => {
      /** A saved mission on disk, written the way `orchestra save` writes one. */
      function seedSaved(name = "monthly"): void {
        saveMission(
          stateDir,
          name,
          aMissionState({
            mission: aMission({
              goal: "reconcile June invoices",
              capabilityEnvelope: anEnvelope({ domains: ["xero.com"] }),
              signedOffAt: "2026-08-09T09:00:00.000Z",
              ledger: {
                ...emptyLedger(),
                factsGiven: [{ id: "h1", text: "Does June mean calendar? — calendar", addedRound: 0 }],
                criteria: [
                  aCriterion({ id: "c1", statement: "every invoice matched", met: true }),
                ],
              },
            }),
            inbox: [
              {
                id: "q1",
                kind: "intake",
                summary: "Does June mean calendar?",
                openedAt: "2026-08-09T08:00:00.000Z",
                resolvedAt: "2026-08-09T08:01:00.000Z",
              },
            ],
          }),
          "2026-08-09T10:00:00.000Z",
        );
      }

      /** Calls that count what a replay actually asks for. */
      function countingCalls() {
        const research: string[] = [];
        const intakeKnown: string[][] = [];
        const calls: Calls = {
          ...createCalls(),
          research: async (input) => {
            research.push(input.depth);
            return {
              brief: "fresh research",
              findings: [],
              confidence: "high",
              // `c1` because the scripted plan's tasks satisfy `c1`, and a plan that
              // leaves a criterion to no task is refused (defect 32). The statement is
              // what this test is about; the id has to be one the plan covers.
              criteria: [aCriterion({ id: "c1", statement: "researched afresh" })],
              outOfScope: [],
              guesses: [],
            };
          },
          intake: async (input) => {
            intakeKnown.push(input.known);
            return { questions: [] };
          },
        };
        return { calls, research, intakeKnown };
      }

      // §7: a replay re-runs scan and research every time, because the environment
      // moved since March even if the job did not. The adversarial half is that the
      // saved criteria must not be a shortcut past either call.
      test("still runs the scan and the research call rather than reusing the outcome", async () => {
        seedSaved();
        const io = capture();
        const { calls, research } = countingCalls();

        const code = await main(["run", "--saved", "monthly", "--plan-only"], io, {
          createCalls: () => calls,
        });

        assert.equal(code, 0);
        assert.deepEqual(research, ["scan", "deep"]);
        // The criteria on the log are this run's, not the skeleton's.
        const spec = loggedEvents().find((event) => event.type === "outcome_spec_written") as
          | { criteria: { statement: string }[] }
          | undefined;
        assert.deepEqual(spec?.criteria.map((c) => c.statement), ["researched afresh"]);
      });

      test("takes the goal and the envelope from the saved mission", async () => {
        seedSaved();
        const io = capture();
        const { calls } = countingCalls();

        await main(["run", "--saved", "monthly", "--plan-only"], io, { createCalls: () => calls });

        const created = loggedEvents().find((event) => event.type === "mission_created") as
          | { goal: string; envelope: { domains: string[] } }
          | undefined;
        assert.equal(created?.goal, "reconcile June invoices");
        assert.deepEqual(created?.envelope.domains, ["xero.com"]);
      });

      test("an explicit goal overrides the saved one", async () => {
        seedSaved();
        const io = capture();
        const { calls } = countingCalls();

        await main(["run", "reconcile July invoices", "--saved", "monthly", "--plan-only"], io, {
          createCalls: () => calls,
        });

        const created = loggedEvents().find((event) => event.type === "mission_created") as
          | { goal: string }
          | undefined;
        assert.equal(created?.goal, "reconcile July invoices");
      });

      // Last time's answers are `factsGiven` — the tier a replan may never drop (§3)
      // — which is also the list intake reads, so nobody is asked twice.
      test("seeds last time's intake answers so the same question is not asked again", async () => {
        seedSaved();
        const io = capture();
        const { calls, intakeKnown } = countingCalls();

        await main(["run", "--saved", "monthly", "--plan-only"], io, { createCalls: () => calls });

        assert.deepEqual(intakeKnown, [["Does June mean calendar? — calendar"]]);
      });

      test("a saved mission that does not exist says how to create one", async () => {
        const io = capture();

        const code = await main(["run", "--saved", "ghost", "--plan-only"], io, { createCalls });

        assert.equal(code, 1);
        assert.match(io.errors.join("\n"), /orchestra save <missionId> --as ghost/);
      });

      test("--saved needs a name", async () => {
        const io = capture();

        assert.equal(await main(["run", "a goal", "--saved"], io), 1);
        assert.match(io.errors.join("\n"), /--saved takes a name/);
      });

      // §7 couples the two deliberately: the easy path to skipping sign-off is a
      // mission whose criteria a human already approved.
      test("permits --unattended without --force", async () => {
        seedSaved();
        const io = capture();
        const { calls } = countingCalls();

        const code = await main(["run", "--saved", "monthly", "--unattended", "--plan-only"], io, {
          createCalls: () => calls,
        });

        assert.equal(code, 0);
      });
    });

    // The other composition root. `resume` staffs an approved plan through
    // `executeMission`; `run` staffs it inside `prepareMission`, and wiring one and
    // not the other leaves the feature switched off on the path most missions take
    // (defects 12b, 23, 24). The scripted synthesizer names a transport that does not
    // exist, so the mission parks after recording its input rather than dispatching.
    test("a promoted profile reaches the synthesize call on a fresh run", async () => {
      saveProfile(stateDir, {
        name: "invoice-reconciler",
        spec: anAgentSpec({ role: "invoice-reconciler" }),
        promotedFrom: { missionId: "m0", taskId: "t7" },
        promotedAt: "2026-08-01T10:00:00.000Z",
      });
      const seen: { profiles?: unknown }[] = [];
      const calls: Calls = {
        ...createCalls(),
        synthesize: async (input) => {
          seen.push(input);
          // A transport no build ships (Phase 8), so the mission parks after
          // recording the input whatever this machine has on PATH — `acp` is offered
          // for real now wherever a coding CLI was probed.
          return anAgentSpec({ transport: { id: "chrome-mcp" } });
        },
      };

      const code = await main(
        ["run", "add a /health endpoint", "--unattended", "--force", "--no-web"],
        capture(),
        { createCalls: () => calls },
      );

      assert.equal(code, 1);
      assert.deepEqual(seen[0]?.profiles, [anAgentSpec({ role: "invoice-reconciler" })]);
    });

    test("--unattended --force still starts without a saved mission", async () => {
      const io = capture();

      const code = await main(["run", "a goal", "--unattended", "--force", "--plan-only"], io, {
        createCalls,
      });

      assert.equal(code, 0);
    });

    describe("--plan-only", () => {
      test("prints a spec, a plan, and an estimate, and dispatches nothing", async () => {
        const io = capture();

        const code = await main(["run", "add a /health endpoint", "--plan-only"], io, {
          createCalls,
        });

        const output = io.lines.join("\n");
        assert.equal(code, 0);
        assert.match(output, /CRITERIA/);
        assert.match(output, /PLAN/);
        assert.match(output, /ESTIMATE/);
        assert.match(output, /nothing dispatched/);
      });

      // The unmeasured half is shown rather than hidden (§9.5).
      test("splits measured from unmeasured in the estimate", async () => {
        const io = capture();

        await main(["run", "add a /health endpoint", "--plan-only"], io, { createCalls });

        assert.match(io.lines.join("\n"), /tokens measured, \d+ CLI runs unmeasured/);
      });

      test("writes a resumable mission log", async () => {
        const io = capture();

        await main(["run", "add a /health endpoint", "--plan-only"], io, { createCalls });

        const missions = fs.readdirSync(path.join(stateDir, "missions"));
        assert.equal(missions.length, 1);
        assert.ok(fs.existsSync(path.join(stateDir, "missions", missions[0]!, "events.jsonl")));
      });

      // An optional dependency is a place a feature can be finished and switched off
      // at once (defects 12b, 23, 24), and `recall` is one. So this asserts the
      // composition root that binds it, not the mechanism — which has its own tests.
      test("consults the lore store and puts what it finds on the log", async () => {
        const io = capture();
        const lore = path.join(stateDir, "lore");
        writeLore(
          lore,
          {
            id: "l1",
            claim: "the API client lives in src/net",
            type: "observation",
            confidence: "medium",
            source: { missionId: "m0", evidence: "src/net/client.ts", kind: "research" },
            observedAt: new Date().toISOString(),
          },
          "orchestrator",
        );
        writeLore(
          lore,
          {
            id: "l2",
            claim: "Stripe retries webhooks for 3 days",
            type: "research",
            confidence: "high",
            source: { missionId: "m0", evidence: "https://stripe.com/docs", kind: "web" },
            observedAt: "2020-01-01T00:00:00.000Z",
          },
          "orchestrator",
        );

        await main(["run", "add a /health endpoint", "--plan-only"], io, { createCalls });

        const recalled = loggedEvents().find((event) => event.type === "memory_recalled") as
          | { facts: unknown[]; guesses: unknown[] }
          | undefined;
        assert.ok(recalled, "the mission never consulted memory");
        // §6: the fresh one is trusted, the stale one has to be re-verified.
        assert.equal(recalled.facts.length, 1);
        assert.equal(recalled.guesses.length, 1);
      });

      test("an empty lore store is not an error, and says nothing", async () => {
        const io = capture();

        const code = await main(["run", "add a /health endpoint", "--plan-only"], io, {
          createCalls,
        });

        assert.equal(code, 0);
        assert.equal(
          loggedEvents().some((event) => event.type === "memory_recalled"),
          false,
        );
      });

      // A usable CI gate: `does this mission still plan sensibly?`
      test("exits non-zero when a criterion is rejected", async () => {
        const io = capture();
        const vague: Calls = {
          ...createCalls(),
          research: async () => ({
            brief: "",
            findings: [],
            confidence: "low",
            criteria: [{ id: "c1", statement: "make the checkout flow less janky" }],
          }),
        };

        const code = await main(["run", "a goal", "--plan-only"], io, {
          createCalls: () => vague,
        });

        assert.equal(code, 1);
        assert.match(io.errors.join("\n"), /rejected/);
      });
    });
  });
});

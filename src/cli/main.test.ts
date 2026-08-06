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
import {
  aCodeTask,
  aCriterion,
  anAgentSpec,
  aPlannedTask,
  aProgressLedger,
  fixedClock,
  missionCreated,
} from "../testing/fixtures.js";
import { type EventInput } from "../events/schema.js";
import { type Calls } from "../loop/calls.js";

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
    test("refuses --unattended without --force", async () => {
      const io = capture();

      assert.equal(await main(["run", "a goal", "--unattended"], io), 1);
      assert.match(io.errors.join("\n"), /needs --force/);
    });

    test("rejects an unknown flag rather than ignoring it", async () => {
      const io = capture();

      assert.equal(await main(["run", "a goal", "--yolo"], io), 1);
      assert.match(io.errors.join("\n"), /Unknown flag '--yolo'/);
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

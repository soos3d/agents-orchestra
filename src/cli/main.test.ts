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
import { aCodeTask, fixedClock, missionCreated } from "../testing/fixtures.js";
import { type EventInput } from "../events/schema.js";

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
    test("says the loop lands in Phase 2 instead of failing obscurely", async () => {
      const io = capture();

      assert.equal(await main(["run", "add a /health endpoint"], io), 1);
      assert.match(io.errors.join("\n"), /Phase 2/);
    });
  });
});

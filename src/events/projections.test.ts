// The milestone this file exists for: delete both projections mid-mission and watch
// them rebuild with identical state. It is the only real proof that no field changes
// without an event — anything held only in memory shows up here as a difference.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { createEventLog } from "./log.js";
import { fold } from "./fold.js";
import { MISSION_FILE, TASKS_FILE, rebuildProjections, writeProjections } from "./projections.js";
import { aCodeTask, aReport, fixedClock, missionCreated } from "../testing/fixtures.js";
import { type EventInput } from "./schema.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-proj-"));
let dir: string;
let caseNo = 0;

beforeEach(() => {
  dir = path.join(tmpRoot, `case-${++caseNo}`);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const orchestrator = { missionId: "m1", actor: "orchestrator" } as const;

const aRunningMission: EventInput[] = [
  missionCreated(),
  { ...orchestrator, type: "mission_status", from: "scanning", to: "executing", reason: "signed off" },
  { ...orchestrator, type: "round_started", round: 1 },
  { ...orchestrator, type: "task_planned", task: aCodeTask() },
  { ...orchestrator, taskId: "t1", type: "lease_granted", owns: ["src/routes/health.ts"] },
  { ...orchestrator, taskId: "t1", type: "task_status", from: "todo", to: "running", reason: "dispatched" },
  { ...orchestrator, taskId: "t1", type: "worker_report", actor: "worker", report: aReport() },
  { ...orchestrator, taskId: "t1", type: "task_status", from: "running", to: "done", reason: "verified" },
];

function seedLog(inputs: EventInput[]) {
  const log = createEventLog(dir, { now: fixedClock(), onWarn: () => {} });
  log.appendAll(inputs);
  return log;
}

describe("projections", () => {
  test("writes mission.json and tasks.json", () => {
    const log = seedLog(aRunningMission);

    writeProjections(dir, fold(log.read()));

    assert.ok(fs.existsSync(path.join(dir, MISSION_FILE)));
    assert.ok(fs.existsSync(path.join(dir, TASKS_FILE)));
  });

  test("both projections rebuild byte-identically after being deleted mid-mission", () => {
    const log = seedLog(aRunningMission);
    writeProjections(dir, fold(log.read()));
    const before = {
      mission: fs.readFileSync(path.join(dir, MISSION_FILE), "utf8"),
      tasks: fs.readFileSync(path.join(dir, TASKS_FILE), "utf8"),
    };

    fs.rmSync(path.join(dir, MISSION_FILE));
    fs.rmSync(path.join(dir, TASKS_FILE));
    rebuildProjections(dir, log.read());

    assert.equal(fs.readFileSync(path.join(dir, MISSION_FILE), "utf8"), before.mission);
    assert.equal(fs.readFileSync(path.join(dir, TASKS_FILE), "utf8"), before.tasks);
  });

  test("the rebuilt state carries the ledger, not just the tasks", () => {
    const deadEnd = {
      id: "d1",
      text: "Ramp API has no read scope",
      addedRound: 1,
      approach: "Ramp API",
      evidence: "403 on every call",
      source: "worker" as const,
    };
    const log = seedLog([...aRunningMission, { ...orchestrator, type: "dead_end_added", deadEnd }]);

    const state = rebuildProjections(dir, log.read());

    // A resumed run that forgot its dead ends would re-walk every one of them.
    assert.deepEqual(state.mission.ledger.deadEnds, [deadEnd]);
  });

  test("leaves no temp file behind", () => {
    const log = seedLog(aRunningMission);

    writeProjections(dir, fold(log.read()));

    const strays = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(strays, []);
  });

  test("keeps projections owner-only, since they quote worker reports", () => {
    const log = seedLog(aRunningMission);

    writeProjections(dir, fold(log.read()));

    assert.equal(fs.statSync(path.join(dir, MISSION_FILE)).mode & 0o777, 0o600);
  });
});

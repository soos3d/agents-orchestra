// The failure mode under test: a resumed mission that runs with nobody watching.
//
// `resumeMission` is the composition root U6 added, and it has the exact shape that
// has bitten three times (defects 12b, 23, 24) — an optional `surface` that, if it is
// never wired, leaves the feature finished and switched off at once. A mission resumed
// from the browser with no registration routes no answers and pushes no events: the
// tab shows the mission as it was when the page loaded, forever, and nothing about it
// looks broken.
//
// So these assert the wiring rather than the reconciliation, which `main.test.ts`
// already covers through the command. No model is reached: a mission with no plan has
// no decision left to make, so `createCalls` throwing is the assertion that it is not
// called.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { type DiscoveredConfig } from "../config/discover.js";
import { createEventLog } from "../events/log.js";
import { type Calls } from "../loop/calls.js";
import { createFileStore } from "../loop/store.js";
import { type MissionStore } from "../loop/run.js";
import { missionCreated } from "../testing/fixtures.js";
import { type WebHuman } from "../web/webHuman.js";
import { type Io } from "./main.js";
import { resumeMission } from "./resumeCommand.js";
import { type RunSurface } from "./runCommand.js";

const quietIo: Io = { out: () => {}, err: () => {} };

const refuseCalls = (): Calls => {
  throw new Error("a mission with no plan must not reach a model");
};

function scratchConfig(): DiscoveredConfig {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-resume-")));
  return {
    cwd: stateDir,
    stateDir,
    worktreeRoot: path.join(stateDir, "worktrees"),
    agents: [],
    orchestratorModel: "sonnet",
    maxConcurrency: 4,
  };
}

interface Recorded {
  surface: RunSurface;
  registered: string[];
  released: string[];
  publishes: number;
  session?: { human: WebHuman; store: MissionStore; onPanic: () => void };
}

function recordingSurface(): Recorded {
  const recorded: Recorded = {
    registered: [],
    released: [],
    publishes: 0,
    surface: {
      server: {
        url: "http://127.0.0.1:4173",
        publish: () => {
          recorded.publishes += 1;
        },
      },
      register: (missionId, session) => {
        recorded.registered.push(missionId);
        recorded.session = session;
      },
      release: (missionId) => recorded.released.push(missionId),
    },
  };
  return recorded;
}

describe("resumeMission", () => {
  test("reports an unknown mission rather than creating one", async () => {
    const config = scratchConfig();
    const errors: string[] = [];

    const code = await resumeMission("nope", config, { out: () => {}, err: (line) => errors.push(line) }, {
      createCalls: refuseCalls,
    });

    assert.equal(code, 1);
    assert.match(errors.join("\n"), /No mission 'nope'/);
    assert.equal(fs.existsSync(path.join(config.stateDir, "missions", "nope")), false);
  });

  test("registers with the lent server and releases it when the mission stops", async () => {
    const config = scratchConfig();
    const store = createFileStore(path.join(config.stateDir, "missions", "m1"));
    store.emit(missionCreated({ missionId: "m1" }));
    const recorded = recordingSurface();

    await resumeMission("m1", config, quietIo, {
      createCalls: refuseCalls,
      surface: recorded.surface,
    });

    assert.deepEqual(recorded.registered, ["m1"], "nothing routes dashboard messages here");
    assert.deepEqual(recorded.released, ["m1"], "the surface still holds a finished mission");
    assert.ok(recorded.session?.human, "no port: a resumed mission cannot be signed off from a tab");
    assert.ok(recorded.publishes > 0, "the reconciliation reached no tab");
  });

  // The flag exists so the *loop* does not carry on; a human asking it to carry on is
  // the answer it was waiting for. Without this a paused mission resumes straight back
  // into the park it was resumed from — from the browser exactly as from a terminal.
  test("lifts a pause, because clicking resume is the act the flag was waiting for", async () => {
    const config = scratchConfig();
    const dir = path.join(config.stateDir, "missions", "m1");
    const store = createFileStore(dir);
    store.emit(missionCreated({ missionId: "m1" }));
    store.emit({ missionId: "m1", actor: "human", type: "pause_requested", by: "dashboard" });

    await resumeMission("m1", config, quietIo, {
      createCalls: refuseCalls,
      surface: recordingSurface().surface,
    });

    assert.ok(createEventLog(dir).read().some((event) => event.type === "pause_lifted"));
  });
});

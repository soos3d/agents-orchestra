// The failure modes under test: a corrupt mission log taking the whole serve
// listing down with it (one bad mission should cost one warning, not the page), and
// a mission id that is really a path reaching `path.join` — the same hole
// `forgetMission` guards, one namespace over.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createFileStore } from "../loop/store.js";
import { missionCreated } from "../testing/fixtures.js";
import { createMissionRegistry } from "./registry.js";

function scratchStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-registry-"));
}

function seedMission(stateDir: string, missionId: string, goal: string): void {
  const store = createFileStore(path.join(stateDir, "missions", missionId));
  store.emit(missionCreated({ missionId, goal }));
}

describe("createMissionRegistry", () => {
  test("lists missions with status and goal, newest first", () => {
    const stateDir = scratchStateDir();
    seedMission(stateDir, "m1", "first");
    seedMission(stateDir, "m2", "second");

    const registry = createMissionRegistry(stateDir);
    const listed = registry.missions();

    assert.deepEqual(listed.map((m) => m.goal).sort(), ["first", "second"]);
    assert.ok(listed.every((m) => m.status === "scanning"));
  });

  test("an empty state dir lists nothing rather than throwing", () => {
    assert.deepEqual(createMissionRegistry(scratchStateDir()).missions(), []);
  });

  test("a corrupt mission is skipped with a warning naming the fix, not fatal", () => {
    const stateDir = scratchStateDir();
    seedMission(stateDir, "good", "the good one");
    const bad = path.join(stateDir, "missions", "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "events.jsonl"), "not json at all\n");

    const warnings: string[] = [];
    const registry = createMissionRegistry(stateDir, (m) => warnings.push(m));

    assert.deepEqual(registry.missions().map((m) => m.id), ["good"]);
    assert.ok(warnings.some((w) => /orchestra forget bad/.test(w)));
  });

  test("eventsFor refuses a path posing as a mission id", () => {
    const stateDir = scratchStateDir();
    seedMission(stateDir, "m1", "real");

    const registry = createMissionRegistry(stateDir);

    assert.deepEqual(registry.eventsFor("../m1"), []);
    assert.deepEqual(registry.eventsFor(`missions${path.sep}m1`), []);
    assert.deepEqual(registry.eventsFor(""), []);
  });

  test("re-reads a mission whose log grew, from cache when it did not", () => {
    const stateDir = scratchStateDir();
    const dir = path.join(stateDir, "missions", "m1");
    const store = createFileStore(dir);
    store.emit(missionCreated({ missionId: "m1" }));

    const registry = createMissionRegistry(stateDir);
    assert.equal(registry.eventsFor("m1").length, 1);

    store.emit({
      type: "round_started",
      missionId: "m1",
      actor: "orchestrator",
      round: 1,
    });
    assert.equal(registry.eventsFor("m1").length, 2);
  });
});

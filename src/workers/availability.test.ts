// The failure mode under test is defect 21 wearing a different hat: synthesis offered a
// transport the machine cannot start. The list is what the model is told it may pick, so
// an offer that is not true of this machine costs a task, its retry, and a replan each.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { availableTransports, runnableAcpTargets } from "./availability.js";

describe("availableTransports", () => {
  test("a machine with claude offers both cli and acp", () => {
    assert.deepEqual(availableTransports({ agents: ["claude"] }), ["cli", "acp"]);
  });

  test("a machine with codex offers both, since codex has a pinned adapter too", () => {
    assert.deepEqual(availableTransports({ agents: ["codex"] }), ["cli", "acp"]);
  });

  // The assertion this file exists for: no CLI means no ACP adapter can authenticate,
  // whatever npx would happily download.
  test("a machine with no coding CLI offers nothing", () => {
    assert.deepEqual(availableTransports({ agents: [] }), []);
  });

  test("an agent with no pinned adapter offers cli and not acp", () => {
    assert.deepEqual(availableTransports({ agents: ["opencode"] }), ["cli"]);
  });

  test("the offer is a subset of what the build ships, in the build's order", () => {
    assert.deepEqual(availableTransports({ agents: ["codex", "claude"] }), ["cli", "acp"]);
  });
});

describe("runnableAcpTargets", () => {
  test("names only targets whose CLI is on PATH", () => {
    assert.deepEqual(runnableAcpTargets({ agents: ["claude"] }), ["claude"]);
    assert.deepEqual(runnableAcpTargets({ agents: [] }), []);
  });

  test("an unpinned agent is not an acp target however installed it is", () => {
    assert.deepEqual(runnableAcpTargets({ agents: ["opencode"] }), []);
  });
});

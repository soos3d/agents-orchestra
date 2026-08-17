// The failure mode under test is defect 21 wearing a different hat: synthesis offered a
// transport the machine cannot start. The list is what the model is told it may pick, so
// an offer that is not true of this machine costs a task, its retry, and a replan each.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  availableContainment,
  availableScanners,
  availableTransports,
  containmentFor,
  runnableAcpTargets,
} from "./availability.js";

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

  // The inverse of the case above, and the one that arrived with `opencode`: an agent
  // that speaks ACP and has no `cli` launcher offers `acp` and *not* `cli`. Offering
  // `cli` here would staff every task with a transport holding no target — defect 21
  // rebuilt out of its own fix.
  test("an acp-only agent offers acp and not cli", () => {
    assert.deepEqual(availableTransports({ agents: ["opencode"] }), ["acp"]);
  });

  test("an agent with no pinned adapter offers cli and not acp", () => {
    assert.deepEqual(availableTransports({ agents: ["gemini", "claude"] }), ["cli", "acp"]);
    assert.deepEqual(availableTransports({ agents: ["gemini"] }), []);
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
    assert.deepEqual(runnableAcpTargets({ agents: ["gemini"] }), []);
  });
});

// PLAN-NEXT 3.3. Same failure mode one subsystem over: a container backend that is
// installed but not running, or running with no image to run, is a mission that staffs
// cleanly and then dies at every dispatch. Both halves have to be true before anything
// is offered, and neither may be guessed at.
describe("availableContainment", () => {
  test("needs a backend and an image, and an image is not a default", () => {
    assert.deepEqual(
      availableContainment({ agents: [], containers: ["docker"], containerImage: "org/worker" }),
      ["docker"],
    );
    assert.deepEqual(availableContainment({ agents: [], containers: ["docker"] }), []);
    assert.deepEqual(availableContainment({ agents: [], containerImage: "org/worker" }), []);
  });

  test("a config from before containment existed reads as none", () => {
    assert.deepEqual(availableContainment({ agents: ["claude"] }), []);
  });
});

describe("containmentFor", () => {
  const probe = { agents: ["claude"], containers: ["docker"], containerImage: "org/worker" };

  test("an uncontained mission is not given a container to run in", () => {
    assert.equal(containmentFor({ containment: "none" }, probe, {}), undefined);
  });

  test("carries the image and the backend, and the client's own variables only", () => {
    const contained = containmentFor({ containment: "container" }, probe, {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      ANTHROPIC_API_KEY: "sk-should-not-be-here",
    });

    assert.equal(contained?.backend, "docker");
    assert.equal(contained?.image, "org/worker");
    assert.equal(contained?.clientVars?.DOCKER_HOST, "unix:///var/run/docker.sock");
    // The client reaches the daemon; the worker's credentials are the transport's
    // business and travel by `--env`, not in the client's environment by accident.
    assert.equal("ANTHROPIC_API_KEY" in (contained?.clientVars ?? {}), false);
  });

  // The one that matters: `undefined` means "not contained", so returning it here would
  // run a mission that demanded a sandbox on the bare machine, with nothing saying so.
  test("refuses to run rather than run a contained mission uncontained", () => {
    assert.throws(
      () => containmentFor({ containment: "container" }, { agents: [] }, {}),
      /no container backend answering/,
    );
    assert.throws(
      () => containmentFor({ containment: "container" }, { agents: [], containers: ["podman"] }, {}),
      /ORCHESTRA_CONTAINER_IMAGE/,
    );
  });
});

// The failure mode either half alone produces: a grant with no binary staffs a criterion
// against a scanner that is not there (defect 21 in the checking layer), and a binary
// with no grant runs an AI agent over the repository because it happened to be installed.
describe("availableScanners", () => {
  test("needs both the envelope's grant and the machine's answer", () => {
    assert.deepEqual(availableScanners({ scanners: ["deepsec"] }, ["deepsec"]), ["deepsec"]);
    assert.deepEqual(availableScanners({ scanners: ["deepsec"] }, []), []);
    assert.deepEqual(availableScanners({ scanners: [] }, ["deepsec"]), []);
  });

  test("a machine that was never probed offers nothing", () => {
    assert.deepEqual(availableScanners({ scanners: ["deepsec"] }), []);
  });
});

// Defect 11: config.ts threw without TARGET_REPO. The repo is whatever you are
// standing in, and the verification command is written in the project's own manifest
// — asking a human to restate either is asking them to repeat themselves.
import { CONTAINER_BACKENDS } from "../runtime/contained.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  artifactDir,
  discoverConfig,
  probeContainers,
  discoverVerifyCommand,
  missionDir,
  piListsModels,
  readProviderKeys,
} from "./discover.js";
import { doctor, formatReport } from "./doctor.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-config-"));
let dir: string;
let caseNo = 0;

beforeEach(() => {
  dir = path.join(tmpRoot, `case-${++caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const write = (file: string, contents: string) =>
  fs.writeFileSync(path.join(dir, file), contents);

describe("discoverVerifyCommand", () => {
  test("finds npm test when package.json actually defines it", () => {
    write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));

    assert.deepEqual(discoverVerifyCommand(dir), {
      command: "npm test",
      source: "package.json",
    });
  });

  // A package.json with no test script is not a claim that `npm test` is green.
  test("ignores a package.json with no test script", () => {
    write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));

    assert.equal(discoverVerifyCommand(dir), undefined);
  });

  test("ignores a package.json that does not parse", () => {
    write("package.json", "{ not json");

    assert.equal(discoverVerifyCommand(dir), undefined);
  });

  test("finds a Makefile check target", () => {
    write("Makefile", "check:\n\tpytest\n");

    assert.equal(discoverVerifyCommand(dir)?.command, "make check");
  });

  test("ignores a Makefile with neither check nor test", () => {
    write("Makefile", "build:\n\tcc main.c\n");

    assert.equal(discoverVerifyCommand(dir), undefined);
  });

  // The intake question worth asking is "you have both — which one counts as green?"
  // and it can only be asked because discovery found both.
  test("prefers the package.json script when a repo has both", () => {
    write("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write("Makefile", "check:\n\tpytest\n");

    assert.equal(discoverVerifyCommand(dir)?.source, "package.json");
  });

  test("recognises the common non-JS manifests", () => {
    write("pyproject.toml", "[project]\n");
    assert.equal(discoverVerifyCommand(dir)?.command, "pytest -q");
  });

  test("returns nothing rather than guessing in an empty directory", () => {
    assert.equal(discoverVerifyCommand(dir), undefined);
  });
});

describe("discoverConfig", () => {
  test("needs no environment variables at all", async () => {
    const config = await discoverConfig(dir);

    assert.ok(config.stateDir);
    assert.ok(config.worktreeRoot);
    assert.equal(config.orchestratorModel, "opus");
  });

  test("puts state beside the repo, never inside a directory git tracks", async () => {
    const config = await discoverConfig(dir);

    assert.equal(path.basename(config.stateDir), ".orchestra");
  });

  test("treats a directory outside a repo as a mission without code tasks", async () => {
    const config = await discoverConfig(dir);

    assert.equal(config.repoRoot, undefined);
    assert.equal(config.verify, undefined);
  });

  test("gives each mission its own directory", () => {
    assert.equal(
      missionDir("/state", "m1"),
      path.join("/state", "missions", "m1"),
    );
  });

  // P2: the one place a worker with no worktree may write, and the id reaching it
  // comes from a plan a model wrote — so it is guarded the way `forgetMission` guards
  // a mission id, and for the same reason.
  describe("artifactDir", () => {
    test("gives each task its own directory under the mission", () => {
      assert.equal(
        artifactDir("/state", "m1", "recon"),
        path.join("/state", "missions", "m1", "artifacts", "recon"),
      );
    });

    test("refuses a task id that is a path", () => {
      assert.throws(() => artifactDir("/state", "m1", "../../etc"), /not a task id/);
      assert.throws(() => artifactDir("/state", "m1", "a/b"), /not a task id/);
      assert.throws(() => artifactDir("/state", "m1", ""), /not a task id/);
    });
  });
});

describe("doctor", () => {
  const base = {
    cwd: "/work",
    stateDir: "/work/.orchestra",
    worktreeRoot: "/work/../.orchestra-worktrees",
    agents: ["claude"],
    orchestratorModel: "fable",
  };

  test("is ready when a worker is installed and node is new enough", () => {
    const report = doctor({ ...base, repoRoot: "/work" }, "v23.11.0");

    assert.equal(report.ready, true);
  });

  test("fails, with the install command, when no worker is on PATH", () => {
    const report = doctor({ ...base, agents: [] }, "v23.11.0");

    assert.equal(report.ready, false);
    assert.match(report.checks.find((c) => c.name === "workers")?.fix ?? "", /npm i -g/);
  });

  test("fails on an old node and names the fix", () => {
    const report = doctor({ ...base, repoRoot: "/work" }, "v18.0.0");

    assert.equal(report.ready, false);
    assert.match(report.checks.find((c) => c.name === "node")?.fix ?? "", /nvm install/);
  });

  // Not a repo is a warning, not a failure: a research or computer mission has no repo.
  test("warns rather than fails outside a git repo", () => {
    const report = doctor(base, "v23.11.0");

    assert.equal(report.ready, true);
    assert.equal(report.checks.find((c) => c.name === "repo")?.level, "warn");
  });

  // §2a rule 5: a check that cannot tell you what to type next has not helped.
  test("warns when the state dir is not gitignored, and does not fix it itself", () => {
    const report = doctor({ ...base, repoRoot: dir, stateDir: path.join(dir, ".orchestra") });

    assert.equal(report.checks.find((c) => c.name === "gitignore")?.level, "warn");
    assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
  });

  test("passes once the entry is present", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "/.orchestra/\n");

    const report = doctor({ ...base, repoRoot: dir, stateDir: path.join(dir, ".orchestra") });

    assert.equal(report.checks.find((c) => c.name === "gitignore")?.level, "ok");
  });

  test("every non-passing check carries a fix", () => {
    const report = doctor({ ...base, agents: [] }, "v18.0.0");

    for (const check of report.checks) {
      if (check.level !== "ok") assert.ok(check.fix, `${check.name} has no fix`);
    }
  });

  // Phase 7. The failure mode is the reverse of the usual one: a `doctor` that reports
  // `acp` as available on a machine with no coding CLI would send the planner at a
  // transport that cannot spawn (defect 21), and a `doctor` that *fails* on a missing
  // OpenCode would make an optional extra a prerequisite (§2a).
  describe("the acp line", () => {
    test("names the targets that can actually run", () => {
      const check = doctor({ ...base, agents: ["claude"] }, "v23.11.0").checks.find(
        (c) => c.name === "acp",
      );

      assert.equal(check?.level, "ok");
      assert.match(check?.detail ?? "", /claude/);
    });

    test("warns, with the fix, when nothing can run over acp", () => {
      const check = doctor({ ...base, agents: [] }, "v23.11.0").checks.find((c) => c.name === "acp");

      assert.equal(check?.level, "warn");
      assert.match(check?.fix ?? "", /npm i -g/);
    });
  });

  // It was a reported extra until its session was captured; now it is a target, and a
  // machine holding only it is a machine that can run ACP work.
  describe("opencode as an acp target", () => {
    test("is enough on its own for the acp line", () => {
      const report = doctor({ ...base, agents: ["opencode"] }, "v23.11.0");

      assert.equal(report.checks.find((c) => c.name === "acp")?.level, "ok");
      assert.equal(report.ready, true);
    });

    // The npx note is about the two adapters that are downloaded. `opencode acp` is the
    // agent's own subcommand, and a line claiming otherwise sends someone hunting a
    // package that does not exist.
    test("is not described as an npx-fetched adapter", () => {
      const check = doctor({ ...base, agents: ["opencode"] }, "v23.11.0").checks.find(
        (c) => c.name === "acp",
      );

      assert.match(check?.detail ?? "", /opencode/);
      assert.doesNotMatch(check?.detail ?? "", /npx/);
    });
  });

  test("the report ends by saying whether it is ready", () => {
    assert.match(formatReport(doctor({ ...base, agents: [] }, "v18.0.0")), /Not ready/);
    assert.match(formatReport(doctor({ ...base, repoRoot: "/work" }, "v23.11.0")), /Ready\./);
  });
});

// Zero required environment variables stays the rule: a provider nobody configured is
// absent from the record rather than present and empty, so `probeProviders` skips it,
// `doctor` reports "none configured", and nothing about a mission changes. A blank
// string mapped to a provider would instead be a key that fails authentication.
describe("readProviderKeys", () => {
  test("an unset or blank variable is not a configured provider", () => {
    assert.deepEqual(readProviderKeys({}), {});
    assert.deepEqual(readProviderKeys({ NEBIUS_API_KEY: "" }), {});
  });

  test("a set key lands under the provider's own name, not the variable's", () => {
    assert.deepEqual(readProviderKeys({ NEBIUS_API_KEY: "abc", OLLAMA_API_KEY: "def" }), {
      nebius: "abc",
      "ollama-cloud": "def",
    });
  });

  test("discoverConfig populates it, which is the only producer there is", async () => {
    const config = await discoverConfig(process.cwd());
    assert.ok(config.providerKeys !== undefined);
  });
});

// PLAN-NEXT 3.3. `containers` is optional on `DiscoveredConfig` for `providerKeys`'
// reason — one producer, so the optional-`Deps` trap does not apply — and this is the
// assertion that keeps that true.
describe("probeContainers", () => {
  test("discoverConfig populates it, which is the only producer there is", async () => {
    const config = await discoverConfig(process.cwd());
    assert.ok(config.containers !== undefined);
  });

  // The trap this probe exists for: with the daemon stopped, `docker info` prints
  // "Cannot connect to the Docker daemon" and exits 0, so an exit-code-only probe would
  // report a backend that cannot start a container. Whatever this machine's state, the
  // answer is a subset of the backends we know how to drive and never a guess.
  test("names only backends this build can actually drive", async () => {
    for (const backend of await probeContainers()) {
      assert.ok(CONTAINER_BACKENDS.includes(backend), backend);
    }
  });
});

// The bug this pins shipped and was caught by running `doctor`, not by the suite: pi 0.84.2
// prints `No models available. Use /login …` to **stdout** (300 bytes, stderr empty), so the
// original "stdout is non-empty" rule offered `cli/pi` on a machine with no provider — defect
// 21's class, rebuilt one field along. The string below is the real capture, byte for byte.
describe("piListsModels", () => {
  const noProvider =
    "No models available. Use /login to log into a provider via OAuth or API key. See:\n" +
    "  /Users/x/.nvm/versions/node/v23.11.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n" +
    "  /Users/x/.nvm/versions/node/v23.11.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md\n";

  test("a machine with no provider is not offering pi, however chatty its stdout", () => {
    assert.equal(piListsModels(noProvider), false);
  });

  test("silence is not an offer either", () => {
    assert.equal(piListsModels(""), false);
    assert.equal(piListsModels("   \n  "), false);
  });

  test("a listing is an offer", () => {
    assert.equal(piListsModels("anthropic/claude-opus-4-6\nopenai/gpt-5\n"), true);
  });
});

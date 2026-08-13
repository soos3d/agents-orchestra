// Defect 11: config.ts threw without TARGET_REPO. The repo is whatever you are
// standing in, and the verification command is written in the project's own manifest
// — asking a human to restate either is asking them to repeat themselves.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { artifactDir, discoverConfig, discoverVerifyCommand, missionDir } from "./discover.js";
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
    maxConcurrency: 4,
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

  describe("the opencode line", () => {
    test("never fails, because an optional extra is not a prerequisite", () => {
      for (const optionalAgents of [[], ["opencode"]]) {
        const report = doctor({ ...base, optionalAgents }, "v23.11.0");
        assert.notEqual(report.checks.find((c) => c.name === "opencode")?.level, "fail");
        assert.equal(report.ready, true);
      }
    });

    test("says so when it is installed", () => {
      const check = doctor({ ...base, optionalAgents: ["opencode"] }, "v23.11.0").checks.find(
        (c) => c.name === "opencode",
      );

      assert.match(check?.detail ?? "", /on PATH/);
    });

    // It is not an acp target until a session against a real binary has been captured
    // (`acp/registry.ts`), and saying otherwise would ship a command line no capture
    // backs.
    test("does not claim it as an acp target on its own", () => {
      const report = doctor({ ...base, agents: [], optionalAgents: ["opencode"] }, "v23.11.0");

      assert.equal(report.checks.find((c) => c.name === "acp")?.level, "warn");
    });
  });

  test("the report ends by saying whether it is ready", () => {
    assert.match(formatReport(doctor({ ...base, agents: [] }, "v18.0.0")), /Not ready/);
    assert.match(formatReport(doctor({ ...base, repoRoot: "/work" }, "v23.11.0")), /Ready\./);
  });
});

// The failure mode under test: two names for one directory becoming two workspaces.
//
// The one-live-mission cap exists to stop two missions sharing a checkout and a merge
// queue. Under U4 that cap is a lookup on a workspace id, so if `~/repo`, `./repo` and
// a symlink to it produce three ids, the cap silently stops protecting the thing it
// was written for — and the way it fails is two workers merging into one repo, which
// no test above this layer would catch.
//
// The second failure mode is the registry as a *declaration*: a probe that accepted a
// verify command or a repo root as input would turn §2a rule 3 inside out. Everything
// `probeWorkspace` returns is observed, and these tests only ever assert observations.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { makeRepo } from "../testing/gitRepo.js";
import {
  configForWorkspace,
  probeWorkspace,
  readWorkspaces,
  resolveWorkspacePath,
  withWorkspace,
  workspaceForRoots,
  workspaceId,
  writeWorkspaces,
  WORKSPACES_FILE,
  type Workspace,
} from "./workspaces.js";
import { type DiscoveredConfig } from "./discover.js";

const scratch = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-ws-")));

const baseConfig = (stateDir: string): DiscoveredConfig => ({
  cwd: stateDir,
  stateDir,
  worktreeRoot: path.join(stateDir, "worktrees"),
  agents: [],
  orchestratorModel: "sonnet",
});

describe("workspaceId", () => {
  test("is the same for two spellings of one directory", () => {
    const dir = scratch();

    const direct = workspaceId(resolveWorkspacePath(dir, "/"));
    const relative = workspaceId(resolveWorkspacePath(path.basename(dir), path.dirname(dir)));
    const dotted = workspaceId(resolveWorkspacePath(`${dir}/./`, "/"));

    assert.equal(relative, direct, "a relative path made a second workspace");
    assert.equal(dotted, direct, "a dotted path made a second workspace");
  });

  test("follows a symlink, so a link and its target are one workspace", () => {
    const dir = scratch();
    const link = path.join(scratch(), "link");
    fs.symlinkSync(dir, link);

    assert.equal(workspaceId(resolveWorkspacePath(link, "/")), workspaceId(dir));
  });

  test("two different directories are two workspaces", () => {
    assert.notEqual(workspaceId(scratch()), workspaceId(scratch()));
  });
});

describe("resolveWorkspacePath", () => {
  test("expands ~ against the home it is given", () => {
    // A real directory, because the resolution goes through `realpath` — and on macOS
    // an invented `/home/dev` resolves through an autofs mount to somewhere else.
    const home = scratch();

    assert.equal(resolveWorkspacePath("~/code", "/anywhere", home), path.join(home, "code"));
    assert.equal(resolveWorkspacePath("~", "/anywhere", home), home);
  });

  // A directory about to be created has no real path of its own, so the parent's is
  // used — otherwise a workspace created under /var on macOS would resolve to a
  // different id once it existed under /private/var.
  test("resolves the parent of a directory that does not exist yet", () => {
    const dir = scratch();
    const resolved = resolveWorkspacePath("new-project", dir);

    assert.equal(resolved, path.join(dir, "new-project"));
    fs.mkdirSync(resolved);
    assert.equal(resolveWorkspacePath("new-project", dir), resolved, "the id would move on creation");
  });
});

describe("probeWorkspace", () => {
  test("reports a git repo, its verify command, and where the command came from", async () => {
    const repo = await makeRepo();
    fs.writeFileSync(path.join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const stateDir = scratch();

    const probe = await probeWorkspace(repo.path, "/", stateDir);

    assert.equal(probe.exists, true);
    assert.equal(probe.isDirectory, true);
    assert.equal(probe.repoRoot, fs.realpathSync(repo.path));
    assert.deepEqual(probe.verify, { command: "npm test", source: "package.json" });
    assert.equal(probe.stateDir, stateDir);
    assert.equal(probe.problem, undefined);
  });

  // §2a rule 3 and `discover.ts`: a research or computer mission does not need a repo,
  // so this is a supported case the UI states plainly rather than a warning.
  test("a directory that is not a git repo is a workspace with no repo, not a problem", async () => {
    const dir = scratch();

    const probe = await probeWorkspace(dir, "/", scratch());

    assert.equal(probe.repoRoot, undefined);
    assert.equal(probe.verify, undefined);
    assert.equal(probe.problem, undefined, "a non-repo directory was refused");
  });

  test("a path that does not exist is reported, not refused — it is the create case", async () => {
    const probe = await probeWorkspace("nowhere-at-all", scratch(), scratch());

    assert.equal(probe.exists, false);
    assert.equal(probe.problem, undefined);
  });

  test("a file is the one refusal a probe makes", async () => {
    const dir = scratch();
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "hello");

    const probe = await probeWorkspace(file, "/", scratch());

    assert.equal(probe.isDirectory, false);
    assert.match(probe.problem ?? "", /not a directory/);
  });

  test("says so when the directory is already registered", async () => {
    const dir = scratch();
    const known: Workspace[] = [{ id: workspaceId(dir), path: dir, addedAt: "2026-08-14T00:00:00.000Z" }];

    assert.equal((await probeWorkspace(dir, "/", scratch(), known)).registered, true);
    assert.equal((await probeWorkspace(dir, "/", scratch())).registered, false);
  });
});

describe("the registry on disk", () => {
  test("round-trips, and a missing file is no workspaces rather than an error", () => {
    const stateDir = scratch();
    assert.deepEqual(readWorkspaces(stateDir), []);

    const workspace: Workspace = { id: "ws-abc", path: "/tmp/x", addedAt: "2026-08-14T00:00:00.000Z" };
    writeWorkspaces(stateDir, [workspace]);

    assert.deepEqual(readWorkspaces(stateDir), [workspace]);
  });

  test("an unreadable registry is reported and treated as empty, never thrown", () => {
    const stateDir = scratch();
    fs.writeFileSync(path.join(stateDir, WORKSPACES_FILE), "{ this is not json");
    const warnings: string[] = [];

    assert.deepEqual(readWorkspaces(stateDir, (m) => warnings.push(m)), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Fix or delete/, "the warning does not name the fix");
  });

  test("a registry of the wrong shape is reported and treated as empty", () => {
    const stateDir = scratch();
    fs.writeFileSync(path.join(stateDir, WORKSPACES_FILE), JSON.stringify({ workspaces: [{ id: 1 }] }));
    const warnings: string[] = [];

    assert.deepEqual(readWorkspaces(stateDir, (m) => warnings.push(m)), []);
    assert.equal(warnings.length, 1);
  });
});

describe("withWorkspace", () => {
  test("is idempotent, because the id is derived from the path", () => {
    const one: Workspace = { id: "ws-a", path: "/tmp/a", addedAt: "2026-08-14T00:00:00.000Z" };
    const again: Workspace = { ...one, addedAt: "2026-08-15T00:00:00.000Z" };

    assert.deepEqual(withWorkspace(withWorkspace([], one), again), [one]);
  });
});

describe("configForWorkspace", () => {
  test("takes the repo and the verify command from the directory, and the rest from the process", async () => {
    const repo = await makeRepo();
    fs.writeFileSync(path.join(repo.path, "Makefile"), "check:\n\techo ok\n");
    const base = baseConfig(scratch());

    const config = await configForWorkspace(base, repo.path);

    assert.equal(config.cwd, repo.path);
    assert.equal(config.repoRoot, fs.realpathSync(repo.path));
    assert.deepEqual(config.verify, { command: "make check", source: "Makefile" });
    // The state dir does not move with the workspace: one registry, one listing, and
    // a mission that stays addressable by id alone.
    assert.equal(config.stateDir, base.stateDir);
    assert.equal(config.orchestratorModel, base.orchestratorModel);
  });

  // A worktree is a checkout of one repo and cannot be shared with another, so this
  // is the one field that must not be carried over from the serve process.
  test("puts worktrees beside the workspace's own repo", async () => {
    const repo = await makeRepo();
    const base = baseConfig(scratch());

    const config = await configForWorkspace(base, repo.path);

    assert.notEqual(config.worktreeRoot, base.worktreeRoot);
    assert.equal(
      path.resolve(config.worktreeRoot),
      path.resolve(path.join(fs.realpathSync(repo.path), "..", ".orchestra-worktrees")),
    );
  });

  test("a directory that is no repo gets no repo root and no verify command", async () => {
    const dir = scratch();

    const config = await configForWorkspace(baseConfig(scratch()), dir);

    assert.equal(config.repoRoot, undefined);
    assert.equal(config.verify, undefined);
  });
});

// The failure mode: a mission resumed from the browser running in the wrong checkout.
//
// A mission's log records no directory — it records the envelope, whose `fsRoots` is
// what the mission was scoped to. Matching on that is what lets `serve` resume without
// an event-union change, and the case that must never be guessed at is the one with no
// match: resuming a mission in a directory nobody chose is worse than making somebody
// open a terminal.
describe("workspaceForRoots", () => {
  const candidates = [
    { id: "ws-a", roots: ["/work/ledger"] },
    { id: "ws-b", roots: ["/work/site/docs", "/work/site"] },
  ];

  test("matches a mission scoped to a workspace's own directory", () => {
    assert.equal(workspaceForRoots(["/work/ledger"], candidates), "ws-a");
  });

  // A workspace inside a repo is scoped to the repo root, not to the directory that
  // was added — `defaultEnvelope` writes `repoRoot ?? cwd`, so both have to match.
  test("matches a mission scoped to the workspace's repo root", () => {
    assert.equal(workspaceForRoots(["/work/site"], candidates), "ws-b");
  });

  test("no match is an answer, not a default", () => {
    assert.equal(workspaceForRoots(["/somewhere/else"], candidates), undefined);
    assert.equal(workspaceForRoots([], candidates), undefined);
    assert.equal(workspaceForRoots(["/work/ledger"], []), undefined);
  });
});

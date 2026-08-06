// Defect 10: `createWorktree` always based on HEAD of whatever branch the repo
// happened to be on, so with concurrent merges two tasks dispatched minutes apart
// silently got different bases — and the second one's diff contained the first's work.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { changedFiles, git, hasCommitsSince } from "./repo.js";
import { createWorktree, listWorktrees, pruneOrphanWorktrees, removeWorktree } from "./worktree.js";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";

let repo: TestRepo;

before(async () => {
  repo = await makeRepo("orchestra-worktree-");
});

after(() => repo.cleanup());

describe("createWorktree", () => {
  test("bases the branch on the sha it was given, not on HEAD", async () => {
    const pinned = await repo.head();
    // Main moves on, exactly as a concurrent merge would move it.
    await repo.writeAndCommit("other.txt", "landed after the pin\n");

    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/pinned", pinned);

    assert.equal(await git(worktree.path, ["rev-parse", "HEAD"]), pinned);
    assert.equal(fs.existsSync(path.join(worktree.path, "other.txt")), false);
    await removeWorktree(repo.path, worktree.path);
  });

  test("records the base sha so verification and merge can assert it later", async () => {
    const base = await repo.head();

    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/recorded", base);

    assert.equal(worktree.baseSha, base);
    await removeWorktree(repo.path, worktree.path);
  });

  test("turns a branch name into a flat directory name", async () => {
    const worktree = await createWorktree(
      repo.path,
      repo.worktreeRoot,
      "feat/nested/name",
      await repo.head(),
    );

    assert.equal(path.dirname(worktree.path), repo.worktreeRoot);
    await removeWorktree(repo.path, worktree.path);
  });

  test("refuses to reuse an occupied directory instead of clobbering it", async () => {
    const base = await repo.head();
    const first = await createWorktree(repo.path, repo.worktreeRoot, "feat/dup", base);

    await assert.rejects(
      () => createWorktree(repo.path, repo.worktreeRoot, "feat/dup", base),
      /already exists/,
    );
    await removeWorktree(repo.path, first.path);
  });
});

describe("removeWorktree", () => {
  // Defect 7: `removeWorktree` was exported and never called, so worktrees leaked.
  test("removes the directory and deregisters it", async () => {
    const worktree = await createWorktree(
      repo.path,
      repo.worktreeRoot,
      "feat/removable",
      await repo.head(),
    );

    await removeWorktree(repo.path, worktree.path);

    assert.equal(fs.existsSync(worktree.path), false);
    const registered = await listWorktrees(repo.path);
    assert.equal(registered.some((w) => w.path === worktree.path), false);
  });

  test("still deregisters when the directory is already gone", async () => {
    const worktree = await createWorktree(
      repo.path,
      repo.worktreeRoot,
      "feat/vanished",
      await repo.head(),
    );
    fs.rmSync(worktree.path, { recursive: true, force: true });

    await removeWorktree(repo.path, worktree.path);

    const registered = await listWorktrees(repo.path);
    assert.equal(registered.some((w) => w.path === worktree.path), false);
  });
});

describe("pruneOrphanWorktrees", () => {
  test("removes what no task claims and keeps what one does", async () => {
    const base = await repo.head();
    const live = await createWorktree(repo.path, repo.worktreeRoot, "feat/live", base);
    const orphan = await createWorktree(repo.path, repo.worktreeRoot, "feat/orphan", base);
    // git reports realpaths, and so does the prune result; capture it before deletion.
    const orphanReal = fs.realpathSync(orphan.path);

    const result = await pruneOrphanWorktrees(repo.path, repo.worktreeRoot, [live.path]);

    assert.deepEqual(result.removed, [orphanReal]);
    assert.equal(fs.existsSync(live.path), true);
    await removeWorktree(repo.path, live.path);
  });

  // The main checkout is listed first by git and is not ours to remove. Getting this
  // wrong deletes the user's working copy.
  test("never touches the main checkout", async () => {
    const result = await pruneOrphanWorktrees(repo.path, repo.worktreeRoot, []);

    assert.equal(result.removed.includes(repo.path), false);
    assert.equal(fs.existsSync(path.join(repo.path, "README.md")), true);
  });
});

describe("inspecting a worktree", () => {
  test("reports whether work was committed, which decides the orphan's fate", async () => {
    const base = await repo.head();
    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/commits", base);

    assert.equal(await hasCommitsSince(worktree.path, base), false);

    fs.writeFileSync(path.join(worktree.path, "work.txt"), "done\n");
    await git(worktree.path, ["add", "-A"]);
    await git(worktree.path, ["commit", "-m", "work"]);

    assert.equal(await hasCommitsSince(worktree.path, base), true);
    await removeWorktree(repo.path, worktree.path);
  });

  test("lists changed files including ones never committed, for the lease check", async () => {
    const base = await repo.head();
    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/changed", base);
    fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "edited\n");

    const changed = await changedFiles(worktree.path, base);

    assert.deepEqual(changed, ["tracked.txt"]);
    await removeWorktree(repo.path, worktree.path);
  });
});

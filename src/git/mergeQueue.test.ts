// Defect 5: `merge_task` merged into whatever branch the repo was on, with no lock
// and no conflict recovery. Each of those is a separate way to lose work quietly.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createMergeQueue } from "./mergeQueue.js";
import { currentBranch, git, isClean, resolveSha } from "./repo.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";

let repo: TestRepo;

before(async () => {
  repo = await makeRepo("orchestra-merge-");
});

after(() => repo.cleanup());

/** A task branch that edited one file, the way a code worker leaves things. */
async function taskBranch(branch: string, file: string, contents: string, base?: string) {
  const from = base ?? (await repo.head());
  const worktree = await createWorktree(repo.path, repo.worktreeRoot, branch, from);
  const target = path.join(worktree.path, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  await git(worktree.path, ["add", "-A"]);
  await git(worktree.path, ["commit", "-m", `work on ${branch}`]);
  return { worktree, base: from };
}

describe("createMergeQueue", () => {
  test("merges a clean branch into the named target", async () => {
    const { worktree, base } = await taskBranch("feat/clean", "clean.txt", "one\n");
    const queue = createMergeQueue(repo.path);

    const outcome = await queue.merge({
      branch: "feat/clean",
      into: "main",
      expectedBaseSha: base,
    });

    assert.equal(outcome.status, "merged");
    assert.equal(await currentBranch(repo.path), "main");
    assert.equal(fs.existsSync(path.join(repo.path, "clean.txt")), true);
    await removeWorktree(repo.path, worktree.path);
  });

  // The old merge ran on whatever branch was checked out, so a mission that had
  // wandered onto a task branch merged one task's work into another's.
  test("merges into the named target even when the repo is on another branch", async () => {
    const { worktree, base } = await taskBranch("feat/elsewhere", "elsewhere.txt", "two\n");
    await git(repo.path, ["checkout", "-b", "some-other-branch"]);

    const outcome = await createMergeQueue(repo.path).merge({
      branch: "feat/elsewhere",
      into: "main",
      expectedBaseSha: base,
    });

    assert.equal(outcome.status, "merged");
    assert.equal(await currentBranch(repo.path), "main");
    await removeWorktree(repo.path, worktree.path);
  });

  test("serializes concurrent merges rather than interleaving them", async () => {
    const base = await repo.head();
    const a = await taskBranch("feat/par-a", "par-a.txt", "a\n", base);
    const b = await taskBranch("feat/par-b", "par-b.txt", "b\n", base);
    const queue = createMergeQueue(repo.path);

    const [first, second] = await Promise.all([
      queue.merge({ branch: "feat/par-a", into: "main", expectedBaseSha: base }),
      // The second is dispatched against the same base and must be told it moved,
      // rather than merging on top of a repo mid-operation.
      queue.merge({ branch: "feat/par-b", into: "main", expectedBaseSha: base }),
    ]);

    assert.equal(first.status, "merged");
    assert.equal(second.status, "base_moved");
    assert.equal(await isClean(repo.path), true);
    await removeWorktree(repo.path, a.worktree.path);
    await removeWorktree(repo.path, b.worktree.path);
  });

  test("refuses to merge when the target moved since the branch was cut", async () => {
    const stale = await repo.head();
    const { worktree } = await taskBranch("feat/stale", "stale.txt", "s\n", stale);
    await repo.writeAndCommit("moved.txt", "main moved on\n");

    const outcome = await createMergeQueue(repo.path).merge({
      branch: "feat/stale",
      into: "main",
      expectedBaseSha: stale,
    });

    assert.equal(outcome.status, "base_moved");
    assert.match(
      outcome.status === "base_moved" ? outcome.message : "",
      /Rebase the task's worktree.*verify/s,
    );
    await removeWorktree(repo.path, worktree.path);
  });

  describe("conflicts", () => {
    test("reports the conflicting files and leaves the target untouched", async () => {
      const base = await repo.head();
      const { worktree } = await taskBranch("feat/conflict", "shared.txt", "from the task\n", base);
      await repo.writeAndCommit("shared.txt", "from main\n");
      const mainSha = await repo.head();

      const outcome = await createMergeQueue(repo.path).merge({
        branch: "feat/conflict",
        into: "main",
        expectedBaseSha: mainSha,
      });

      assert.equal(outcome.status, "conflicted");
      assert.deepEqual(outcome.status === "conflicted" ? outcome.files : [], ["shared.txt"]);
      assert.equal(await resolveSha(repo.path, "HEAD"), mainSha);
      await removeWorktree(repo.path, worktree.path);
    });

    // A half-merged checkout is the state that makes the *next* task fail for a
    // reason that has nothing to do with it.
    test("aborts the merge so the repo is left clean", async () => {
      const base = await repo.head();
      const { worktree } = await taskBranch("feat/conflict2", "shared.txt", "task again\n", base);
      await repo.writeAndCommit("shared.txt", "main again\n");

      await createMergeQueue(repo.path).merge({
        branch: "feat/conflict2",
        into: "main",
        expectedBaseSha: await repo.head(),
      });

      assert.equal(await isClean(repo.path), true);
      await removeWorktree(repo.path, worktree.path);
    });

    test("a failed merge does not deadlock the queue behind it", async () => {
      const queue = createMergeQueue(repo.path);
      const failing = queue.merge({
        branch: "does/not/exist",
        into: "main",
        expectedBaseSha: await repo.head(),
      });
      await failing.catch(() => undefined);

      const { worktree, base } = await taskBranch("feat/after-failure", "after.txt", "ok\n");
      const outcome = await queue.merge({
        branch: "feat/after-failure",
        into: "main",
        expectedBaseSha: base,
      });

      assert.equal(outcome.status, "merged");
      await removeWorktree(repo.path, worktree.path);
    });
  });
});

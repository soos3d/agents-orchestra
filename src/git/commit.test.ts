// Defect 30: a worker left its work uncommitted in the worktree, the merge merged
// nothing, and the worktree was then removed — so verified work was destroyed.
//
// Against a real git repo, because the whole question is what git considers a change:
// a fake would agree with whatever the implementation happened to do, which is the
// assumption that produced the defect.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";
import { commitWorktree } from "./commit.js";
import { changedFiles, git } from "./repo.js";
import { createWorktree } from "./worktree.js";

let repo: TestRepo;

before(async () => {
  repo = await makeRepo("orchestra-commit-");
});
after(() => repo.cleanup());

async function worktreeFor(branch: string, files: Record<string, string>) {
  const base = await repo.head();
  const tree = await createWorktree(repo.path, repo.worktreeRoot, branch, base);
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(tree.path, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { tree, base };
}

describe("commitWorktree", () => {
  test("commits everything a worker left behind, tracked and untracked", async () => {
    const { tree, base } = await worktreeFor("feat/commit-new", {
      "src/range.js": "export const clamp = () => 0;\n",
      "README.md": "# test\nchanged\n",
    });

    const outcome = await commitWorktree(tree.path, "task t1");

    assert.equal(outcome.status, "committed");
    assert.deepEqual(
      outcome.status === "committed" ? [...outcome.files].sort() : [],
      ["README.md", "src/range.js"],
    );
    assert.equal(await git(tree.path, ["status", "--porcelain"]), "");
    assert.notEqual(await git(tree.path, ["rev-parse", "HEAD"]), base);
    assert.match(await git(tree.path, ["log", "-1", "--pretty=%s"]), /task t1/);
  });

  // §8's escape check diffs the worktree against its base, and it runs on the other
  // side of this commit. A commit that hid the changed files from it would turn the
  // fix for one defect into the disabling of a whole section.
  test("leaves the changed files visible to the lease check", async () => {
    const { tree, base } = await worktreeFor("feat/commit-visible", {
      "src/declared.js": "export const a = 1;\n",
      "src/sneaky.js": "export const b = 2;\n",
    });

    await commitWorktree(tree.path, "task t2");

    assert.deepEqual((await changedFiles(tree.path, base)).sort(), [
      "src/declared.js",
      "src/sneaky.js",
    ]);
  });

  test("a worker that changed nothing produces no commit, and says so", async () => {
    const { tree, base } = await worktreeFor("feat/commit-nothing", {});

    const outcome = await commitWorktree(tree.path, "task t3");

    assert.equal(outcome.status, "empty");
    assert.equal(await git(tree.path, ["rev-parse", "HEAD"]), base);
  });

  test("a worker that committed its own work is not committed over", async () => {
    const { tree } = await worktreeFor("feat/commit-already", { "src/own.js": "1\n" });
    await git(tree.path, ["add", "-A"]);
    await git(tree.path, ["commit", "-m", "the worker's own commit"]);
    const sha = await git(tree.path, ["rev-parse", "HEAD"]);

    const outcome = await commitWorktree(tree.path, "task t4");

    assert.equal(outcome.status, "empty");
    assert.equal(await git(tree.path, ["rev-parse", "HEAD"]), sha);
  });

  // The identity a repo may not have configured is the realistic way this fails, and
  // it must not read as "the worker did nothing".
  test("a commit git refuses is a failure naming the fix, not an empty result", async () => {
    const { tree } = await worktreeFor("feat/commit-refused", { "src/refused.js": "1\n" });
    await git(tree.path, ["config", "user.email", ""]);
    await git(tree.path, ["config", "user.name", ""]);

    const outcome = await commitWorktree(tree.path, "task t5");

    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.message : "", /user\.name|user\.email/);
  });
});

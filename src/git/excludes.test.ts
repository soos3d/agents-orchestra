// The failure mode: correct, complete work failed for a file the plan told it to create.
//
// Defect 43, observed on a real mission. The goal was a Python script, the plan told the
// worker to verify with `python3 -m py_compile add.py`, and CPython wrote
// `__pycache__/add.cpython-314.pyc` beside the source. `git add -A` committed it,
// `changedFiles` reported it, and `detectEscape` failed the task **without retry** on the
// grounds that "the plan was wrong about what this work touches". It was not.
//
// So the assertions below are about the two git behaviours the fix depends on, and both
// are verified against real git rather than taken from documentation — linked worktrees
// resolve most paths to their own `$GIT_DIR`, and whether `info/exclude` is one of them
// decides whether any of this works at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { commitWorktree } from "./commit.js";
import { DERIVED_PATHS, ensureDerivedExcluded, replaceBlock } from "./excludes.js";
import { changedFiles, git, readWorkingTree } from "./repo.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";

let repo: TestRepo;

before(async () => {
  repo = await makeRepo("orchestra-excludes-");
});

after(() => repo.cleanup());

describe("ensureDerivedExcluded", () => {
  test("a byte-cache written beside the source is not counted as an escape", async () => {
    const base = await repo.head();
    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/pycache", base);

    // Exactly what the failing mission did: the declared file, plus what running
    // `python3 -m py_compile` on it leaves behind.
    fs.writeFileSync(path.join(worktree.path, "add.py"), "def add(a, b):\n    return a + b\n");
    fs.mkdirSync(path.join(worktree.path, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(worktree.path, "__pycache__", "add.cpython-314.pyc"), "\x00cache");

    await commitWorktree(worktree.path, "write-add-script: add two numbers");
    const changed = await changedFiles(worktree.path, base);

    assert.deepEqual(changed, ["add.py"], `the byte-cache was counted: ${changed.join(", ")}`);
    await removeWorktree(repo.path, worktree.path);
  });

  test("the cache is not committed either, so it can never reach the merge", async () => {
    const base = await repo.head();
    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/nocommit", base);

    fs.writeFileSync(path.join(worktree.path, "b.py"), "x = 1\n");
    fs.mkdirSync(path.join(worktree.path, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(worktree.path, "__pycache__", "b.pyc"), "\x00");

    await commitWorktree(worktree.path, "t: b");
    const committed = await git(worktree.path, ["show", "--name-only", "--format=", "HEAD"]);

    assert.ok(!committed.includes("__pycache__"), `committed the cache:\n${committed}`);
    await removeWorktree(repo.path, worktree.path);
  });

  // Defect 41's check compares the shared checkout before and after a *non*-code worker,
  // and it reads `git status` — so a research task that ran a script would have failed
  // the same way, for a file it had no lease to declare in.
  test("a cache in the shared checkout is invisible to the repo-escape check", async () => {
    await ensureDerivedExcluded(repo.path);
    fs.mkdirSync(path.join(repo.path, ".mypy_cache"), { recursive: true });
    fs.writeFileSync(path.join(repo.path, ".mypy_cache", "notes.json"), "{}");

    const tree = await readWorkingTree(repo.path);

    assert.deepEqual(tree.lines, [], `the working tree reported: ${tree.lines.join(", ")}`);
    fs.rmSync(path.join(repo.path, ".mypy_cache"), { recursive: true, force: true });
  });

  // A real escape is the whole reason the check exists. Un-counting one would turn a
  // wrong plan into a file that silently vanishes with the worktree.
  test("a source file outside the lease is still reported", async () => {
    const base = await repo.head();
    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "feat/real", base);

    fs.writeFileSync(path.join(worktree.path, "declared.py"), "x = 1\n");
    fs.writeFileSync(path.join(worktree.path, "sneaky.py"), "y = 2\n");

    await commitWorktree(worktree.path, "t: two files");
    const changed = await changedFiles(worktree.path, base);

    assert.ok(changed.includes("sneaky.py"), "a genuine escape stopped being detected");
    await removeWorktree(repo.path, worktree.path);
  });

  test("writing twice leaves one block, and keeps what a human put there", async () => {
    const first = await ensureDerivedExcluded(repo.path);
    fs.appendFileSync(first.file, "my-own-scratch-dir/\n");

    const again = await ensureDerivedExcluded(repo.path);
    const contents = fs.readFileSync(again.file, "utf8");

    assert.equal(again.written, false, "rewrote a block that was already correct");
    assert.equal(contents.split("__pycache__/").length - 1, 1, "the block was duplicated");
    assert.ok(contents.includes("my-own-scratch-dir/"), "a hand-written line was eaten");
  });

  test("the user's tracked .gitignore is never touched", async () => {
    // It is their file and their history. `info/exclude` is per-clone and uncommitted,
    // which is the whole reason it is the one being written.
    const gitignore = path.join(repo.path, ".gitignore");
    const before = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : null;

    await ensureDerivedExcluded(repo.path);

    const after = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : null;
    assert.equal(after, before);
  });
});

describe("replaceBlock", () => {
  test("appends when there is no block, replaces when there is", () => {
    assert.equal(replaceBlock("", "BLOCK"), "BLOCK\n");
    assert.equal(replaceBlock("kept/\n", "BLOCK"), "kept/\nBLOCK\n");
    // No trailing newline on the existing content is the case that silently glues a
    // marker onto somebody's last pattern.
    assert.equal(replaceBlock("kept/", "BLOCK"), "kept/\nBLOCK\n");
  });

  test("a block that lost its terminator is replaced rather than added to", () => {
    const truncated = `keep/\n# orchestra: derived output a worker cannot avoid writing — never committed\n__pycache__/\n`;
    const result = replaceBlock(truncated, "# orchestra: derived output a worker cannot avoid writing — never committed\nX\n# orchestra: end");

    assert.ok(result.startsWith("keep/\n"), "content before the block was lost");
    assert.equal(result.split("__pycache__/").length - 1, 0, "the stale block survived");
  });
});

describe("the exclude list itself", () => {
  // A wide list hides real escapes, so the entries are argued for one at a time in the
  // file header. These two are the ones somebody will reach for next, and both are
  // plausible names for directories a human actually wrote.
  test("does not exclude anything a task could legitimately produce", () => {
    for (const risky of ["dist/", "build/", "target/", "out/", "src/"]) {
      assert.ok(!DERIVED_PATHS.includes(risky), `${risky} is too broad to exclude silently`);
    }
  });
});

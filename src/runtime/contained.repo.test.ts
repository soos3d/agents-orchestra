// PLAN-NEXT 3.4. The failure mode: containment changes what the *git* checks see.
//
// Every guarantee the scheduler makes about a code task is a comparison of the tree
// before and after a worker ran — `detectRepoEscape` on the shared checkout (defect 41),
// `changedFiles` against a pinned base sha for the lease (defect 23), and the derived
// excludes that stop `git add -A` committing a `__pycache__` the plan itself asked for
// (defect 43). All three read paths on this machine. A container that mounted the
// worktree somewhere tidy like `/workspace`, or ran as root, or wrote through a copy,
// would leave every one of them comparing a tree the worker never touched — and they
// would not fail, they would pass while meaning nothing.
//
// So this runs the same worker twice against the same repository, once contained and
// once not, and asserts the three checks answer identically. It needs a real backend and
// a real image and skips with the reason when there is none (`testing/container.ts`).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { commitWorktree } from "../git/commit.js";
import { changedFiles, readWorkingTree, resolveSha } from "../git/repo.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";
import { detectRepoEscape } from "../scheduler/repoEscape.js";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";
import { testContainment } from "../testing/container.js";
import { runContained, type Containment } from "./contained.js";
import { run } from "./sh.js";

/** What a worker does: write the file it was asked for, and a derived one it cannot
 *  avoid — the shape of defect 43, in the one language every test image has. */
const WORK = "mkdir -p src __pycache__ && printf 'x = 1\\n' > src/add.py && printf 'nope' > __pycache__/add.pyc";

const live = await testContainment();
const skip = typeof live === "string" ? live : false;

// The baseline the contained run is compared against, asserted on every machine — so a
// skipped containment suite still leaves the numbers below verified rather than
// hypothetical, and so a change to the excludes or the escape check fails *here* first.
test("uncontained, the derived file is written and never staged", async () => {
  const plain = await workAndInspect(undefined);

  assert.deepEqual(plain.changed, ["src/add.py"]);
  assert.equal(plain.escaped, false);
  assert.equal(plain.committed, "committed");
});

describe("the git checks under containment", { skip }, () => {
  const containment = live as Containment;

  test("a contained worker and an uncontained one leave the same tree behind", async () => {
    const contained = await workAndInspect(containment);
    const plain = await workAndInspect(undefined);

    assert.deepEqual(contained, plain);
    // Not vacuously equal: the lease check has to see the real file, and the derived one
    // has to be absent from it rather than both lists being empty.
    assert.deepEqual(contained.changed, ["src/add.py"]);
    assert.equal(contained.escaped, false);
    assert.equal(contained.committed, "committed");
  });
});

interface Inspection {
  /** What the lease check would grade, against the worktree's pinned base sha. */
  changed: string[];
  /** Whether the shared checkout moved under the worker (defect 41). */
  escaped: boolean;
  committed: string;
}

async function workAndInspect(containment: Containment | undefined): Promise<Inspection> {
  const repo: TestRepo = await makeRepo("orchestra-contained-");
  try {
    const base = await resolveSha(repo.path, "HEAD");
    // `createWorktree` is what writes the derived-excludes block, so the exclusion half
    // of this test is exercised by using it rather than by asserting the file.
    const worktree = await createWorktree(repo.path, repo.worktreeRoot, "orchestra/contained", base);
    const before = await readWorkingTree(repo.path);

    const result = containment
      ? await runContained(containment, { cwd: worktree.path }, "/bin/sh", ["-c", WORK], {
          timeoutMs: 120_000,
        })
      : await run("/bin/sh", ["-c", WORK], { cwd: worktree.path, timeoutMs: 120_000 });
    assert.equal(result.code, 0, result.stderr);

    // The derived file exists on disk either way — the excludes stop it being *staged*,
    // which is the half that mattered in defect 43.
    assert.ok(fs.existsSync(path.join(worktree.path, "__pycache__", "add.pyc")));

    const commit = await commitWorktree(worktree.path, "contained work");
    const after = await readWorkingTree(repo.path);
    const escape = detectRepoEscape(before, after);

    const inspection: Inspection = {
      changed: await changedFiles(worktree.path, base),
      escaped: escape.escaped,
      committed: commit.status,
    };

    await removeWorktree(repo.path, worktree.path);
    return inspection;
  } finally {
    repo.cleanup();
  }
}

// The failure mode: a `review` worker edits the repository checkout, nobody commits
// it, and the criterion checks — which run with `cwd` = the repo — grade a working
// tree containing changes that never landed (defect 41).
//
// The other failure mode this has to avoid is the opposite one: a human with their own
// uncommitted work in the checkout is not an escape, and failing every task in a dirty
// repo would make the orchestrator unusable in the repo it is meant to work on.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type WorkingTree } from "../git/repo.js";
import { detectRepoEscape } from "./repoEscape.js";

const tree = (lines: string[], patch = ""): WorkingTree => ({ lines, patch });

describe("detectRepoEscape", () => {
  test("a clean checkout that stayed clean is not an escape", () => {
    assert.deepEqual(detectRepoEscape(tree([]), tree([])), { escaped: false });
  });

  test("the human's pre-existing dirt is not attributed to the worker", () => {
    const dirty = tree([" M README.md", "?? notes.txt"], "@@ -1 +1 @@\n-a\n+b\n");
    assert.deepEqual(detectRepoEscape(dirty, dirty), { escaped: false });
  });

  test("a file the worker added is an escape, and is named", () => {
    const escape = detectRepoEscape(tree([" M README.md"]), tree([" M README.md", "?? audit.mjs"]));
    assert.equal(escape.escaped, true);
    assert.ok(escape.escaped && escape.touched.includes("audit.mjs"));
    assert.ok(escape.escaped && !escape.touched.includes("README.md"));
  });

  test("a tracked file the worker edited or deleted is an escape", () => {
    const escape = detectRepoEscape(tree([]), tree([" M src/clamp.js", " D scratch.txt"]));
    assert.deepEqual(escape.escaped && escape.touched, ["src/clamp.js", "scratch.txt"]);
  });

  test("a rename reports the destination", () => {
    const escape = detectRepoEscape(tree([]), tree(["R  old.js -> new.js"]));
    assert.deepEqual(escape.escaped && escape.touched, ["new.js"]);
  });

  test("a further edit to an already-dirty file is caught by the patch, not the status", () => {
    // The status line does not move — ` M README.md` before and after — so the porcelain
    // comparison alone reports nothing. This is why the fingerprint carries two measures.
    const before = tree([" M README.md"], "@@ -1 +1 @@\n-a\n+b\n");
    const after = tree([" M README.md"], "@@ -1 +1 @@\n-a\n+worker was here\n");
    const escape = detectRepoEscape(before, after);
    assert.equal(escape.escaped, true);
    assert.deepEqual(escape.escaped && escape.touched, ["README.md"]);
  });

  test("the message names the fix, not just the fault", () => {
    const escape = detectRepoEscape(tree([]), tree(["?? audit.mjs"]));
    assert.ok(escape.escaped && escape.message.includes("`code` task"));
    assert.ok(escape.escaped && escape.message.includes("nothing was reverted"));
  });
});

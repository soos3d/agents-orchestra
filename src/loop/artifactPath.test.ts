// The failure mode under test: a synthesized spec naming an output path that is not
// in the directory the task was given, which is how a mission would write outside its
// own state — into the checkout it is refused (defect 41), or anywhere on the disk.
//
// The hostile cases are the point. A `startsWith` on the raw strings accepts
// `<root>/../etc/passwd` and rejects `<root>/./out.md`, which is exactly the class of
// mistake defects 34, 37 and 38 were: a text operation applied to something that has
// structure.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { containedIn, declaresLegalOutput } from "./artifactPath.js";

const root = path.resolve("/state/missions/m1/artifacts/t1");

describe("containedIn", () => {
  test("the directory itself is contained", () => {
    assert.equal(containedIn(root, root), true);
  });

  test("a file directly inside it is contained", () => {
    assert.equal(containedIn(path.join(root, "report.md"), root), true);
  });

  test("a nested file is contained", () => {
    assert.equal(containedIn(path.join(root, "data", "rows.csv"), root), true);
  });

  // What a worker means when it writes `notes.md`: the directory it was given.
  test("a relative path resolves against the root rather than the process cwd", () => {
    assert.equal(containedIn("notes.md", root), true);
    assert.equal(containedIn("./sub/notes.md", root), true);
  });

  test("a traversal out of the root is not contained, however it is spelled", () => {
    assert.equal(containedIn("../../etc/passwd", root), false);
    assert.equal(containedIn(path.join(root, "..", "t2", "steal.md"), root), false);
    assert.equal(containedIn("subdir/../../outside.md", root), false);
  });

  test("an absolute path elsewhere is not contained", () => {
    assert.equal(containedIn("/tmp/x", root), false);
    assert.equal(containedIn("/etc/passwd", root), false);
  });

  // §8's lease lesson one directory over: `src/routes` and `src/routers` are not the
  // same tree, and a prefix test without the separator says they are.
  test("a sibling sharing the root's name prefix is outside it", () => {
    assert.equal(containedIn(`${root}-scratch/out.md`, root), false);
  });

  // A traversal that comes back is inside, because what matters is where the write
  // lands and not how the path was written.
  test("a path that leaves and returns is contained", () => {
    assert.equal(containedIn(path.join(root, "..", "t1", "report.md"), root), true);
  });
});

// What a *spec* may declare, which is a narrower question: synthesis runs long before
// the task does, and the directory it will get is the runtime's to decide. A model
// naming an absolute path is choosing its own location.
describe("declaresLegalOutput", () => {
  test("accepts a relative path inside the directory the task will get", () => {
    assert.equal(declaresLegalOutput("report.md"), true);
    assert.equal(declaresLegalOutput("./report.md"), true);
    assert.equal(declaresLegalOutput("findings/summary.md"), true);
  });

  test("refuses an absolute path, which is a spec picking its own location", () => {
    assert.equal(declaresLegalOutput("/tmp/x"), false);
    assert.equal(declaresLegalOutput("/etc/passwd"), false);
    assert.equal(declaresLegalOutput(root), false);
  });

  test("refuses a traversal out of whatever root it is given", () => {
    assert.equal(declaresLegalOutput("../../etc/passwd"), false);
    assert.equal(declaresLegalOutput("../t2/steal.md"), false);
    assert.equal(declaresLegalOutput("subdir/../../outside.md"), false);
  });

  test("refuses an empty declaration rather than reading it as the directory", () => {
    assert.equal(declaresLegalOutput(""), false);
  });
});

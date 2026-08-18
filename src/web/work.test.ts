// The listing that decides which files the server will open (PLAN-NEXT 9.3).
//
// The failure mode under test is not a wrong label — it is a listing that disagrees
// with itself between the page and the server, because the id a browser sends is
// looked up in a list this module rebuilds. A row that exists on one side and not the
// other is either a button that refuses every click or, in the direction that matters,
// a file the server will open that the page was never shown. One reducer, asserted
// here, is what makes those the same list.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Event, type EventInput } from "../events/schema.js";
import { stamp } from "../testing/fixtures.js";
import { clip, isSha, workOf } from "./work.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const log = (...events: EventInput[]): Event[] => stamp(events);

const checked = (
  criterionId: string,
  checkOutputPath: string,
  extra: Record<string, unknown> = {},
): EventInput =>
  ({
    type: "criterion_checked",
    missionId: "m1",
    actor: "orchestrator",
    criterionId,
    met: true,
    evidence: { artifactIds: [], checkOutput: "", reasoning: "", byTask: [], checkOutputPath },
    ...extra,
  }) as EventInput;

describe("workOf: files", () => {
  test("a criterion's evidence file, the design note and a document are all openable", () => {
    const work = workOf(
      log(
        { type: "design_written", missionId: "m1", actor: "orchestrator", path: "/s/design.md", summary: "s" },
        checked("c1", "/s/criterion-c1.txt"),
        {
          type: "artifact_written",
          missionId: "m1",
          actor: "worker",
          artifact: { kind: "document", id: "a1", path: "/s/report.md", summary: "s" },
        },
      ),
    );

    assert.deepEqual(
      work.files.map((file) => [file.label, file.path]),
      [
        ["design note", "/s/design.md"],
        ["criterion c1", "/s/criterion-c1.txt"],
        ["document a1", "/s/report.md"],
      ],
    );
  });

  // The id is the recording event's `seq` and never a name: a filename crossing the
  // socket is a browser naming a path to a process that reads files.
  test("an id is the seq of the event that recorded the file, not its name", () => {
    const work = workOf(log(checked("c1", "/s/criterion-c1.txt")));
    assert.deepEqual(
      work.files.map((file) => file.id),
      ["1"],
    );
  });

  // A `report` carries its text and a `diff` carries its stat, so neither has a file to
  // open. A row for one would be a button that can only ever fail.
  test("a report and a diff artifact are not files", () => {
    const work = workOf(
      log(
        { type: "artifact_written", missionId: "m1", actor: "worker", artifact: { kind: "report", id: "r1", text: "t" } },
        {
          type: "artifact_written",
          missionId: "m1",
          actor: "worker",
          artifact: { kind: "diff", id: "d1", branch: "b", files: ["a.ts"], insertions: 1, deletions: 0 },
        },
      ),
    );
    assert.deepEqual(work.files, []);
  });

  test("a check that wrote nowhere contributes no row", () => {
    const work = workOf(
      log({
        type: "criterion_checked",
        missionId: "m1",
        actor: "orchestrator",
        criterionId: "c1",
        met: true,
        evidence: { artifactIds: [], checkOutput: "", reasoning: "", byTask: [] },
      } as EventInput),
    );
    assert.deepEqual(work.files, []);
  });

  // A panel seat is a record and not a verdict (PLAN-NEXT 6.1) — the guard `fold` and
  // `state.ts` both carry, here for the third time. Listed, the seats would put three
  // rows named after one criterion above the file that says how the panel voted.
  test("a panel seat is recorded and never listed; the resolved verdict is", () => {
    const work = workOf(
      log(
        checked("c1", "/s/criterion-c1-safety.txt", { panelSeat: 0, lens: "safety" }),
        checked("c1", "/s/criterion-c1-rigour.txt", { panelSeat: 1, lens: "rigour" }),
        checked("c1", "/s/criterion-c1.txt"),
      ),
    );
    assert.deepEqual(
      work.files.map((file) => file.path),
      ["/s/criterion-c1.txt"],
    );
  });

  // The same criterion re-checked in a later round overwrites its evidence file, so two
  // rows for one path would offer the same bytes twice and let the older label describe
  // the newer content.
  test("a re-checked criterion replaces its row rather than doubling it", () => {
    const work = workOf(log(checked("c1", "/s/criterion-c1.txt"), checked("c1", "/s/criterion-c1.txt")));
    assert.equal(work.files.length, 1);
    assert.equal(work.files[0]!.id, "2", "the id follows the latest write");
  });
});

describe("workOf: merges", () => {
  const started = (taskId: string, branch: string, intoSha: string): EventInput =>
    ({ type: "merge_started", missionId: "m1", taskId, actor: "orchestrator", branch, intoSha }) as EventInput;
  const completed = (taskId: string, branch: string, resultSha: string): EventInput =>
    ({ type: "merge_completed", missionId: "m1", taskId, actor: "orchestrator", branch, resultSha }) as EventInput;

  test("a completed merge is a range a diff can be taken from", () => {
    const work = workOf(log(started("t1", "orchestra/t1", A), completed("t1", "orchestra/t1", B)));
    assert.deepEqual(work.merges, [{ taskId: "t1", branch: "orchestra/t1", from: A, to: B }]);
  });

  // A conflict and an empty merge both leave the range open, which is what the pane
  // reads to decide there is nothing to show — rather than showing an empty diff, which
  // is what destroyed work looks like (defect 31).
  test("a merge that never completed carries no second sha", () => {
    const work = workOf(log(started("t1", "orchestra/t1", A)));
    assert.equal(work.merges[0]!.to, undefined);
  });

  // A retried merge starts from a base the branch no longer sits on. Appending instead
  // of replacing would diff from the first attempt's base and show another task's
  // merged work as this one's.
  test("a retried merge replaces the range rather than appending a second one", () => {
    const work = workOf(
      log(started("t1", "orchestra/t1", A), started("t1", "orchestra/t1", B), completed("t1", "orchestra/t1", C)),
    );
    assert.deepEqual(work.merges, [{ taskId: "t1", branch: "orchestra/t1", from: B, to: C }]);
  });

  test("two tasks keep two ranges", () => {
    const work = workOf(
      log(
        started("t1", "orchestra/t1", A),
        completed("t1", "orchestra/t1", B),
        started("t2", "orchestra/t2", B),
        completed("t2", "orchestra/t2", C),
      ),
    );
    assert.deepEqual(
      work.merges.map((merge) => merge.taskId),
      ["t1", "t2"],
    );
  });
});

// The shas come off this process's own log, so this guards a hand-edited one — which
// `registry.ts` already treats as a thing that happens. `git diff -foo..bar` reads the
// leading `-` as an option, and the argument vector is where that lands.
describe("isSha", () => {
  test("accepts an abbreviated or full object name", () => {
    assert.equal(isSha("a".repeat(7)), true);
    assert.equal(isSha(A), true);
  });

  test("refuses anything that could be read as an option or a path", () => {
    for (const bad of ["-foo", "--upload-pack=x", "HEAD", "../etc", "", "a".repeat(6), "A".repeat(40)]) {
      assert.equal(isSha(bad), false, bad);
    }
  });
});

describe("clip", () => {
  test("short text is untouched and says so", () => {
    assert.deepEqual(clip("hello", 100), { text: "hello", truncated: false });
  });

  // Cut mid-hunk, a patch reads as a patch that ends there, and "the last file changed
  // nothing" is the wrong conclusion to hand somebody reviewing merged work.
  test("a cut lands on a line boundary and is reported", () => {
    const result = clip("aaaa\nbbbb\ncccc\n", 12);
    assert.equal(result.truncated, true);
    assert.equal(result.text, "aaaa\nbbbb");
  });

  test("a single line longer than the limit is still cut", () => {
    const result = clip("x".repeat(50), 10);
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 10);
  });
});

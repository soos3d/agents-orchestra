// The failure mode: a criterion checked `false` in round 6, a fix task merged in
// round 11, and no check ever fires again — so the mission spins to its reset cap
// with the work it needs already on `main`. Observed on run 8's `readme-doc-quality`.
//
// The complement is asserted just as hard, because it is the expensive half: a
// still-`met` criterion whose contributors have not moved must not be re-judged, or
// every round buys a model call per criterion and the checking costs more than the
// work (Galley's lesson, specs.md §0).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldCheckCriterion } from "./criteria.js";
import { type Criterion } from "../domain/ledger.js";

const criterion = (patch: Partial<Criterion> = {}): Criterion => ({
  id: "c1",
  statement: "the README documents the NaN policy",
  check: { kind: "judge", rubric: "PASS if the file states it" },
  ...patch,
});

/** Only the two fields the decision reads; the rest of a Task is irrelevant here. */
const landed = (completedRound?: number) => ({ completedRound });

describe("shouldCheckCriterion", () => {
  test("fires the first time every contributing task has landed", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion(),
        allDone: true,
        landed: [landed(2)],
        round: 2,
      }),
      true,
    );
  });

  test("does not fire while a contributing task is outstanding", () => {
    assert.equal(
      shouldCheckCriterion({ criterion: criterion(), allDone: false, landed: [], round: 2 }),
      false,
    );
  });

  test("does not fire twice in the same round", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: false, lastCheckedRound: 6 }),
        allDone: true,
        landed: [landed(6)],
        round: 6,
      }),
      false,
    );
  });

  // P1 itself. The fix task landed in a round after the verdict, so the verdict is
  // about a repository state that no longer exists.
  test("re-checks an unmet criterion when a contributor landed after the verdict", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: false, lastCheckedRound: 6 }),
        allDone: true,
        landed: [landed(3), landed(11)],
        round: 12,
      }),
      true,
    );
  });

  test("leaves an unmet criterion alone when nothing has landed since", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: false, lastCheckedRound: 6 }),
        allDone: true,
        landed: [landed(3), landed(6)],
        round: 9,
      }),
      false,
    );
  });

  // A task that reached `done` before this field existed, or through a path that
  // never recorded one, must not be read as "landed in round 0 and therefore old" —
  // nor as new. Absent means no evidence of a landing after the check.
  test("a contributor with no recorded round does not count as a new landing", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: false, lastCheckedRound: 6 }),
        allDone: true,
        landed: [landed(undefined)],
        round: 9,
      }),
      false,
    );
  });

  // The expensive complement. `met: true` and nothing moved is the common case in
  // every round after the criterion passes, and it must cost nothing.
  test("never re-judges a criterion that is already met", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: true, lastCheckedRound: 4 }),
        allDone: true,
        landed: [landed(4), landed(11)],
        round: 12,
      }),
      false,
    );
  });

  // Something that was `done` no longer is — a revert, or a replan that added work.
  // The basis for `met` has changed, so the verdict has to be withdrawn.
  test("re-checks a met criterion whose work stopped being done", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: true, lastCheckedRound: 4 }),
        allDone: false,
        landed: [landed(4)],
        round: 5,
      }),
      true,
    );
  });

  test("an unmet criterion that loses a contributor is not re-checked until it lands again", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: false, lastCheckedRound: 4 }),
        allDone: false,
        landed: [],
        round: 5,
      }),
      false,
    );
  });
});

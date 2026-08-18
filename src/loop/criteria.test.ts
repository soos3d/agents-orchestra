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
import {
  deterministicFirst,
  isDeterministicCheck,
  PANEL_LENSES,
  panelSeats,
  panelVerdict,
  shouldCheckCriterion,
} from "./criteria.js";
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
  // **This assertion was inverted deliberately.** It used to read `false`: a met criterion
  // was never re-judged, whatever landed afterwards. That is the wrong expectation in two
  // directions. Work merging after a criterion passed can break it and nothing would
  // notice — run 8's bug with the polarity flipped — and, since PLAN-NEXT 6.2, the gate
  // can skip the one round `invalidated` fires in, after which a stale `met: true` is
  // unreachable for the rest of the mission and the run completes on it. The cost is one
  // extra panel per re-landing, which is bounded by the landings rather than by the
  // rounds.
  test("re-judges a met criterion when a contributor landed after the verdict", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: true, lastCheckedRound: 4 }),
        allDone: true,
        landed: [landed(4), landed(11)],
        round: 12,
      }),
      true,
    );
  });

  // The expensive half is still asserted: nothing new landed, so nothing is re-judged and
  // a round costs no judge call.
  test("never re-judges a met criterion while nothing new lands", () => {
    assert.equal(
      shouldCheckCriterion({
        criterion: criterion({ met: true, lastCheckedRound: 11 }),
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

// The failure mode for the rest of this file: a panel that costs three model calls and
// decides what one would have. Quorum has to be derived from the votes actually cast, or
// a threshold and a seat count drift apart and a panel of three passes on one vote.
describe("panelSeats", () => {
  test("a quick mission convenes one seat with no lens", () => {
    assert.deepEqual(panelSeats(true), [undefined]);
  });

  test("a standard mission convenes one seat per lens", () => {
    assert.deepEqual([...panelSeats(false)], [...PANEL_LENSES]);
    assert.equal(new Set(PANEL_LENSES).size, PANEL_LENSES.length);
  });

  // Not a style point. A lens is what `judgeSystemPrompt` branches on, and a quick
  // mission that acquired one would be paying for a different prompt than the token
  // count it was measured at.
  test("the quick seat is unlensed, so its prompt is the unmodified one", () => {
    assert.equal(panelSeats(true).length, 1);
    assert.equal(panelSeats(true)[0], undefined);
  });
});

describe("panelVerdict", () => {
  test("a single seat decides alone, which is every mission before panels", () => {
    assert.equal(panelVerdict([true]), true);
    assert.equal(panelVerdict([false]), false);
  });

  test("two of three carries, whichever way it splits", () => {
    assert.equal(panelVerdict([true, true, false]), true);
    assert.equal(panelVerdict([false, true, false]), false);
    assert.equal(panelVerdict([true, false, true]), true);
  });

  // `met: true` needs a majority to have shown it, not merely the absence of one
  // against. An even split has not shown anything.
  test("an even split is unmet", () => {
    assert.equal(panelVerdict([true, false]), false);
    assert.equal(panelVerdict([true, true, false, false]), false);
  });

  test("no votes is unmet rather than vacuously true", () => {
    assert.equal(panelVerdict([]), false);
  });
});

describe("the deterministic gate", () => {
  const command = { kind: "command" as const, command: "npm test" };
  const judge = { kind: "judge" as const, rubric: "PASS if it reads well" };

  test("a command and a scanner are settled by a machine; a judge is not", () => {
    assert.equal(isDeterministicCheck(command), true);
    assert.equal(isDeterministicCheck({ kind: "scanner", scanner: "deepsec" }), true);
    assert.equal(isDeterministicCheck(judge), false);
  });

  // The trap, not a definition: a `none` criterion is always answered `met: false`, so
  // counting it as deterministic would close the gate the first round it was seen and
  // suppress every panel for the rest of the mission.
  test("a criterion with no check cannot gate, because it cannot fail either", () => {
    assert.equal(isDeterministicCheck({ kind: "none", reason: "nothing to check" }), false);
  });

  test("deterministic checks come first, and ties keep the spec's order", () => {
    const ordered = deterministicFirst([
      { id: "a", check: judge },
      { id: "b", check: command },
      { id: "c", check: judge },
      { id: "d", check: command },
    ]);

    assert.deepEqual(
      ordered.map((c) => c.id),
      ["b", "d", "a", "c"],
    );
  });
});

// When a criterion's check is worth running again.
//
// §4 fires a check when the last task listing the criterion in `satisfies` reaches
// `done`, and again whenever one of those tasks leaves `done`. What that left out is
// the case a mission needing a fix task always hits: the check ran, said `false`, a
// replan produced work to fix it, that work landed — and nothing ever graded it. Run
// 8's `readme-doc-quality` was false at round 6 and the fix merged by round 11, and
// the criterion stayed false because the first check had already happened.
//
// It is deliberately a separate decision from running the check, and pure, because
// the two mistakes it can make are opposite and both expensive: never firing again
// parks a mission that has already done the work, and firing every round buys a model
// call per criterion per round for a judge. Both are asserted (`criteria.test.ts`).
import { type Criterion } from "../domain/ledger.js";

/** Only what the decision reads. A `Task` satisfies this structurally. */
export interface LandedTask {
  readonly completedRound?: number;
}

export interface CriterionCheckInput {
  readonly criterion: Criterion;
  /** Every contributing task the current plan carries has reached `done`. */
  readonly allDone: boolean;
  /** The contributing tasks that are `done`, whether or not the plan still carries them. */
  readonly landed: readonly LandedTask[];
  readonly round: number;
}

export function shouldCheckCriterion(input: CriterionCheckInput): boolean {
  const { criterion, allDone, landed, round } = input;
  // Twice in one round grades the same tree twice. The second answer cannot differ.
  if (criterion.lastCheckedRound === round) return false;

  const firstTime = allDone && criterion.lastCheckedRound === undefined;

  // The fix landed after the verdict, so the verdict is about a tree that no longer
  // exists. `undefined` is not a landing: a task with no recorded round is no evidence
  // that anything changed since the check, and reading it as round 0 would be worse —
  // it would silently suppress the re-check this whole function exists for.
  const unmetLanded =
    allDone &&
    criterion.met === false &&
    landed.some(
      (task) =>
        task.completedRound !== undefined &&
        task.completedRound > (criterion.lastCheckedRound ?? -1),
    );

  // Something that was done no longer is — a revert, a replan that added work, a task
  // that had to be redone. Either way the basis for `met` has changed.
  const invalidated = !allDone && criterion.met === true;

  return firstTime || unmetLanded || invalidated;
}

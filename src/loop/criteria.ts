// When a criterion's check is worth running again, who runs it, and in what order.
//
// Every decision in this file is pure and none of them is a model's, which is the point:
// what a panel costs, what it decides, and whether it convenes at all are the three ways
// checking can quietly become more expensive than the work it grades.
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
import { type VerifySpec } from "../domain/artifacts.js";

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

  // Work landed after the verdict, so the verdict is about a tree that no longer exists.
  // `undefined` is not a landing: a task with no recorded round is no evidence that
  // anything changed since the check, and reading it as round 0 would be worse — it
  // would silently suppress the re-check this whole function exists for.
  //
  // **Any verdict, not only a `false` one**, and PLAN-NEXT 6.2's gate is what made that
  // load-bearing. This used to require `met === false`, which left `invalidated` below as
  // the *only* signal that a `true` verdict had gone stale — and `invalidated` is
  // edge-triggered on the rounds where a contributor is out of `done`. A round the gate
  // skips consumes that edge and it never returns: the contributor lands again,
  // `firstTime` is false, this was false because `met` is true, `invalidated` is false
  // because everything is done, and a criterion graded against a tree that has since been
  // rewritten reports `met: true` until the mission completes on it. A gate that can skip
  // a round is only safe if eligibility is level-triggered.
  const landedSinceCheck =
    allDone &&
    landed.some(
      (task) =>
        task.completedRound !== undefined &&
        task.completedRound > (criterion.lastCheckedRound ?? -1),
    );

  // Something that was done no longer is — a revert, a replan that added work, a task
  // that had to be redone. Either way the basis for `met` has changed.
  const invalidated = !allDone && criterion.met === true;

  return firstTime || landedSinceCheck || invalidated;
}

/**
 * The three lenses a panel judges through (PLAN-NEXT 6.1).
 *
 * Distinct questions rather than three runs of the same one: asking one model the same
 * thing three times buys three samples of one opinion, and the disagreement quorum
 * exists to resolve only appears when the seats are looking at different things. The
 * names are the whole contract — `loop/prompts.ts` `judgeLens` turns each into the
 * paragraph the seat is given.
 */
export const PANEL_LENSES = ["correctness", "spec-compliance", "does-it-run"] as const;

export type PanelLens = (typeof PANEL_LENSES)[number];

/**
 * The seats a panel convenes, in order — one entry per judge call.
 *
 * `undefined` is a seat with no lens, and a quick mission gets exactly one of those,
 * which is what keeps its judge spend byte-identical to the mission before panels
 * existed: no lens means `judgeSystemPrompt` hands back the unmodified `JUDGE_PROMPT`.
 * A quick mission is a human saying the job is small, and paying three judges to grade
 * a one-task outcome is the cost this repository's whole quick path exists to avoid.
 */
export function panelSeats(quick: boolean): readonly (PanelLens | undefined)[] {
  return quick ? [undefined] : PANEL_LENSES;
}

/**
 * Strict majority of the verdicts actually cast — 2-of-3, and 1-of-1 for a quick
 * mission, with no threshold to configure and nothing for the fold to look up.
 *
 * Derived from the count rather than from the mission profile deliberately. A threshold
 * carried separately is a second list beside the seats, and the two disagree the first
 * time somebody changes one: a panel of three read against a threshold of one is a
 * criterion any single seat can pass. Ties are unmet, because a panel that split evenly
 * has not shown the outcome — `met: true` needs evidence, not the absence of a majority
 * against it.
 */
export function panelVerdict(verdicts: readonly boolean[]): boolean {
  const met = verdicts.filter(Boolean).length;
  return met * 2 > verdicts.length;
}

/**
 * A check a machine settles, as against one a model argues about (PLAN-NEXT 6.2).
 *
 * The distinction is what the gate is ordered on: a command exits 0 or it does not, and
 * a scanner's findings are a list — neither costs a model call, and neither is worth
 * re-litigating once it has failed.
 *
 * **`none` is not one of them**, and that is a real trap rather than a definition. A
 * criterion with no check is always answered `met: false` (`createCriterionChecker`), so
 * counting it as deterministic would close the gate on the first round it was seen and
 * every panel in the mission would be suppressed for the rest of the run. It cannot fail
 * because it cannot be evaluated, and a gate is about evidence that the tree is broken.
 */
export function isDeterministicCheck(check: VerifySpec): boolean {
  return check.kind === "command" || check.kind === "scanner";
}

/**
 * The order a round's checks run in: everything deterministic, then the panels.
 *
 * A stable partition rather than a sort, so two command criteria keep the order the
 * outcome spec wrote them in — a mission's ledger is read by humans and a check set that
 * reshuffles itself between rounds is one more thing to explain.
 */
export function deterministicFirst<T extends { check: VerifySpec }>(
  criteria: readonly T[],
): readonly T[] {
  return [
    ...criteria.filter((c) => isDeterministicCheck(c.check)),
    ...criteria.filter((c) => !isDeterministicCheck(c.check)),
  ];
}

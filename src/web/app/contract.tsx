// The contract: what was agreed, and how each part of it is checked.
//
// Its own module because two screens that must never disagree both draw it — the
// sign-off screen, where it is the thing being approved, and the HUD's contract pane,
// where it is what a person opens four hours later to remember what they approved. A
// second copy that drifted would mean the page showed one contract before the run and
// a different one during it, which is the failure that makes the whole surface
// untrustworthy.
//
// Extracted from `screens.tsx` unchanged in U7: same markup, same order, same class
// names. The order is load-bearing and it is stated where it is decided, in `Contract`.
import { type Criterion } from "../../domain/ledger.js";
import { type ComponentChildren } from "preact";
import { type View } from "./state.js";

export const describeCheck = (criterion: Criterion): string =>
  criterion.check.kind === "command"
    ? `command: ${criterion.check.command}`
    : criterion.check.kind === "judge"
      ? `judge: ${criterion.check.rubric}`
      : `none: ${criterion.check.reason}`;

export const mark = (met: boolean | undefined): ComponentChildren =>
  met === true ? <span class="ok">✓</span> : met === false ? <span class="bad">✗</span> : null;

export function Criteria({ criteria }: { criteria: readonly Criterion[] }) {
  if (criteria.length === 0) return null;
  return (
    <>
      <h2>Criteria</h2>
      <div class="card">
        {criteria.map((criterion) => (
          <p class="crit" key={criterion.id}>
            <span class="id">{criterion.id}</span> {criterion.statement} {mark(criterion.met)}
            <br />
            <span class="check">check ▸ {describeCheck(criterion)}</span>
          </p>
        ))}
      </div>
    </>
  );
}

/**
 * The contract, as much of it as exists yet.
 *
 * One component for both the waiting screen and the sign-off screen, which is what
 * makes the sequence continuous rather than merely animated: the sign-off screen *is*
 * this, plus one row of buttons at the bottom. Nothing a person read while the mission
 * was still specifying moves when the decision arrives.
 *
 * The order is load-bearing (UI plan U5): **guesses stay above the plan**. A guess is
 * the thing most likely to be wrong, and burying it under twenty task rows is how a
 * sign-off screen becomes a formality.
 */
export function Contract({ view }: { view: View }) {
  const estimate = view.estimate;

  return (
    <>
      {view.brief ? <div class="card">{view.brief}</div> : null}
      <Criteria criteria={view.criteria} />

      {view.guesses.length > 0 ? (
        <>
          <h2>Guesses — these could be wrong</h2>
          <div class="card warn">
            <ul>
              {view.guesses.map((guess) => (
                <li key={guess.id ?? guess.text}>
                  {guess.text} <span class="quiet">({guess.confidence})</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {view.outOfScope.length > 0 ? (
        <>
          <h2>Out of scope</h2>
          <div class="card">{view.outOfScope.join("  ·  ")}</div>
        </>
      ) : null}

      {view.plan.length > 0 ? (
        <>
          <h2>Plan</h2>
          <div class="card scroll">
            <ul>
              {view.plan.map((task) => (
                <li key={task.id}>
                  <span class="id">{task.id}</span> [{task.worker}] {task.goal}
                  {task.dependsOn.length > 0 ? (
                    <span class="quiet"> after {task.dependsOn.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {estimate ? (
        <>
          <h2>Estimate</h2>
          <div class="card mono">
            {estimate.taskCount} tasks · ~{Math.round(estimate.wallMs / 60000)} min ·{" "}
            {estimate.expectedGates} gates
          </div>
        </>
      ) : null}
    </>
  );
}

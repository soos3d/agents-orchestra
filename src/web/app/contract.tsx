// The contract: what was agreed, and how each part of it is checked.
//
// Its own module because two screens that must never disagree both draw it — the
// sign-off screen, where it is the thing being approved, and the HUD's contract pane,
// where it is what a person opens four hours later to remember what they approved. A
// second copy that drifted would mean the page showed one contract before the run and
// a different one during it, which is the failure that makes the whole surface
// untrustworthy.
//
// Redesigned after U7: the first shipped contract was five cards of prose, and a
// person asked to approve it could not tell a criterion from its check or a task from
// its dependencies. Every section is rows now — mark, statement, then how it is
// checked; goal, then who runs it and why it exists. The order is unchanged and still
// load-bearing, stated where it is decided, in `Contract`.
import { DEFAULT_MIN_SEVERITY } from "../../domain/artifacts.js";
import { type Criterion, type Guess, type PlannedTask } from "../../domain/ledger.js";
import { type ComponentChildren } from "preact";
import { type View } from "./state.js";

/** The check, split for display: what kind of gate this is, and the literal a person
 *  would run or read. `none` renders as "unchecked" — the one kind that is a warning,
 *  because a criterion nobody can check can never be met. */
export const checkParts = (criterion: Criterion): { kind: string; detail: string } =>
  criterion.check.kind === "command"
    ? { kind: "command", detail: criterion.check.command }
    : criterion.check.kind === "judge"
      ? { kind: "judge", detail: criterion.check.rubric }
      : criterion.check.kind === "scanner"
        ? {
            kind: "scanner",
            detail: `${criterion.check.scanner}, ${criterion.check.minSeverity ?? DEFAULT_MIN_SEVERITY} or above`,
          }
        : { kind: "unchecked", detail: criterion.check.reason };

export const mark = (met: boolean | undefined): ComponentChildren =>
  met === true ? (
    <span class="ok">✓</span>
  ) : met === false ? (
    <span class="bad">✗</span>
  ) : (
    <span class="quiet">○</span>
  );

/** The count in a section header, so the shape of the contract is known before any of
 *  it is read. */
function Tally({ children }: { children: ComponentChildren }) {
  return <span class="tally">{children}</span>;
}

export function Criteria({ criteria }: { criteria: readonly Criterion[] }) {
  if (criteria.length === 0) return null;
  const met = criteria.filter((criterion) => criterion.met === true).length;
  const judged = criteria.some((criterion) => criterion.met !== undefined);

  return (
    <>
      <h2>
        Criteria
        <Tally>{judged ? `${met}/${criteria.length} met` : criteria.length}</Tally>
      </h2>
      <div class="card">
        <ol class="crits">
          {criteria.map((criterion) => {
            const check = checkParts(criterion);
            return (
              <li class="crit" key={criterion.id}>
                <span class="crit-mark" aria-hidden="true">
                  {mark(criterion.met)}
                </span>
                <div class="crit-body">
                  <p class="crit-statement">
                    {criterion.statement} <span class="id">{criterion.id}</span>
                  </p>
                  <p class="check">
                    <span class={`chip check-kind${check.kind === "unchecked" ? " check-none" : ""}`}>
                      {check.kind}
                    </span>
                    <span class="check-text">{check.detail}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

/** A guess leads with how sure the researcher was, because a low-confidence guess is
 *  the likeliest thing on this page to be wrong. The basis is under it: what the
 *  guess rests on is what a reviewer needs to challenge it. */
function GuessRow({ guess }: { guess: Guess }) {
  return (
    <li class="guess">
      <span class={`chip conf conf-${guess.confidence}`}>{guess.confidence}</span>
      <div class="guess-body">
        <p class="guess-text">{guess.text}</p>
        {guess.basis ? <p class="guess-basis">{guess.basis}</p> : null}
      </div>
    </li>
  );
}

/** A planned task: the goal, then one quiet line answering who runs it, how long it
 *  should take, what it waits on, and which criteria it exists to satisfy. */
function StepRow({ task }: { task: PlannedTask }) {
  return (
    <li class="step" key={task.id}>
      <span class="step-id">{task.id}</span>
      <div class="step-body">
        <p class="step-goal">{task.goal}</p>
        <p class="step-meta">
          <span class="chip">{task.worker}</span>
          <span>~{Math.max(1, Math.round(task.estimatedWallMs / 60000))} min</span>
          {task.dependsOn.length > 0 ? <span>after {task.dependsOn.join(", ")}</span> : null}
          {task.satisfies.length > 0 ? <span>satisfies {task.satisfies.join(", ")}</span> : null}
        </p>
      </div>
    </li>
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
      {view.brief ? (
        <>
          <h2>Brief</h2>
          <div class="card brief">{view.brief}</div>
        </>
      ) : null}
      <Criteria criteria={view.criteria} />

      {view.guesses.length > 0 ? (
        <>
          <h2>
            Guesses — these could be wrong
            <Tally>{view.guesses.length}</Tally>
          </h2>
          <div class="card warn">
            <ul class="guesses">
              {view.guesses.map((guess) => (
                <GuessRow guess={guess} key={guess.id ?? guess.text} />
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {view.outOfScope.length > 0 ? (
        <>
          <h2>Out of scope</h2>
          <div class="card">
            <div class="chips">
              {view.outOfScope.map((item) => (
                <span class="chip" key={item}>
                  {item}
                </span>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {view.plan.length > 0 ? (
        <>
          <h2>
            Plan
            <Tally>{view.plan.length} tasks</Tally>
          </h2>
          <div class="card scroll">
            <ol class="steps">
              {view.plan.map((task) => (
                <StepRow task={task} key={task.id} />
              ))}
            </ol>
          </div>
        </>
      ) : null}

      {estimate ? (
        <>
          <h2>Estimate</h2>
          <div class="card figures">
            <div class="figure">
              <span class="figure-value">{estimate.taskCount}</span>
              <span class="figure-label">tasks</span>
            </div>
            <div class="figure">
              <span class="figure-value">~{Math.round(estimate.wallMs / 60000)}</span>
              <span class="figure-label">minutes</span>
            </div>
            <div class="figure">
              <span class="figure-value">{estimate.expectedGates}</span>
              <span class="figure-label">gates</span>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

// The sign-off screen as text, as a pure function.
//
// Pure because of where this sits. The web shell (§13) is the primary surface and it
// renders the same presentation from the same fold, so the two have to agree about
// what a human was shown before approving — and only one of them can be asserted
// cheaply. Everything decided here is a value in, strings out; the terminal only
// prints them.
//
// The estimate line is the part that earns its place. Approve-or-revise is not a real
// decision without a cost (§2b), and it reports measured and unmeasured separately
// (§9.5) rather than one confident total: a single token number that silently omits
// every CLI worker reads as a cheap mission when most of the spend is invisible.
import { type Criterion, type Guess, type PlannedTask } from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";
import { type SignoffPresentation } from "../loop/human.js";

export function renderCriteria(criteria: readonly Criterion[]): string[] {
  if (criteria.length === 0) return ["CRITERIA  (none — nothing here can report success)"];

  return [
    "CRITERIA",
    ...criteria.flatMap((criterion) => [
      `  ${criterion.id}  ${criterion.statement}`,
      `      check ▸ ${describeCheck(criterion)}`,
    ]),
  ];
}

const describeCheck = (criterion: Criterion): string =>
  criterion.check.kind === "command"
    ? `command: ${criterion.check.command}`
    : criterion.check.kind === "judge"
      ? `judge: ${criterion.check.rubric}`
      : `none: ${criterion.check.reason}`;

/** Guesses lead, because they are where a plausible-looking plan goes wrong quietly
 *  (§13) and the human is the only one who can catch it. */
export function renderGuesses(guesses: readonly Guess[]): string[] {
  if (guesses.length === 0) return [];
  return [
    "",
    "GUESSES        ⚠ these could be wrong",
    ...guesses.map((guess) => `  · ${guess.text}  (${guess.confidence})`),
  ];
}

export function renderPlan(plan: readonly PlannedTask[]): string[] {
  return [
    "",
    "PLAN",
    ...plan.map((task) => {
      const after = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : "";
      return `  ${task.id}  [${task.worker}] ${task.goal}${after}`;
    }),
  ];
}

export function renderEstimate(estimate: Estimate, plan: readonly PlannedTask[]): string[] {
  // The workers that ride an existing subscription and report nothing back (§9.5).
  const unmeasured = plan.filter((task) => task.worker === "code").length;

  return [
    "",
    `ESTIMATE  ${estimate.taskCount} tasks · ~${Math.round(estimate.wallMs / 60_000)} min · ` +
      `${estimate.expectedGates} gates`,
    `          ~${Math.round(estimate.tokens / 1000)}k tokens measured, ` +
      `${unmeasured} CLI runs unmeasured`,
  ];
}

export function renderSignoff(presentation: SignoffPresentation): string[] {
  const envelope = presentation.envelope;
  const domains = envelope.domains.length > 0 ? envelope.domains.join(", ") : "no network";

  return [
    ...renderCriteria(presentation.criteria),
    ...renderGuesses(presentation.guesses),
    ...(presentation.outOfScope.length > 0
      ? ["", `OUT OF SCOPE   ${presentation.outOfScope.join("  ·  ")}`]
      : []),
    "",
    `ENVELOPE  ${domains} · ${envelope.toolClasses.join(", ")}`,
    ...renderPlan(presentation.plan),
    ...renderEstimate(presentation.estimate, presentation.plan),
  ];
}

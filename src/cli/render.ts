// The sign-off screen as text, as a pure function.
//
// Pure because of where this sits. The web shell (§13) is the primary surface and it
// renders the same presentation from the same fold, so the two have to agree about
// what a human was shown before approving — and only one of them can be asserted
// cheaply. Everything decided here is a value in, strings out; the terminal only
// prints them.
//
// The estimate line reports shape and wall-clock and no longer reports tokens. It once
// printed measured and unmeasured separately (§9.5) so that a mission whose spend was
// mostly invisible could not read as cheap — but the measured half was itself a guess
// built from hand-authored constants, and prompt caching left it predicting a quantity
// nobody bills on. `renderMetrics` below is where token figures live now: same file,
// after the run, every number folded from the log rather than assumed.
import {
  type Criterion,
  type CriterionDiff,
  type Guess,
  type PlannedTask,
} from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";
import { type MissionMetrics, type TokenBreakdown } from "../events/metrics.js";
import { type SignoffPresentation } from "../loop/human.js";

/**
 * What a finished mission cost, as lines.
 *
 * The unpriced line is the one that has to be here. A mission on subscription CLIs
 * reports `measured: 0` and cost real money (§9.5), so a summary that printed only
 * the measured total would be a confident wrong answer — the count of dispatches
 * nobody could price sits beside it, and `pricedFully` decides which of the two
 * closing lines is true.
 *
 * Numbers are grouped by hand rather than through `toLocaleString`, because these are
 * meant to be diffed between two runs and a locale-dependent separator is not.
 */
export function renderMetrics(metrics: MissionMetrics): string[] {
  const { totals } = metrics;

  const lines = [
    `MISSION ${metrics.missionId}  ·  ${metrics.status}  ·  ${count(metrics.rounds, "round", "rounds")}` +
      (metrics.quick ? "  ·  quick" : ""),
    "",
    "TOTALS",
    `  wall        ${duration(totals.wallMs)}`,
    `  tokens      ${group(totals.measuredTokens)} measured`,
    // Input, output and cached input are priced 5x and 10x apart, so the split is
    // what makes the line above chargeable. Printed only where a transport reported
    // it — a row of zeros would claim a session read no cached input, which for an
    // agentic worker is never true.
    ...kindLine("              ", totals),
    ...(totals.estimatedTokens > 0
      ? [`  estimated   ${group(totals.estimatedTokens)} — a floor, from a source that says so`]
      : []),
    totals.pricedFully
      ? `  priced      every dispatch reported its usage`
      : `  unpriced    ${unpriced(totals)} — the real cost is higher`,
  ];

  if (metrics.calls.length > 0) {
    lines.push("", "DECISION POINTS");
    for (const call of metrics.calls) {
      lines.push(
        `  ${call.call.padEnd(11)} ${count(call.calls, "call", "calls").padEnd(9)} ${duration(call.wallMs).padStart(8)}  ${group(call.measuredTokens).padStart(9)} tokens` +
          kinds(call),
      );
    }
  }

  if (metrics.tasks.length > 0) {
    lines.push("", "TASKS");
    for (const task of metrics.tasks) {
      const tokens =
        task.unmeasuredDispatches > 0 && task.measuredTokens === 0
          ? "unpriced".padStart(9)
          : `${group(task.measuredTokens).padStart(9)}`;
      lines.push(
        `  ${task.taskId.padEnd(14)} ${task.worker.padEnd(9)} ${task.status.padEnd(10)} ` +
          `${task.transport.padEnd(12)} ${task.model.padEnd(9)} ` +
          `${count(task.attempts, "try", "tries").padEnd(8)} ${duration(task.wallMs).padStart(8)}  ${tokens} tokens` +
          kinds(task),
      );
      // The spec's model is what was asked for; ACP never sends it, so a task can run
      // on another one entirely. Printed only when the two disagree, because that is
      // the case where every figure above is attached to the wrong price.
      if (task.ranOn !== undefined && task.ranOn !== task.model) {
        lines.push(`  ${" ".repeat(14)} ran on ${task.ranOn}, not the ${task.model} it was planned with`);
      }
    }
  }

  // An older log's vocabulary — most often the `"orchestration"` bucket that predates
  // the per-call split. Shown rather than dropped, or a pre-split mission's spend
  // vanishes from its own summary while still counting toward the totals above.
  if (metrics.other.length > 0) {
    lines.push("", "OTHER  (phases this version does not write)");
    for (const entry of metrics.other) {
      lines.push(
        `  ${entry.phase.padEnd(14)} ${duration(entry.wallMs).padStart(8)}  ${group(entry.measuredTokens).padStart(9)} tokens` +
          kinds(entry),
      );
    }
  }

  return lines;
}

/** The kinds as a trailing clause, or nothing at all when the transport did not report
 *  them. Absent is not zero (§9.5), and an "in 0 / out 0" suffix would say otherwise. */
function kinds(row: TokenBreakdown): string {
  // A row carrying an estimate is one whose output figure is a floor — the source said
  // so. Printing it as a plain number beside an exact input would present the two as
  // equally known, and the whole point of the estimated bucket is that they are not.
  const floor = row.estimatedTokens > 0 ? "≥" : "";
  const parts = [
    row.input === undefined ? "" : `in ${group(row.input)}`,
    row.output === undefined ? "" : `out ${floor}${group(row.output)}`,
    (row.cacheRead ?? 0) + (row.cacheWrite ?? 0) > 0
      ? `cache ${group((row.cacheRead ?? 0) + (row.cacheWrite ?? 0))}`
      : "",
  ].filter((part) => part !== "");

  return parts.length === 0 ? "" : `   (${parts.join(" · ")})`;
}

/** The same clause as its own line, for the totals block. */
const kindLine = (indent: string, row: TokenBreakdown): string[] => {
  const clause = kinds(row).trim();
  return clause === "" ? [] : [`${indent}${clause.slice(1, -1)}`];
};

/** What could not be priced, which is now two different failures: a transport that
 *  reported nothing, and a figure its own source calls a floor. */
function unpriced(totals: MissionMetrics["totals"]): string {
  const reasons = [
    totals.unmeasuredDispatches > 0
      ? `${count(totals.unmeasuredDispatches, "dispatch", "dispatches")} reported no usage`
      : "",
    totals.estimatedTokens > 0 ? "some tokens are estimated" : "",
  ].filter((reason) => reason !== "");

  return reasons.join(", ");
}

const group = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

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

// One line, and deliberately no token figure. The second line this used to print —
// "~45k tokens measured, 3 CLI runs unmeasured" — named a quantity the number was not
// of, and the count of unreporting workers only existed to qualify it. What a mission
// cost is `orchestra metrics`, after the fact and measured (`loop/estimate.ts`).
export function renderEstimate(estimate: Estimate): string[] {
  return [
    "",
    `ESTIMATE  ${estimate.taskCount} tasks · ~${Math.round(estimate.wallMs / 60_000)} min · ` +
      `${estimate.expectedGates} gates`,
  ];
}

/**
 * The mid-mission return (§3): what a replan wants to change about the contract, and
 * why.
 *
 * Rendered from the diff alone rather than from the ledger, which is what
 * `CriterionDiff.amend` carrying `from` as well as `to` is for (§4.0) — a mission may
 * sit here across a restart, and the ledger a later replan revised is not what the
 * human is being asked about. The reasoning leads, because approving a contract change
 * without it is exactly the reflex sign-off exists to interrupt.
 */
export function renderCriteriaChange(
  change: { diff: readonly CriterionDiff[]; reasoning: string },
): string[] {
  return [
    "PROPOSED CHANGE  ⚠ this edits what the mission is judged against",
    `  ${change.reasoning}`,
    ...change.diff.flatMap((op) =>
      op.op === "add"
        ? [`  add ${op.criterion.id}`, `      + ${op.criterion.statement}`]
        : op.op === "remove"
          ? [`  remove ${op.criterionId}`, `      because ${op.reason}`]
          : [
              `  amend ${op.criterionId}`,
              `      − ${op.from.statement}`,
              `      + ${op.to.statement}`,
              `      because ${op.reason}`,
            ],
    ),
    "",
  ];
}

export function renderSignoff(presentation: SignoffPresentation): string[] {
  const envelope = presentation.envelope;
  const domains = envelope.domains.length > 0 ? envelope.domains.join(", ") : "no network";

  return [
    // First, and above the criteria it edits: the change is the decision being asked
    // for, and the spec below it is the context for that decision.
    ...(presentation.proposedChange ? renderCriteriaChange(presentation.proposedChange) : []),
    ...renderCriteria(presentation.criteria),
    ...renderGuesses(presentation.guesses),
    ...(presentation.outOfScope.length > 0
      ? ["", `OUT OF SCOPE   ${presentation.outOfScope.join("  ·  ")}`]
      : []),
    "",
    `ENVELOPE  ${domains} · ${envelope.toolClasses.join(", ")}`,
    ...renderPlan(presentation.plan),
    ...renderEstimate(presentation.estimate),
  ];
}

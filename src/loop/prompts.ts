// Building a model call's input is a pure function of folded state (§3).
//
// That property is not a nicety — it is what makes the whole loop assertable against
// a canned log with no model and no spend. If any of these read a variable that
// survived a round by accident, a resumed mission would build a different prompt than
// the one it built before the crash, and nothing would say so.
//
// The other half of the same rule is context discipline (§4): what is *not* here
// matters as much. No transcripts, no raw stdout, no accumulated message history —
// the orchestrator sees short reports and artifact metadata, and that is why a
// mission can run for hours without drowning.
import { type Finding, type PlannedTask } from "../domain/ledger.js";
import { type MissionState } from "../events/fold.js";
import { unreachable } from "../scheduler/ready.js";
import {
  type ArchitectInput,
  type CritiqueInput,
  type PlanInput,
  type ProgressInput,
  type ResearchInput,
} from "./calls.js";
import { type PanelLens } from "./criteria.js";
import { pendingNotes } from "./notes.js";

/** How many past ledgers the progress call sees. Enough to recognise a repeat,
 *  short enough that round 15 does not pay for round 1. */
const PROGRESS_WINDOW = 3;

/**
 * How much of the architect's input may be findings and answers, in characters.
 *
 * A ceiling asserted by a test rather than enforced by a truncation, which is
 * `ROSTER_INDEX_BUDGET`'s shape and for its reason: the architect is handed the evidence
 * *whole* on purpose — a design written over a summary of the findings is a design of
 * something nobody looked at — so the honest control is a number that fails the suite
 * when the input grows, not a slice that quietly drops the last finding.
 *
 * ~4 chars per token, so 24,000 is roughly 6k tokens of evidence, against ~8.2k for an
 * entire `--quick --plan-only` mission. Raising it is almost always the wrong fix.
 */
export const ARCHITECT_INPUT_BUDGET = 24_000;

/**
 * How much of the design note the planner sees (PLAN-NEXT 5.2).
 *
 * The note is written for a worker with the file open; the planner needs the shape of
 * the work and gets a projection of it. Truncated *here* rather than asserted like the
 * budget above, because this one is a bound on model output and the model was not told a
 * length — a note that runs long is a design decision, not a bug, and it must not fail
 * the mission that produced it.
 */
const DESIGN_SUMMARY_BUDGET = 1_500;

export function buildResearchInput(
  state: MissionState,
  depth: ResearchInput["depth"] = "deep",
  rejected?: string,
  repoKb = "",
): ResearchInput {
  const ledger = state.mission.ledger;
  const gaps = ledger.factsToLookUp.map((entry) => entry.text);
  // Memory only. A fact this mission's own scan established is not something research
  // should be told to skip — the filter is what keeps `known` meaning "somebody else
  // already checked this" (§6).
  const known = ledger.factsVerified
    .filter((fact) => fact.source.kind === "memory")
    .map((fact) => fact.text);

  // Whatever criteria the ledger already holds before research writes any: on a fresh
  // mission that is nothing, and on a replay it is the saved skeleton (§7). Mapped to
  // statements alone so no previous run's `met` can reach the call.
  const priorCriteria = ledger.criteria.map((criterion) => ({ statement: criterion.statement }));

  const envelope = state.mission.capabilityEnvelope;

  return {
    ...(known.length > 0 ? { known } : {}),
    ...(priorCriteria.length > 0 ? { priorCriteria } : {}),
    // Absent on a first call, which is what keeps "a rejection happened" a fact rather
    // than a field the model has to interpret the emptiness of.
    ...(rejected === undefined ? {} : { rejected }),
    // Read-only egress, and only on the deep pass (PLAN-NEXT 11.3). Derived from the
    // folded envelope rather than passed in, `solePass`' rule: a grant threaded through
    // the composition root is a grant that can disagree with the one on the log a resume
    // folds. The scan never gets tools even on a granted mission — it is the cheap first
    // look, and on a quick mission it is the only pass, which `--research-web --quick`
    // is refused to keep true.
    ...(depth === "deep" && envelope.research === "web"
      ? { web: { domains: [...envelope.domains] } }
      : {}),
    // Derived rather than passed, so it cannot disagree with what `prepareMission`
    // will actually do: the scan is the whole of a quick mission's research, and it
    // has to be told, or it declines to write criteria and the gate escalates to the
    // call the mission was trying to skip.
    ...(depth === "scan" && state.mission.quick ? { solePass: true } : {}),
    // Absent rather than empty, `scanners`' rule: a call with no tools reading an empty
    // map would be told the repository has nothing in it (PLAN-NEXT 8.1).
    ...(repoKb === "" ? {} : { repoKb }),
    question:
      gaps.length > 0
        ? `${state.mission.goal}\n\nStill open: ${gaps.join("; ")}`
        : state.mission.goal,
    // Memory first, then the cheap local surfaces, then the web (§5). Search before
    // you research, so knowledge accretes instead of duplicating.
    sources: ["memory", "codebase", "web"],
    depth,
  };
}

/**
 * What the architect is given: the goal, what research concluded, and the evidence.
 *
 * The findings are passed in rather than read back off the ledger, because at this point
 * in `prepareMission` they are not on it — the ledger append happens after the spec is
 * written, so folding them out of state here would hand the architect the *scan's*
 * findings and call them the research pass's. Everything else is folded, which is what
 * keeps this assertable against a canned log.
 *
 * `factsGiven` rides along as `known` because intake runs before this (§2b), and a design
 * settled without the human's answers is a design of the wrong thing.
 */
export function buildArchitectInput(
  state: MissionState,
  findings: readonly Finding[],
  rejected?: string,
  scanners: readonly string[] = [],
  repoKb = "",
): ArchitectInput {
  const ledger = state.mission.ledger;
  const known = [
    ...ledger.factsGiven,
    ...ledger.factsVerified.filter((fact) => fact.source.kind === "memory"),
  ].map((fact) => fact.text);
  const priorCriteria = ledger.criteria.map((criterion) => ({ statement: criterion.statement }));

  return {
    ...(known.length > 0 ? { known } : {}),
    ...(priorCriteria.length > 0 ? { priorCriteria } : {}),
    // Absent on the first call, so "a rejection happened" stays a fact rather than a
    // field whose emptiness has to be interpreted — `buildResearchInput`'s rule.
    ...(rejected === undefined ? {} : { rejected }),
    // Absent rather than empty, so the prompt's "only when the input carries a
    // `scanners` list" is a fact about the object rather than a length the model has to
    // interpret. The composition root has already intersected the envelope's grant with
    // what this machine probed, so anything here is genuinely runnable.
    ...(scanners.length > 0 ? { scanners: [...scanners] } : {}),
    // Absent rather than empty, for the reason `scanners` is (PLAN-NEXT 8.1).
    ...(repoKb === "" ? {} : { repoKb }),
    goal: state.mission.goal,
    brief: state.brief,
    findings: [...findings],
  };
}

/** The critic is handed the breakdown and the contract, and nothing else: an objection
 *  is only worth raising against what the mission is actually judged on.
 *
 *  The exception is a moonshot mission, which also gets the design summary (PLAN-NEXT
 *  8.2) — the same bounded projection the planner sees, so the design review round costs
 *  what a plan call already costs and nothing is truncated twice. Absent when there is no
 *  note, which is every quick mission and every mission composed as standard. */
export function buildCritiqueInput(state: MissionState, tasks: readonly PlannedTask[]): CritiqueInput {
  return {
    goal: state.mission.goal,
    tasks: [...tasks],
    criteria: [...state.mission.ledger.criteria],
    ...(state.mission.moonshot && state.design ? { design: state.design.summary } : {}),
  };
}

/**
 * The design note as the planner sees it (PLAN-NEXT 5.2).
 *
 * Cut on a line boundary rather than mid-sentence, and marked when something was left
 * behind — a truncated design that does not say it is truncated reads as a design that
 * stopped there, which is exactly the wrong thing to tell the call that decides how many
 * tasks the work needs.
 */
export function designSummary(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length <= DESIGN_SUMMARY_BUDGET) return trimmed;

  const cut = trimmed.slice(0, DESIGN_SUMMARY_BUDGET);
  const lastBreak = cut.lastIndexOf("\n");
  const kept = lastBreak > DESIGN_SUMMARY_BUDGET / 2 ? cut.slice(0, lastBreak) : cut;
  return `${kept.trimEnd()}\n\n(The design note continues; the full text is on disk.)`;
}

/**
 * What one panel seat is asked to look at, on top of the judge's standing instructions
 * (PLAN-NEXT 6.1).
 *
 * Three lenses rather than three copies of one question. A panel whose seats read the
 * same prompt returns three samples of one opinion, and quorum over that is a majority
 * vote among clones — it costs three calls and resolves nothing. Each of these names a
 * different way correct-looking work fails: the claim is wrong, the claim is right but
 * not what was asked for, and both are fine but nothing was ever run.
 *
 * Each seat still answers the same question (`met`) about the same criterion. The lens
 * narrows what it weighs, never what it is allowed to conclude — a seat told to grade
 * only its own lens would return `met: true` on work that fails the other two.
 */
export function judgeLens(lens: PanelLens): string {
  switch (lens) {
    case "correctness":
      return (
        "Your seat on this panel is **correctness**. Weigh whether what the artifacts " +
        "actually contain is right: the logic, the values, the edge cases. Read the code " +
        "and the data rather than the names and the comments — a function called " +
        "`validate` that returns `true` unconditionally reads as correct and is not."
      );
    case "spec-compliance":
      return (
        "Your seat on this panel is **spec compliance**. Weigh whether the artifacts do " +
        "what the criterion's statement and rubric asked for, rather than something " +
        "adjacent that is also good. Work that solves a better problem than the one " +
        "stated does not meet the criterion; say so and name what was asked."
      );
    case "does-it-run":
      return (
        "Your seat on this panel is **does it run**. Weigh whether the artifacts would " +
        "work as delivered: imports that resolve, files the code opens that exist beside " +
        "it, entry points that are wired up, syntax that parses. You cannot execute " +
        "anything — say `met: false` only for a breakage you can point at in a file, not " +
        "for one you suspect."
      );
  }
}

export function buildPlanInput(state: MissionState, reason?: string): PlanInput {
  return {
    goal: state.mission.goal,
    ledger: state.mission.ledger,
    envelope: state.mission.capabilityEnvelope,
    ...(reason === undefined ? {} : { reason }),
    // The summary the `design_written` event carried, never the note itself: the planner
    // is told the shape and the worker is given the path (PLAN-NEXT 5.2). Absent on a
    // quick mission, which has no architect and therefore no note.
    ...(state.design ? { design: state.design.summary } : {}),
    // Folded from `mission_created`, so a replan mid-mission and a resumed sign-off
    // both plan the same shape the human asked for — not just the first call.
    ...(state.mission.quick ? { scope: "quick" as const } : {}),
  };
}

export function buildProgressInput(state: MissionState): ProgressInput {
  const { mission } = state;
  const stranded = unreachable(state);
  const notes = pendingNotes(state.notes).map((note) => note.text);

  return {
    ...(notes.length > 0 ? { notes } : {}),
    // Carried whole, `met` included: the progress call reads that field and may not
    // infer it (§4).
    criteria: mission.ledger.criteria,
    reports: state.reports
      .filter((entry) => entry.round === mission.round)
      .map((entry) => ({ taskId: entry.taskId, report: entry.report })),
    recentProgress: state.progressLedgers.slice(-PROGRESS_WINDOW).map((entry) => entry.ledger),
    counters: { round: mission.round, stalls: mission.stalls, resets: mission.resets },
    frontier: stranded.map((task) => ({
      taskId: task.id,
      blockedBy: task.dependsOn.filter((id) => {
        const dependency = state.tasks.find((candidate) => candidate.id === id);
        return !dependency || dependency.status !== "done";
      }),
    })),
  };
}

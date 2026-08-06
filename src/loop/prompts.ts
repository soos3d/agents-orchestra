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
import { type MissionState } from "../events/fold.js";
import { unreachable } from "../scheduler/ready.js";
import { type PlanInput, type ProgressInput, type ResearchInput } from "./calls.js";

/** How many past ledgers the progress call sees. Enough to recognise a repeat,
 *  short enough that round 15 does not pay for round 1. */
const PROGRESS_WINDOW = 3;

export function buildResearchInput(
  state: MissionState,
  depth: ResearchInput["depth"] = "deep",
): ResearchInput {
  const ledger = state.mission.ledger;
  const gaps = ledger.factsToLookUp.map((entry) => entry.text);

  return {
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

export function buildPlanInput(state: MissionState, reason?: string): PlanInput {
  return {
    goal: state.mission.goal,
    ledger: state.mission.ledger,
    envelope: state.mission.capabilityEnvelope,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function buildProgressInput(state: MissionState): ProgressInput {
  const { mission } = state;
  const stranded = unreachable(state);

  return {
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

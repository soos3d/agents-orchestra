// The mid-mission return to sign-off (§3), and the only thing after approval that
// blocks the mission.
//
// A replan may propose changing a signed-off criterion and may never make the change:
// `revise.ts` refuses the write, `fold` refuses a log that did it anyway, and the loop
// emits `criteria_change_requested` and parks in `awaiting_signoff`. That was all
// built, correct, and led nowhere — defect 29: no surface could answer the question,
// so `orchestra run` and `orchestra resume` both printed that resolving it needed a
// screen that did not exist, and exited. A freeze with no door is a mission that can
// only be abandoned.
//
// This is the door, and it is deliberately the *same* door sign-off uses: the diff is
// rendered into a `SignoffPresentation` and handed to `HumanPort.awaitSignoff`, so the
// terminal and the dashboard race for it exactly as they do on the initial screen
// (§10's one inbox, one level down). `revise` is the rejection — from the port's side
// "approve or say what should change" is one shape, and §3 asks for one decision with
// a reason attached either way.
import { applyCriteriaDiff, CriteriaDiffError } from "../domain/criteriaDiff.js";
import { type CriterionDiff, type DeadEnd } from "../domain/ledger.js";
import { type EventInput } from "../events/schema.js";
import { estimatePlan } from "./estimate.js";
import { type HumanPort } from "./human.js";
import { type MissionStore } from "./run.js";

export interface CriteriaChangeDeps {
  store: MissionStore;
  human: HumanPort;
}

export type CriteriaChangeOutcome =
  | { ok: true; approved: boolean }
  | { ok: false; reason: string };

export async function resolveCriteriaChange(
  deps: CriteriaChangeDeps,
): Promise<CriteriaChangeOutcome> {
  const state = deps.store.state();
  const { mission } = state;
  const pending = state.pendingCriteriaChange;
  const base = { missionId: mission.id, actor: "human" as const };
  const emit = (event: EventInput) => deps.store.emit(event);

  if (!pending) {
    return {
      ok: false,
      reason:
        `${mission.id}: no criteria change is pending, so there is nothing to approve. ` +
        `Continue it with 'orchestra resume ${mission.id}'.`,
    };
  }

  // Refused before the human is asked rather than after they approve: an approval
  // recorded against a diff that cannot be applied is a contract change the log says
  // landed and the ledger never saw. The change stays pending and answerable.
  try {
    applyCriteriaDiff(mission.ledger.criteria, pending.diff);
  } catch (error) {
    if (!(error instanceof CriteriaDiffError)) throw error;
    return { ok: false, reason: error.message };
  }

  // Moved before the await, exactly as `presentAndSignOff` does: the process can die
  // on the next line and the log already says what it was waiting for.
  if (mission.status !== "awaiting_signoff") {
    emit({
      ...base,
      actor: "orchestrator",
      type: "mission_status",
      from: mission.status,
      to: "awaiting_signoff",
      reason: "a replan proposed changing a signed-off criterion",
    });
  }

  const estimate =
    mission.estimate ??
    estimatePlan({ plan: mission.ledger.plan, criteriaCount: mission.ledger.criteria.length });

  // A port that cannot answer rejects rather than deciding (`terminal.ts`'s
  // end-of-input rule), and a rejection here must leave the mission parked and
  // approvable rather than resolving the change by default.
  let decision;
  try {
    decision = await deps.human.awaitSignoff({
      missionId: mission.id,
      goal: mission.goal,
      brief: state.brief,
      criteria: mission.ledger.criteria,
      guesses: mission.ledger.guesses,
      outOfScope: state.outOfScope,
      envelope: mission.capabilityEnvelope,
      plan: mission.ledger.plan,
      estimate,
      proposedChange: { diff: pending.diff, reasoning: pending.reasoning },
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        `${mission.id}: nobody answered the proposed criteria change — ` +
        `${(error as Error).message}`,
    };
  }

  const approved = decision.kind === "approve";
  emit({ ...base, type: "criteria_change_resolved", approved });

  // §3: "a rejection is recorded as a dead end". Without it the next replan proposes
  // the same change, gets the same refusal, and spends a reset learning what the
  // human already said.
  if (decision.kind === "revise") {
    emit({
      ...base,
      type: "dead_end_added",
      deadEnd: rejectionAsDeadEnd(
        mission.ledger.deadEnds,
        pending.diff,
        decision.feedback,
        mission.round,
      ),
    });
  }

  emit({
    ...base,
    actor: "orchestrator",
    type: "mission_status",
    from: deps.store.state().mission.status,
    to: "executing",
    reason: approved ? "the criteria change was approved" : "the criteria change was rejected",
  });

  return { ok: true, approved };
}

/** What the replan may not propose again, in the words of the human who refused it. */
function rejectionAsDeadEnd(
  existing: readonly DeadEnd[],
  diff: readonly CriterionDiff[],
  feedback: string,
  round: number,
): DeadEnd {
  const named = diff
    .map((op) => `${op.op} ${op.op === "add" ? op.criterion.id : op.criterionId}`)
    .join(", ");

  // The next free id rather than the array's length: the ledger holds dead ends from
  // workers and verifications too, and a reused id points `motivatedBy` at the wrong
  // entry (§4.2).
  const taken = new Set(existing.map((entry) => entry.id));
  let next = 1;
  while (taken.has(`d${next}`)) next++;

  return {
    id: `d${next}`,
    text: `The human refused a criteria change (${named}).`,
    addedRound: round,
    approach: `Changing the signed-off criteria: ${named}`,
    evidence: feedback,
    source: "human",
  };
}

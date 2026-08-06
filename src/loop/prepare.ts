// Everything before the first worker runs: research, the outcome spec, the plan, and
// the estimate that makes sign-off a decision rather than a formality (§2b, §5).
//
// This is where `--plan-only` stops. It earns its place three times over: it exercises
// research and planning for a fraction of a real run, it is the natural CI mode
// ("does this mission still plan sensibly?"), and it is how the loop gets developed
// without paying for a fan-out on every iteration.
//
// Sign-off itself is Phase 3. Phase 2 grants it automatically and says so in the log,
// which is a supported mode forever (`--unattended`) rather than scaffolding.
import { zeroSpend } from "../domain/budget.js";
import { type Criterion, type Fact, type Finding, type PlannedTask } from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";
import { type EventInput } from "../events/schema.js";
import { validatePlan } from "../scheduler/validate.js";
import { type Calls } from "./calls.js";
import { estimatePlan } from "./estimate.js";
import { writeOutcomeSpec, type SpecRejection } from "./outcomeSpec.js";
import { buildPlanInput, buildResearchInput } from "./prompts.js";
import { type MissionStore } from "./run.js";
import { synthesizeTasks } from "./synthesize.js";

export interface PrepareDeps {
  store: MissionStore;
  calls: Calls;
  /** Stop after the estimate. No agent is synthesized and no worker runs. */
  planOnly?: boolean;
  unattended?: boolean;
  now?: () => string;
}

export type PrepareResult =
  | { ok: true; criteria: Criterion[]; plan: PlannedTask[]; estimate: Estimate; brief: string }
  | { ok: false; reason: string; rejected?: SpecRejection[] };

export async function prepareMission(deps: PrepareDeps): Promise<PrepareResult> {
  const missionId = deps.store.state().mission.id;
  const base = { missionId, actor: "orchestrator" as const };
  const emit = (event: EventInput) => deps.store.emit(event);
  const at = (deps.now ?? (() => new Date().toISOString()))();

  const move = (to: Parameters<typeof missionStatus>[0], reason: string) =>
    emit({ ...base, ...missionStatus(to, deps.store.state().mission.status, reason) });

  move("researching", "scan complete");
  const research = await deps.calls.research(buildResearchInput(deps.store.state()));
  emit({ ...base, type: "research_completed", brief: research.brief, findings: research.findings, spend: zeroSpend() });

  move("specifying", "research complete");

  // One retry, the same allowance every structured return gets. A second would let a
  // model that cannot write a checkable criterion spend the mission's budget on it.
  let spec = writeOutcomeSpec(research.criteria ?? []);
  let guesses = research.guesses ?? [];
  let outOfScope = research.outOfScope ?? [];

  if (!spec.ok) {
    emit({ ...base, type: "outcome_spec_rejected", rejected: spec.rejected });
    const second = await deps.calls.research(buildResearchInput(deps.store.state()));
    spec = writeOutcomeSpec(second.criteria ?? []);
    guesses = second.guesses ?? guesses;
    outOfScope = second.outOfScope ?? outOfScope;

    if (!spec.ok) {
      emit({ ...base, type: "outcome_spec_rejected", rejected: spec.rejected });
      return {
        ok: false,
        rejected: spec.rejected,
        reason:
          `The outcome spec was rejected twice. A criterion the runtime cannot evaluate ` +
          `means this mission could never legitimately report success.`,
      };
    }
  }

  // Criteria enter the ledger before planning, because they are an input to it: the
  // planner needs to know what it is being asked to satisfy.
  const ledgerWithSpec = {
    ...deps.store.state().mission.ledger,
    factsVerified: research.findings.map((finding, index) => asFact(finding, index, at)),
    criteria: spec.criteria,
    guesses,
  };
  emit({ ...base, type: "ledger_revised", ledger: ledgerWithSpec, reason: "spec" });

  const plan = await planWithOneRetry(deps);
  if ("message" in plan) return { ok: false, reason: plan.message };

  const estimate = estimatePlan({ plan: plan.tasks, criteriaCount: spec.criteria.length });
  emit({
    ...base,
    type: "ledger_revised",
    ledger: { ...ledgerWithSpec, plan: plan.tasks },
    reason: "replan",
  });
  emit({
    ...base,
    type: "outcome_spec_written",
    criteria: spec.criteria,
    guesses,
    outOfScope,
    estimate,
  });

  const result: PrepareResult = {
    ok: true,
    criteria: spec.criteria,
    plan: plan.tasks,
    estimate,
    brief: research.brief,
  };

  emit({ ...base, type: "signoff_requested", estimate });
  if (deps.planOnly) return result;

  await grantSignoff(deps, plan.tasks);
  return result;
}

export interface SignoffDeps {
  store: MissionStore;
  calls: Pick<Calls, "synthesize">;
  unattended?: boolean;
  now?: () => string;
}

/**
 * Approves a plan and turns it into work: the sign-off event, an agent per task, and
 * the move to `executing`.
 *
 * Phase 2 approves its own sign-off and records that it did; Phase 3 replaces the
 * decision with the screen and emits exactly this. The event being the same either
 * way is why the criteria freeze already works — `revise` reads `signedOffAt`, not
 * who set it.
 *
 * `resume` on a `--plan-only` mission also lands here, because typing the command is
 * the approval (§13). One emitter, so there is one moment criteria freeze at.
 */
export async function grantSignoff(
  deps: SignoffDeps,
  plan: readonly PlannedTask[],
): Promise<void> {
  const state = deps.store.state();
  const base = { missionId: state.mission.id, actor: "orchestrator" as const };

  deps.store.emit({ ...base, type: "signoff_granted", unattended: deps.unattended ?? false });
  await synthesizeTasks(deps, plan, 0);
  deps.store.emit({
    ...base,
    type: "mission_status",
    from: deps.store.state().mission.status,
    to: "executing",
    reason: "signed off",
  });
}

/** One structured-return retry, quoting the offending edge. A plan that cannot be
 *  scheduled produces a mission that runs to its reset cap having dispatched nothing
 *  (§3), so this is checked before a single agent is synthesized. */
async function planWithOneRetry(
  deps: PrepareDeps,
): Promise<Awaited<ReturnType<Calls["plan"]>> | { message: string }> {
  const first = await deps.calls.plan(buildPlanInput(deps.store.state()));
  const check = validatePlan(first.tasks);
  if (check.ok) return first;

  const second = await deps.calls.plan(
    buildPlanInput(deps.store.state(), `The last plan was rejected: ${check.message}`),
  );
  const recheck = validatePlan(second.tasks);
  return recheck.ok
    ? second
    : { message: `The planner could not produce a runnable plan: ${recheck.message}` };
}

/** A finding with a source becomes a verified fact; §6's provenance rule is already
 *  enforced by `findingSchema`, which rejects an empty source at the boundary. */
function asFact(finding: Finding, index: number, at: string): Fact {
  return {
    id: `f${index + 1}`,
    text: finding.claim,
    addedRound: 0,
    source: { kind: sourceKind(finding.sourceKind), ref: finding.source },
    observedAt: at,
  };
}

const sourceKind = (kind: Finding["sourceKind"]): Fact["source"]["kind"] =>
  kind === "memory" ? "memory" : "research";

function missionStatus(
  to: "researching" | "specifying",
  from: ReturnType<MissionStore["state"]>["mission"]["status"],
  reason: string,
) {
  return { type: "mission_status" as const, from, to, reason };
}

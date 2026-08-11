// Everything before the first worker runs: scan, intake, research, the outcome spec,
// the plan, and the estimate that makes sign-off a decision rather than a formality
// (§2b, §5).
//
// This is where `--plan-only` stops. It earns its place three times over: it exercises
// research and planning for a fraction of a real run, it is the natural CI mode
// ("does this mission still plan sensibly?"), and it is how the loop gets developed
// without paying for a fan-out on every iteration.
//
// The order is the point, and an earlier draft had it backwards. Scanning before
// asking is what makes the three questions worth blocking for: asked blind they come
// back as "what does done look like?", which the human answered by writing the brief.
// Asked over what the scan found, they can name the two test commands the repo has.
// So: scan (silent, cheap, never blocks), then intake, then research over what is
// still open, then the spec, then sign-off.
import { zeroSpend } from "../domain/budget.js";
import {
  type Criterion,
  type Fact,
  type Finding,
  type Guess,
  type PlannedTask,
} from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";
import { type AgentSpec } from "../domain/task.js";
import { type EventInput } from "../events/schema.js";
import { type Recall } from "../memory/lore.js";
import { recallToLedger } from "../memory/recall.js";
import { validatePlan } from "../scheduler/validate.js";
import { type Calls } from "./calls.js";
import { estimatePlan } from "./estimate.js";
import { unattendedHuman, type HumanPort, type SignoffPresentation } from "./human.js";
import { runIntake } from "./intake.js";
import { writeOutcomeSpec, type SpecRejection } from "./outcomeSpec.js";
import { buildPlanInput, buildResearchInput } from "./prompts.js";
import { type MissionStore } from "./run.js";
import { SynthesisError, synthesizeTasks } from "./synthesize.js";

/** How many times `revise` may send the plan back before the mission gives up.
 *  A human who has revised three times is describing a different mission. */
export const MAX_SIGNOFF_REVISIONS = 3;

export interface PrepareDeps {
  store: MissionStore;
  calls: Calls;
  /** Stop after the estimate. No agent is synthesized and no worker runs. */
  planOnly?: boolean;
  unattended?: boolean;
  /**
   * Semantic memory, as a closure rather than a directory (§6).
   *
   * Search before you research, so knowledge accretes instead of duplicating (§5) —
   * but prepare never touches disk, so the composition root binds `readLore` to the
   * lore directory and hands the result in. Absent means this machine has no memory
   * layer, which is a supported mode and not a broken one.
   */
  recall?: () => Recall;
  /** Procedural memory (§6, §7): agents a human promoted from earlier missions, handed
   *  to synthesis as prior art. Bound at the composition root like `recall`, and for
   *  the same reason — prepare never touches disk. */
  profiles?: readonly AgentSpec[];
  /** The transports synthesis may pick on this machine (§7), narrowed from what the
   *  build ships by what was probed on PATH. Bound at the composition root like
   *  `recall` and `profiles`, and for the same reason: prepare probes nothing. */
  transports?: readonly string[];
  /** Absent means nobody is there, which is what `--unattended` amounts to. */
  human?: HumanPort;
  onWarn?(message: string): void;
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

  const human = deps.human ?? unattendedHuman();

  // Memory first, then research (§5, §6). Ahead of the scan rather than beside it,
  // so what the store already knows is in the ledger before anything is paid for —
  // and so the scan's own facts are numbered off a ledger that already holds it.
  if (deps.recall) {
    const { fresh, stale } = deps.recall();
    const consulted = fresh.length + stale.length;
    if (consulted > 0) {
      const recalled = recallToLedger(fresh, stale, at);
      emit({ ...base, type: "memory_recalled", ...recalled, consulted });
    }
  }

  // Scan (§2b): one cheap pass, silent, never blocks. It exists to make intake's
  // questions specific rather than to answer them, so its findings land in the ledger
  // before a single question is asked.
  const scan = await deps.calls.research(buildResearchInput(deps.store.state(), "scan"));
  emit({ ...base, type: "scan_completed", findings: scan.findings, spend: zeroSpend() });

  const beforeScan = deps.store.state().mission.ledger;
  const scanned = appendFacts(beforeScan.factsVerified, scan.findings, at);
  if (scanned.length > beforeScan.factsVerified.length) {
    emit({
      ...base,
      type: "ledger_revised",
      ledger: { ...beforeScan, factsVerified: scanned },
      reason: "research",
    });
  }

  move("intake", "scan complete");
  const given = await runIntake({
    store: deps.store,
    calls: deps.calls,
    human,
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
  });

  if (given.length > 0) {
    const ledger = deps.store.state().mission.ledger;
    emit({
      ...base,
      type: "ledger_revised",
      // Appended, never replaced. `factsGiven` is append-only across replans (§3),
      // and starting that tier off by overwriting it would be an odd precedent.
      ledger: { ...ledger, factsGiven: [...ledger.factsGiven, ...given] },
      reason: "intake",
    });
  }

  move("researching", "intake complete");
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
  // planner needs to know what it is being asked to satisfy. The scan's facts are
  // already there, so research appends rather than replacing — overwriting would drop
  // exactly the findings the intake questions were built on.
  const existing = deps.store.state().mission.ledger;
  // Merged rather than assigned, for the same reason the facts are appended: a stale
  // memory entered as a guess (§6) and the research call knows nothing about it, so
  // assigning here would silently drop the one entry the sign-off screen most needs
  // to show — a fact nobody re-checked.
  const allGuesses = mergeGuesses(existing.guesses, guesses);
  const ledgerWithSpec = {
    ...existing,
    factsVerified: appendFacts(existing.factsVerified, research.findings, at),
    criteria: spec.criteria,
    guesses: allGuesses,
  };
  emit({ ...base, type: "ledger_revised", ledger: ledgerWithSpec, reason: "spec" });

  const planned = await planWithOneRetry(deps);
  if ("message" in planned) return { ok: false, reason: planned.message };

  const estimate = estimatePlan({ plan: planned.tasks, criteriaCount: spec.criteria.length });
  emit({
    ...base,
    type: "ledger_revised",
    ledger: { ...ledgerWithSpec, plan: planned.tasks },
    reason: "replan",
  });
  emit({
    ...base,
    type: "outcome_spec_written",
    criteria: spec.criteria,
    guesses: allGuesses,
    outOfScope,
    estimate,
  });
  emit({ ...base, type: "signoff_requested", estimate });

  const result: PrepareResult = {
    ok: true,
    criteria: spec.criteria,
    plan: planned.tasks,
    estimate,
    brief: research.brief,
  };

  if (deps.planOnly) return result;

  const signedOff = await presentAndSignOff({ ...deps, human });
  return signedOff.ok ? { ...result, plan: signedOff.plan, estimate: signedOff.estimate } : signedOff;
}

export interface PresentDeps {
  store: MissionStore;
  calls: Calls;
  human: HumanPort;
  /** Prior art for synthesis (§7) — sign-off is where the approved plan is staffed,
   *  so this path needs them as much as the replan inside the loop does. */
  profiles?: readonly AgentSpec[];
  /** And the machine's transports for the same reason: sign-off staffs the approved
   *  plan, so an offer wired only into the loop is wired into the wrong half. */
  transports?: readonly string[];
  unattended?: boolean;
  now?: () => string;
}

export type SignoffOutcome =
  | { ok: true; plan: PlannedTask[]; estimate: Estimate }
  | { ok: false; reason: string };

/**
 * Present the plan, take the decision, and replan on feedback until it is approved.
 *
 * Split out from `prepareMission` because sign-off has two entry points and only one
 * of them starts from a fresh plan. `orchestra run` arrives here having just planned;
 * `orchestra resume` arrives at a mission that has been sitting `awaiting_signoff`
 * since last night, with nothing in memory. If the two had separate implementations,
 * the resumed one would be the one nobody exercised, and it is the one that matters —
 * the whole point of the state surviving a restart is that the approval still works.
 *
 * So everything here is read from folded state rather than passed in. That is also
 * what lets the web shell render the same screen from the log alone.
 */
export async function presentAndSignOff(deps: PresentDeps): Promise<SignoffOutcome> {
  const base = { missionId: deps.store.state().mission.id, actor: "orchestrator" as const };
  const emit = (event: EventInput) => deps.store.emit(event);

  const move = (to: Parameters<typeof missionStatus>[0], reason: string) =>
    emit({ ...base, ...missionStatus(to, deps.store.state().mission.status, reason) });

  // Moved before the await, and that ordering is the feature: the process can die on
  // the next line and the log already says what it was waiting for.
  if (deps.store.state().mission.status !== "awaiting_signoff") {
    move("awaiting_signoff", "the plan is ready for a human");
  }

  for (let revision = 0; ; revision++) {
    const state = deps.store.state();
    const { mission } = state;
    const estimate =
      mission.estimate ??
      estimatePlan({ plan: mission.ledger.plan, criteriaCount: mission.ledger.criteria.length });

    const decision = await deps.human.awaitSignoff({
      missionId: mission.id,
      goal: mission.goal,
      brief: state.brief,
      criteria: mission.ledger.criteria,
      guesses: mission.ledger.guesses,
      outOfScope: state.outOfScope,
      envelope: mission.capabilityEnvelope,
      plan: mission.ledger.plan,
      estimate,
    });

    if (decision.kind === "approve") {
      // Synthesis can refuse the approved plan — an unbuilt transport, a capability
      // outside the envelope, a code task that would not name its files (§7, §8). The
      // mission has already been parked by `grantSignoff`; this turns the throw into
      // an exit code and a message rather than a stack trace over an approval the
      // human just gave.
      try {
        await grantSignoff(deps, mission.ledger.plan);
      } catch (error) {
        if (!(error instanceof SynthesisError)) throw error;
        return { ok: false, reason: error.message };
      }
      return { ok: true, plan: mission.ledger.plan, estimate };
    }

    emit({ ...base, type: "signoff_revised", feedback: decision.feedback });

    if (revision + 1 >= MAX_SIGNOFF_REVISIONS) {
      return {
        ok: false,
        reason:
          `The plan was sent back ${MAX_SIGNOFF_REVISIONS} times without being approved. ` +
          `Start a mission whose goal says what the feedback has been asking for.`,
      };
    }

    move("specifying", "revising the plan on feedback");

    const replanned = await planWithOneRetry(deps, decision.feedback);
    if ("message" in replanned) return { ok: false, reason: replanned.message };

    const revised = estimatePlan({
      plan: replanned.tasks,
      criteriaCount: mission.ledger.criteria.length,
    });

    emit({
      ...base,
      type: "ledger_revised",
      ledger: { ...deps.store.state().mission.ledger, plan: replanned.tasks },
      reason: "replan",
    });
    // Re-emitted so the estimate on the screen matches the plan on the screen. The
    // criteria are unchanged and still unfrozen — sign-off has not happened yet, which
    // is the only reason rewriting them here is legal (§3).
    emit({
      ...base,
      type: "outcome_spec_written",
      criteria: mission.ledger.criteria,
      guesses: mission.ledger.guesses,
      outOfScope: state.outOfScope,
      estimate: revised,
    });
    emit({ ...base, type: "signoff_requested", estimate: revised });
    move("awaiting_signoff", "the revised plan is ready for a human");
  }
}

export interface SignoffDeps {
  store: MissionStore;
  calls: Pick<Calls, "synthesize">;
  profiles?: readonly AgentSpec[];
  transports?: readonly string[];
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

  // The mission status is this function's to own, so the park happens here and the
  // rethrow lets the caller decide the exit code. A synthesis failure after sign-off
  // leaves the mission neither `awaiting_signoff` nor `executing`, and saying nothing
  // would leave it in the first — approvable again, against a plan that cannot be
  // staffed.
  try {
    await synthesizeTasks(deps, plan, 0);
  } catch (error) {
    if (error instanceof SynthesisError) {
      deps.store.emit({
        ...base,
        type: "mission_status",
        from: deps.store.state().mission.status,
        to: "blocked",
        reason: error.message,
      });
    }
    throw error;
  }

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
  feedback?: string,
): Promise<Awaited<ReturnType<Calls["plan"]>> | { message: string }> {
  const asked = feedback === undefined ? undefined : `The human sent the last plan back: ${feedback}`;

  // The criteria are in the ledger before planning starts — they are an input to it —
  // so a plan that satisfies none of them is refusable here, before sign-off shows a
  // human a plan that could never complete the mission (defect 32).
  const criteria = () => deps.store.state().mission.ledger.criteria;

  const first = await deps.calls.plan(buildPlanInput(deps.store.state(), asked));
  const check = validatePlan(first.tasks, criteria());
  if (check.ok) return first;

  const second = await deps.calls.plan(
    buildPlanInput(deps.store.state(), `The last plan was rejected: ${check.message}`),
  );
  const recheck = validatePlan(second.tasks, criteria());
  return recheck.ok
    ? second
    : { message: `The planner could not produce a runnable plan: ${recheck.message}` };
}

/**
 * Findings become verified facts, appended to what is already there.
 *
 * Appended rather than assigned because two calls produce them now — the scan and
 * then research — and the ids have to stay unique across both: `motivatedBy` names a
 * fact by id (§4.2), so a second `f1` makes "why does this task exist" answer with
 * the wrong fact. §6's provenance rule is already enforced by `findingSchema`, which
 * rejects an empty source at the boundary.
 *
 * A finding already on record is dropped rather than duplicated. Research is told
 * what is still open, but it is not forbidden from confirming something the scan
 * found, and the same claim twice is noise in every prompt built afterwards.
 */
export function appendFacts(
  existing: readonly Fact[],
  findings: readonly Finding[],
  at: string,
): Fact[] {
  const seen = new Set(existing.map((fact) => `${fact.text} ${fact.source.ref}`));
  const taken = new Set(existing.map((fact) => fact.id));
  const facts = [...existing];
  let next = 1;

  for (const finding of findings) {
    const key = `${finding.claim} ${finding.source}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // The next free `f<n>` rather than the array's length, because memory recalls its
    // own entries into this list first (§6). Off the length, a ledger already holding
    // one recalled fact would start numbering at `f2`, and a later revision that
    // dropped it would hand `f2` out twice — and `motivatedBy` names a fact by id
    // (§4.2), so a reused id points a task's provenance at the wrong thing.
    while (taken.has(`f${next}`)) next++;
    const id = `f${next}`;
    taken.add(id);

    facts.push({
      id,
      text: finding.claim,
      addedRound: 0,
      source: { kind: sourceKind(finding.sourceKind), ref: finding.source },
      observedAt: at,
    });
  }

  return facts;
}

/**
 * Guesses from two sources, kept apart by id.
 *
 * Memory contributes stale facts as guesses before research runs (§6), and the
 * research call knows nothing about them — so assigning its list over the ledger's
 * would drop the one entry the sign-off screen most needs to show, a fact nobody
 * re-checked. A research guess reusing an id is the more recent judgment and wins;
 * everything else is kept.
 */
export function mergeGuesses(existing: readonly Guess[], incoming: readonly Guess[]): Guess[] {
  const restated = new Set(incoming.map((guess) => guess.id));
  return [...existing.filter((guess) => !restated.has(guess.id)), ...incoming];
}

const sourceKind = (kind: Finding["sourceKind"]): Fact["source"]["kind"] =>
  kind === "memory" ? "memory" : "research";

function missionStatus(
  to: "intake" | "researching" | "specifying" | "awaiting_signoff",
  from: ReturnType<MissionStore["state"]>["mission"]["status"],
  reason: string,
) {
  return { type: "mission_status" as const, from, to, reason };
}

// What a mission cost, read off the fold (§9.5).
//
// Every number here has been on disk since Phase 1 and readable by nobody:
// `spend_recorded` carries a phase and a `Spend`, `fold` aggregates it into
// `spendByPhase`, and the only non-test reader of that field was the reducer that
// wrote it. So the question any optimization has to answer — which decision point is
// expensive, which task ran long, how much of the bill is invisible — could not be
// asked of a finished mission.
//
// It is a pure function of folded state, and deliberately *not* a projection file.
// A projection would be a third atomic write on every event to answer a question
// nobody asks mid-mission; folding the log on demand is always correct, costs nothing
// while a mission runs, and keeps "derived, safe to delete" trivially true.
//
// The one rule that is not arithmetic: **unmeasured is a figure, not a zero.** A
// mission run entirely on subscription CLIs spends real money and reports
// `measured: 0`, so `pricedFully` exists to stop a summary reading as free. That is
// the same argument `Spend.tokens.unmeasured` was introduced for.
import {
  CALL_NAMES,
  isCallPhase,
  spendPhase,
  WEB_SEARCH_USD_PER_REQUEST,
  type Spend,
} from "../domain/budget.js";
import { type ModelCard, costOf } from "../providers/modelCard.js";
import { type MissionState } from "./fold.js";

/**
 * Tokens by kind, carried everywhere a token total is.
 *
 * Reported beside `measuredTokens` rather than instead of it: the total is what a
 * budget was checked against and what every log written before this change recorded,
 * and the four kinds are what a reader needs to turn it into money. Each is optional
 * for the reason the whole §9.5 split exists — a transport that did not say is not a
 * transport that said none.
 *
 * `estimatedTokens` is the count that came from a source knowing itself to be a floor,
 * such as a session log whose output figures are snapshots. It is never added to
 * `measuredTokens`; a summary that mixed the two would lose the only thing that makes
 * the smaller number honest.
 */
export interface TokenBreakdown {
  measuredTokens: number;
  estimatedTokens: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * What a phase cost in dollars, when that is knowable — token cost when `input` and
 * `output` are both reported and a verified model card matches what actually ran
 * (PLAN-NEXT 2.5), plus search cost when `webSearchRequests` is present.
 *
 * Absent rather than zero, which is the rule the whole of §9.5 is built on and matters
 * more here than anywhere: most of this system's spend is on subscription CLIs and over
 * ACP, neither of which is priced by a card at all. A zero would read as free.
 *
 * **It prices the call this orchestrator made, and only that.** A worker running under
 * `acp/opencode` on a DeepSeek model is billed on OpenCode's contract, not on the
 * provider's rate card, so token `costUsd` is absent there even when the id matches —
 * the card's rates are a claim about the provider's own API and nothing else. What
 * makes that check possible is the same field the pricing hazard came from: `ranOn`.
 * Web-search dollars are a separate Anthropic line item and do not need a card.
 */
export interface Priced {
  costUsd?: number;
  /** Anthropic web-search requests on this row. Absent, never 0-by-default. */
  webSearchRequests?: number;
}

export interface CallMetrics extends TokenBreakdown, Priced {
  call: string;
  /** How many times it ran. `dispatches` on the accumulated `Spend`. */
  calls: number;
  wallMs: number;
}

export interface TaskMetrics extends TokenBreakdown, Priced {
  taskId: string;
  worker: string;
  status: string;
  attempts: number;
  /** `id/target`, e.g. `acp/claude` — the two halves that decide what actually ran. */
  transport: string;
  /** What the spec asked for. */
  model: string;
  /** What the transport reported actually running, where it said. Absent is the common
   *  case; *different from `model`* is the case worth printing, because ACP never sends
   *  the spec's model and a mission priced against `model` would then be priced against
   *  a model that never ran. */
  ranOn?: string;
  wallMs: number;
  /** Dispatches whose transport reported no usage. Not a zero cost — an unknown one. */
  unmeasuredDispatches: number;
}

/** A phase that is neither a known decision point nor a task on this board — an older
 *  log's vocabulary, most often the `"orchestration"` bucket that predates the
 *  per-call split. Reported rather than dropped, so an old mission's spend does not
 *  vanish from its own summary. */
export interface OtherMetrics extends TokenBreakdown, Priced {
  phase: string;
  wallMs: number;
  unmeasuredDispatches: number;
}

export interface MissionMetrics {
  missionId: string;
  status: string;
  rounds: number;
  /** Whether the human ticked `quick` at compose time. Carried here because the whole
   *  reason to collect any of this is comparing the two shapes on the same goal. */
  quick: boolean;
  totals: TokenBreakdown & Priced & {
    wallMs: number;
    unmeasuredDispatches: number;
    dispatches: number;
    /** False when anything ran on a transport that could not report usage, or reported
     *  a figure it knows to be a floor — the difference between "this mission was
     *  cheap" and "we cannot say". */
    pricedFully: boolean;
  };
  calls: CallMetrics[];
  tasks: TaskMetrics[];
  other: OtherMetrics[];
}

/**
 * One decision point's bill, beside what it was staffed to and what its answer cost
 * downstream (PLAN-NEXT 4.4).
 *
 * The downstream columns are the point of the report and the reason it is not just
 * `MissionMetrics.calls` with a card column added. A cheap model that plans badly is not
 * cheap: the plan comes back, a human sends it back at sign-off, and the mission pays for
 * the replan and everything after it. Tokens alone would rank that model first.
 *
 * Each count is an existing event attributed to the call whose answer it is a verdict on,
 * and there are exactly three because there are exactly three such events — nothing here
 * is inferred, and a decision point with no verdict event of its own reports none rather
 * than a zero standing in for one.
 */
export interface StaffingMetrics extends TokenBreakdown, Priced {
  call: string;
  /** The card this mission staffed the call to, from `mission_created`. Absent means the
   *  Agent SDK, which is every call on every mission before PLAN-NEXT 4. */
  staffedTo?: string;
  /** What the transport said actually answered (`modelByPhase`). Absent where it said
   *  nothing, which is every Agent SDK call — the provider path always says. */
  ranOn?: string;
  calls: number;
  wallMs: number;
  /** How often this call's own answer was refused or sent back: `outcome_spec_rejected`
   *  for `research`, `signoff_revised` for `plan`, `envelope_violation` for `synthesize`.
   *  Absent for the calls that have no such event rather than reported as `0`. */
  sentBack?: number;
}

/** Which event is a verdict on which decision point's answer. Three, because three exist:
 *  the outcome-spec gate refuses `research`'s criteria, a human sends `plan`'s plan back
 *  at sign-off, and `inspect()` refuses `synthesize`'s spec against the envelope. */
const VERDICT_EVENTS: Readonly<Record<string, string>> = {
  research: "outcome_spec_rejected",
  // The outcome-spec gate refuses the architect's criteria on an ordinary mission and
  // research's on a quick one (PLAN-NEXT 5.1), so both rows point at the same event and
  // only one of them ran. `plan_critiqued` is the critic's verdict on the plan, which is
  // what answers "is the critic paying for itself" — one replan per objection set.
  architect: "outcome_spec_rejected",
  plan: "signoff_revised",
  // How often the critic found something. It is the critic's answer being *acted on*
  // rather than refused, which is the one honest exception in this table — and it is the
  // number the stage exists to produce: objections against `call:critique`'s cost and
  // `call:plan`'s extra dispatch is whether the critic pays for itself.
  critique: "plan_critiqued",
  synthesize: "envelope_violation",
};

/**
 * Per decision point: what it ran on, what it cost, and how often its answer came back.
 *
 * Takes the events as well as the fold because two of the three verdicts leave no trace
 * in `MissionState` — a rejection is a fact about a moment rather than about the state
 * that survived it. Counting them here rather than folding them into the mission keeps
 * `fold` answering only what the loop needs to make its next decision.
 */
export function staffingMetrics(
  state: MissionState,
  events: readonly { type: string }[],
  cards: readonly ModelCard[] = [],
): StaffingMetrics[] {
  const byPhase = state.mission.spendByPhase;
  const modelByPhase = state.mission.modelByPhase;
  const staffing = state.mission.staffing as Readonly<Record<string, string | undefined>>;
  const byId = new Map(cards.map((card) => [card.id, card]));

  return CALL_NAMES.flatMap((call) => {
    const phase = spendPhase(call);
    const spend = byPhase[phase];
    if (spend === undefined) return [];

    const verdict = VERDICT_EVENTS[call];
    return [
      {
        call,
        ...(staffing[call] === undefined ? {} : { staffedTo: staffing[call]! }),
        ...(modelByPhase[phase] === undefined ? {} : { ranOn: modelByPhase[phase]! }),
        calls: spend.dispatches,
        wallMs: spend.wallMs,
        ...breakdown(spend),
        ...priced(spend, modelByPhase[phase], byId),
        ...(verdict === undefined
          ? {}
          : { sentBack: events.filter((event) => event.type === verdict).length }),
      },
    ];
  });
}

/** The token half of a `Spend`, as a report line. Written once and spread everywhere,
 *  so a fifth kind is added in one place rather than in four. */
function breakdown(spend: Spend | undefined): TokenBreakdown {
  const tokens = spend?.tokens;
  return {
    measuredTokens: tokens?.measured ?? 0,
    estimatedTokens: tokens?.estimated ?? 0,
    ...(tokens?.input === undefined ? {} : { input: tokens.input }),
    ...(tokens?.output === undefined ? {} : { output: tokens.output }),
    ...(tokens?.cacheRead === undefined ? {} : { cacheRead: tokens.cacheRead }),
    ...(tokens?.cacheWrite === undefined ? {} : { cacheWrite: tokens.cacheWrite }),
  };
}

const addBreakdown = (a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown => {
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const kinds = {
    input: sum(a.input, b.input),
    output: sum(a.output, b.output),
    cacheRead: sum(a.cacheRead, b.cacheRead),
    cacheWrite: sum(a.cacheWrite, b.cacheWrite),
  };
  return {
    measuredTokens: a.measuredTokens + b.measuredTokens,
    estimatedTokens: a.estimatedTokens + b.estimatedTokens,
    ...Object.fromEntries(Object.entries(kinds).filter(([, value]) => value !== undefined)),
  };
};

/**
 * What one phase cost, priced against the card for the model that *actually ran*
 * and against Anthropic's web-search line item when the count is present.
 *
 * `modelByPhase` and never `AgentSpec.model`, and the difference is a real 5× error this
 * repository has already made: ACP is not told the spec's model, so a task specced
 * `claude-sonnet-4-5` ran on `claude-opus-4-6` and a log priced against the spec would
 * have looked precise and been wrong. What did not run cannot be what was billed.
 *
 * Token cost still needs both kinds and a card. Search cost does not: it is a
 * published Anthropic rate and applies even when no factory card can price the
 * tokens — the `--research-web` case. `costUsd` is the sum of whichever halves
 * exist, and absent when neither does.
 */
function priced(
  spend: Spend | undefined,
  ranOn: string | undefined,
  byId: ReadonlyMap<string, ModelCard>,
): Priced {
  const card = ranOn === undefined ? undefined : byId.get(ranOn);
  const { input, output } = spend?.tokens ?? {};
  const tokenCost =
    card !== undefined && input !== undefined && output !== undefined
      ? costOf(card, { input, output })
      : undefined;
  const searches = spend?.webSearchRequests;
  const searchCost =
    searches === undefined ? undefined : searches * WEB_SEARCH_USD_PER_REQUEST;
  const costUsd =
    tokenCost === undefined && searchCost === undefined
      ? undefined
      : (tokenCost ?? 0) + (searchCost ?? 0);
  return {
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(searches === undefined ? {} : { webSearchRequests: searches }),
  };
}

/**
 * @param cards The verified model cards this machine holds (`staffableCards`). Empty is
 *   the normal case and prices nothing, which is why every caller that has none may omit
 *   it — an unpriced mission is the behaviour every mission had before cards existed.
 */
export function missionMetrics(
  state: MissionState,
  cards: readonly ModelCard[] = [],
): MissionMetrics {
  const byPhase = state.mission.spendByPhase;
  const modelByPhase = state.mission.modelByPhase;
  const byId = new Map(cards.map((card) => [card.id, card]));

  // Reported in `CALL_NAMES` order rather than insertion order, so two runs of the
  // same mission produce line-by-line comparable output — which is the entire point
  // of collecting this.
  const calls: CallMetrics[] = CALL_NAMES.flatMap((call) => {
    const phase = spendPhase(call);
    const spend = byPhase[phase];
    return spend === undefined
      ? []
      : [
          {
            call,
            calls: spend.dispatches,
            wallMs: spend.wallMs,
            ...breakdown(spend),
            ...priced(spend, modelByPhase[phase], byId),
          },
        ];
  });

  const tasks: TaskMetrics[] = state.tasks.map((task) => {
    const spend = byPhase[task.id];
    const { transport, model } = task.agentSpec;
    return {
      taskId: task.id,
      worker: task.worker,
      status: task.status,
      attempts: task.attempts,
      transport: transport.target ? `${transport.id}/${transport.target}` : transport.id,
      model: transport.model ?? model,
      ...(modelByPhase[task.id] === undefined ? {} : { ranOn: modelByPhase[task.id] }),
      wallMs: spend?.wallMs ?? 0,
      ...breakdown(spend),
      ...priced(spend, modelByPhase[task.id], byId),
      unmeasuredDispatches: spend?.tokens.unmeasured ?? 0,
    };
  });

  // A phase that recorded nothing at all is dropped, and that is not the same call as
  // dropping an unrecognised one. `prepare.ts` emits `scan_completed` and
  // `research_completed` with a hardcoded `zeroSpend()`, so every mission carries
  // `scan` and `research` phases that are zero by construction and never held a
  // figure — listing them invites the reader to conclude the scan was free, when the
  // real cost was recorded separately under its own call phase.
  const known = new Set([...state.tasks.map((task) => task.id)]);
  const other: OtherMetrics[] = Object.entries(byPhase)
    .filter(([phase]) => !isCallPhase(phase) && !known.has(phase))
    .filter(([, spend]) => spend.wallMs > 0 || spend.dispatches > 0 || spend.tokens.measured > 0)
    .map(([phase, spend]) => ({
      phase,
      wallMs: spend.wallMs,
      ...breakdown(spend),
      ...priced(spend, modelByPhase[phase], byId),
      unmeasuredDispatches: spend.tokens.unmeasured,
    }));

  // Summed over the phases that *could* be priced, and absent when none could. A total
  // of `0` on a mission with no cards would be a claim that it was free; absent says
  // what is true, which is that this run's spend is not on a metered contract we hold.
  // Search cost rides the same reduce so a `--research-web` mission's total cannot
  // forget the line item that `priced` just counted.
  const { costUsd, webSearchRequests } = Object.entries(byPhase).reduce<{
    costUsd: number | undefined;
    webSearchRequests: number | undefined;
  }>(
    (running, [phase, spend]) => {
      const part = priced(spend, modelByPhase[phase], byId);
      const add = (x: number | undefined, y: number | undefined): number | undefined =>
        x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
      return {
        costUsd: add(running.costUsd, part.costUsd),
        webSearchRequests: add(running.webSearchRequests, part.webSearchRequests),
      };
    },
    { costUsd: undefined, webSearchRequests: undefined },
  );

  // Summed over the record rather than over the three lists above, so a phase that is
  // somehow in none of them still reaches the total. A cost the summary cannot place
  // is still a cost.
  const totals = Object.values(byPhase).reduce(
    (running, spend: Spend) => ({
      ...addBreakdown(running, breakdown(spend)),
      wallMs: running.wallMs + spend.wallMs,
      unmeasuredDispatches: running.unmeasuredDispatches + spend.tokens.unmeasured,
      dispatches: running.dispatches + spend.dispatches,
    }),
    {
      wallMs: 0,
      measuredTokens: 0,
      estimatedTokens: 0,
      unmeasuredDispatches: 0,
      dispatches: 0,
    },
  );

  return {
    missionId: state.mission.id,
    status: state.mission.status,
    rounds: state.mission.round,
    quick: state.mission.quick,
    totals: {
      ...totals,
      // An estimate is not a price. A mission with an estimated figure is one whose
      // real cost is higher by an unknown amount, which is the same claim an
      // unmeasured dispatch makes and deserves the same flag.
      pricedFully: totals.unmeasuredDispatches === 0 && totals.estimatedTokens === 0,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(webSearchRequests === undefined ? {} : { webSearchRequests }),
    },
    calls,
    tasks,
    other,
  };
}

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
import { CALL_NAMES, isCallPhase, spendPhase, type Spend } from "../domain/budget.js";
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

export interface CallMetrics extends TokenBreakdown {
  call: string;
  /** How many times it ran. `dispatches` on the accumulated `Spend`. */
  calls: number;
  wallMs: number;
}

export interface TaskMetrics extends TokenBreakdown {
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
export interface OtherMetrics extends TokenBreakdown {
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
  totals: TokenBreakdown & {
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

export function missionMetrics(state: MissionState): MissionMetrics {
  const byPhase = state.mission.spendByPhase;
  const modelByPhase = state.mission.modelByPhase;

  // Reported in `CALL_NAMES` order rather than insertion order, so two runs of the
  // same mission produce line-by-line comparable output — which is the entire point
  // of collecting this.
  const calls: CallMetrics[] = CALL_NAMES.flatMap((call) => {
    const spend = byPhase[spendPhase(call)];
    return spend === undefined
      ? []
      : [{ call, calls: spend.dispatches, wallMs: spend.wallMs, ...breakdown(spend) }];
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
      unmeasuredDispatches: spend.tokens.unmeasured,
    }));

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
    },
    calls,
    tasks,
    other,
  };
}

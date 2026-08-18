// What a mission is allowed to spend, and what it actually spent.
//
// `wallMs` is required and the token ceiling is not, which is the §9.5 argument
// expressed in the type: subscription CLIs do not report tokens, so a mission run
// on them has no meaningful token ceiling and `dispatches` is the crude limit that
// still works there.
import { z } from "zod";

export const budgetSchema = z.object({
  wallMs: z.number().int().positive(),
  tokens: z.number().int().positive().optional(),
  dispatches: z.number().int().positive().optional(),
});

// Tokens are counted on two axes, and conflating them is what made a mission's cost
// underivable from its own log.
//
// **How well it is known** — `measured` / `estimated` / `unmeasured`. The three-way
// split is the point: a single number that silently omits every CLI worker reads as a
// cheap mission when most of the spend is invisible.
//
// **What kind of token it is** — `input` / `output` / `cacheRead` / `cacheWrite`.
// Input and output differ by five times in price and cache reads by ten, so a total
// that adds them is a number nobody can price. All four are optional because absent
// and zero are different claims — the same rule `unmeasured` exists to hold. When
// `input` and `output` are both present, `measured` is their sum, which keeps every
// existing reader (`budgetExceeded`, the receipts log) correct without a migration.
export const spendSchema = z.object({
  tokens: z.object({
    measured: z.number().int().nonnegative(),
    estimated: z.number().int().nonnegative(),
    unmeasured: z.number().int().nonnegative(),
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
    /** Cached input the model re-read. Billed at a tenth of input and routinely the
     *  largest number in an agentic session — a breakdown without it reports a
     *  worker that read 288k tokens of context as having read twelve. */
    cacheRead: z.number().int().nonnegative().optional(),
    cacheWrite: z.number().int().nonnegative().optional(),
  }),
  wallMs: z.number().int().nonnegative(),
  dispatches: z.number().int().nonnegative(),
  /** Anthropic `server_tool_use.web_search_requests`. Not a token kind — a
   *  separate line item, so it lives beside `tokens` rather than inside it.
   *  Optional because absent and zero are different claims. */
  webSearchRequests: z.number().int().nonnegative().optional(),
});

/** Anthropic's web-search line item: $10 per 1,000 requests. */
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1_000;

export type Budget = z.infer<typeof budgetSchema>;
export type Spend = z.infer<typeof spendSchema>;

/**
 * The decision points by name, at runtime (§3). Eight since PLAN-NEXT 5: `architect`
 * writes the outcome spec the deep research pass used to, and `critique` attacks the
 * plan before it is validated.
 *
 * They live here rather than beside the `Calls` interface for a layering reason:
 * `spend_recorded.phase` is read by a breakdown in `events/`, and `events/` never
 * imports `loop/`. `keyof Calls` also does not survive to runtime, and classifying a
 * phase string needs it to. The link between the two is asserted in `loop/calls.test.ts`
 * against a total `Record<keyof Calls, true>` — adding a seventh decision point and
 * forgetting this constant is a compile error there, not a silently unattributed cost.
 */
export const CALL_NAMES = [
  "research",
  "architect",
  "intake",
  "plan",
  "critique",
  "synthesize",
  "progress",
  "judge",
] as const;

export type CallName = (typeof CALL_NAMES)[number];

/**
 * The `phase` a decision point's spend is recorded under (§9.5).
 *
 * Prefixed because the field holds two vocabularies at once — `dispatch` writes a
 * task's id there — and a breakdown that cannot tell them apart reports the
 * orchestrator's research call as a task. It replaces the constant `"orchestration"`,
 * which collapsed all six into one number and made "which call is expensive?"
 * unanswerable.
 */
export const spendPhase = (call: CallName): string => `call:${call}`;

/** Whether a recorded phase is a decision point rather than a task. Membership in the
 *  known set, not a prefix match: a task id comes out of a model-written plan and
 *  nothing forbids one that starts with `call:`. */
export const isCallPhase = (phase: string): boolean =>
  CALL_NAMES.some((call) => spendPhase(call) === phase);

export const zeroSpend = (): Spend => ({
  tokens: { measured: 0, estimated: 0, unmeasured: 0 },
  wallMs: 0,
  dispatches: 0,
});

/**
 * What a transport reported, in this codebase's names rather than an API's.
 *
 * Every field is optional and one may arrive without the others: `claude -p` reports
 * all four, an SDK result reports all four, and a session log read after the fact
 * reports three exactly and the fourth as a floor. A shape that required them together
 * would force a zero where there is no measurement.
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** True when a usage report contains nothing recognisable. A transport that answered
 *  with an unparseable usage block has not reported zero tokens — it has not reported. */
export const isEmptyUsage = (usage: TokenUsage): boolean =>
  usage.input === undefined &&
  usage.output === undefined &&
  usage.cacheRead === undefined &&
  usage.cacheWrite === undefined;

/**
 * Anthropic's `server_tool_use.web_search_requests`, or nothing.
 *
 * Missing `server_tool_use` and a non-number count are the same claim: the
 * transport did not report searches. A throw here would turn a usage shape we
 * have not seen yet into a failed decision point, which is worse than leaving
 * the field absent.
 */
export function webSearchRequestsOf(usage: {
  server_tool_use?: { web_search_requests?: unknown } | null;
}): number | undefined {
  const n = usage.server_tool_use?.web_search_requests;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * A usage report as the token half of a `Spend`.
 *
 * `measured` stays `input + output` and deliberately excludes cache: it is the number
 * `budgetExceeded` compares a ceiling against, every log written before this change
 * means it that way, and `receipt.test.ts` replays one of them. Cache is reported
 * beside it rather than folded into it, so a reader can price all four and a ceiling
 * keeps meaning what it meant.
 *
 * `estimatedOutput` is for the one source that knows its output figure is a floor
 * (§9.5): the count lands in `estimated`, never in `measured`, and the kind breakdown
 * still carries it so the report can say what kind of token was estimated.
 */
export function tokensFrom(
  usage: TokenUsage,
  options: { estimatedOutput?: boolean } = {},
): Spend["tokens"] {
  const floor = options.estimatedOutput === true;
  const output = usage.output ?? 0;

  return {
    measured: (usage.input ?? 0) + (floor ? 0 : output),
    estimated: floor ? output : 0,
    unmeasured: 0,
    ...(usage.input === undefined ? {} : { input: usage.input }),
    ...(usage.output === undefined ? {} : { output: usage.output }),
    ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
  };
}

/** Absent plus absent is absent; absent plus a number is that number. Summing an
 *  unreported field as zero would turn "this transport does not say" into "this
 *  transport says none", which is the whole distinction `unmeasured` protects. */
const addKind = (x: number | undefined, y: number | undefined): number | undefined =>
  x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);

/** The optional half of a token count, summed. Written out rather than spread so that
 *  adding a fifth kind is a compile error here rather than a silently dropped column. */
function addKinds(a: Spend["tokens"], b: Spend["tokens"]): Partial<Spend["tokens"]> {
  const kinds = {
    input: addKind(a.input, b.input),
    output: addKind(a.output, b.output),
    cacheRead: addKind(a.cacheRead, b.cacheRead),
    cacheWrite: addKind(a.cacheWrite, b.cacheWrite),
  };
  return Object.fromEntries(Object.entries(kinds).filter(([, value]) => value !== undefined));
}

export function addSpend(a: Spend, b: Spend): Spend {
  const webSearchRequests = addKind(a.webSearchRequests, b.webSearchRequests);
  return {
    tokens: {
      measured: a.tokens.measured + b.tokens.measured,
      estimated: a.tokens.estimated + b.tokens.estimated,
      unmeasured: a.tokens.unmeasured + b.tokens.unmeasured,
      ...addKinds(a.tokens, b.tokens),
    },
    wallMs: a.wallMs + b.wallMs,
    dispatches: a.dispatches + b.dispatches,
    ...(webSearchRequests === undefined ? {} : { webSearchRequests }),
  };
}

export function addBudget(a: Budget, b: Budget): Budget {
  const sum = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    wallMs: a.wallMs + b.wallMs,
    tokens: sum(a.tokens, b.tokens),
    dispatches: sum(a.dispatches, b.dispatches),
  };
}

// Wall-clock is the primary ceiling; the other two only bind when they were set.
export function budgetExceeded(budget: Budget, spend: Spend): boolean {
  if (spend.wallMs >= budget.wallMs) return true;
  if (budget.tokens !== undefined && spend.tokens.measured >= budget.tokens) return true;
  if (budget.dispatches !== undefined && spend.dispatches >= budget.dispatches) return true;
  return false;
}

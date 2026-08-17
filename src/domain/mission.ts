// The top-level object. A mission owns a task ledger, a per-round progress ledger,
// the envelope its synthesized agents may draw from, and the counters that decide
// when it stops.
import { z } from "zod";
import { budgetSchema, spendSchema } from "./budget.js";
import { envelopeSchema } from "./envelope.js";
import { progressLedgerSchema, taskLedgerSchema } from "./ledger.js";

export const missionStatusSchema = z.enum([
  "scanning",
  "intake",
  "researching",
  "specifying",
  "awaiting_signoff",
  "executing",
  "replanning",
  "blocked",
  "complete",
  "abandoned",
]);

// Arithmetic over the plan, not another model call. Shown at sign-off, because
// approve-or-revise is not a real decision without it.
//
// There is no token figure here on purpose — see `loop/estimate.ts` for why the one
// that used to be was withdrawn rather than recalibrated. Logs written before that
// still carry `tokens`; this schema is not strict, so the field is dropped on replay
// and an older mission folds unchanged.
export const estimateSchema = z.object({
  taskCount: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(), // critical path through the DAG
  expectedGates: z.number().int().nonnegative(),
});

/**
 * What the human chose about *how* this mission runs, as opposed to what it is for.
 *
 * Every field is optional and absent means "whatever this machine offers", which is the
 * behaviour every mission had before a harness could be picked — and the reason a
 * composed mission needs no choice made to start. Setup simplicity is a hard constraint
 * (§2a), so this is an override and never a prerequisite.
 *
 * It lives on the mission rather than in a runtime option for the same reason `quick`
 * does: `orchestra resume` rebuilds everything it knows by folding the log, so a choice
 * held only in process memory would silently change what a mission runs on when it is
 * carried on the next morning. Recording it is also what makes `orchestra metrics
 * --json` worth diffing between two runs of one goal, which is the whole point of
 * collecting the figures.
 *
 * `harness` is a `<transport>/<target>` id (`workers/harness.ts`) and never two fields,
 * because the pair was never independent — `acp/opencode` does not exist however
 * plausible the cross-product looks.
 */
export const missionRuntimeSchema = z.object({
  harness: z.string().min(1).optional(),
  /** A ceiling on `AgentSpec.model`, enforced in `loop/synthesize.ts`. Not honoured by
   *  an `acp` adapter, which picks its own model and is never told ours — the figure
   *  that stays true either way is `modelByPhase`, which records what ran. */
  workerModel: z.string().min(1).optional(),
  /** The model the six decision points run on, overriding `ORCHESTRATOR_MODEL` for this
   *  mission only. `progress` still runs on its own cheaper model (§3). */
  orchestratorModel: z.string().min(1).optional(),
});

/**
 * Which model card runs which decision point (PLAN-NEXT 4.1).
 *
 * A card id per call, and absent everywhere is today's behaviour byte for byte: every
 * decision point goes through `loop/agentCalls.ts` and the Agent SDK, exactly as it did
 * before this field existed. A staffed one goes through `loop/providerCalls.ts` instead,
 * on the provider the card names.
 *
 * It lives on the mission for `runtime`'s reason: `orchestra resume` rebuilds everything
 * it knows by folding the log, so a routing choice held only in process memory would
 * silently move a mission back onto the default model when it is carried on the next
 * morning — and `metrics --staffing`, which exists to tell one staffing from another,
 * would be comparing runs whose staffing it could not see.
 *
 * **`judge` is deliberately not staffable.** §3's one exception to the no-tools rule is
 * the judge, which reads the artifacts it grades with `Read`/`Glob`/`Grep`; the provider
 * path has no tools at all and cannot grow them from a chat completion. A judge there
 * would answer `met: false` on work that was done correctly and say honestly that it
 * could not open the files — defects 22 and 40, rebuilt one layer along. So the field
 * is absent rather than accepted-and-ignored, and `staffableCalls` is the list every
 * door checks against.
 */
export const missionStaffingSchema = z.object({
  research: z.string().min(1).optional(),
  /** The architect writes the outcome spec and a design note over what research found
   *  (PLAN-NEXT 5.1). Staffable because it reasons over the prompt and reads nothing —
   *  the judge test applied to a new call, and it passes. */
  architect: z.string().min(1).optional(),
  intake: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  /** The plan critic (PLAN-NEXT 5.3), staffable for `architect`'s reason: it is handed
   *  the breakdown and argues with it, and opens no file to do so. */
  critique: z.string().min(1).optional(),
  synthesize: z.string().min(1).optional(),
  progress: z.string().min(1).optional(),
});

export type MissionStaffing = z.infer<typeof missionStaffingSchema>;

/** The decision points a card may be staffed to, in `CALL_NAMES` order. Derived from the
 *  schema rather than written out again, so the two cannot drift. */
export const staffableCalls = (): (keyof MissionStaffing)[] =>
  Object.keys(missionStaffingSchema.shape) as (keyof MissionStaffing)[];

export const missionSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1), // the human's original words, verbatim
  ledger: taskLedgerSchema,
  progress: progressLedgerSchema.optional(),
  capabilityEnvelope: envelopeSchema,
  status: missionStatusSchema,
  round: z.number().int().nonnegative(),
  stalls: z.number().int().nonnegative(),
  resets: z.number().int().nonnegative(),
  budget: budgetSchema,
  spend: spendSchema,
  spendByPhase: z.record(z.string(), spendSchema),
  /** Phase → the model that actually produced its spend, where the transport said so.
   *  Separate from `AgentSpec.model`, which records what was *asked for*: ACP never
   *  sends the spec's model, so the two differ and only this one can be priced. */
  modelByPhase: z.record(z.string(), z.string()).default({}),
  extensions: z.number().int().nonnegative(),
  estimate: estimateSchema.optional(),
  // Criteria are frozen from this moment (§3).
  signedOffAt: z.string().optional(),
  unattended: z.boolean(),
  /** The human said at compose time that this job is small: one light research pass
   *  and a plan of one task rather than a decomposition. Folded from `mission_created`
   *  so a resumed mission keeps the shape it was started with. */
  quick: z.boolean(),
  /** How this mission runs, as chosen at compose time. Defaulted rather than optional
   *  so every reader gets an object and nothing has to ask whether it was recorded. */
  runtime: missionRuntimeSchema.default({}),
  /** Which decision points run on a model card rather than through the Agent SDK.
   *  Defaulted rather than optional for `runtime`'s reason: every reader gets an object
   *  and nothing has to ask whether the choice was recorded. */
  staffing: missionStaffingSchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type Estimate = z.infer<typeof estimateSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type MissionRuntime = z.infer<typeof missionRuntimeSchema>;

// Defaults for the counters that live in code rather than in a prompt (§3).
export const LIMITS = {
  maxRounds: 20,
  maxStalls: 3,
  maxResets: 3,
  maxExtensions: 2,
} as const;

/** The same four as plain numbers. `typeof LIMITS` carries literal types, so a
 *  mission that lowers a ceiling would be rejected by the type of the default. */
export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

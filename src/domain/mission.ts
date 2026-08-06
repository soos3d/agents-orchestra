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
export const estimateSchema = z.object({
  taskCount: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(), // in-process work only — see §9.5
  wallMs: z.number().int().nonnegative(), // critical path through the DAG
  expectedGates: z.number().int().nonnegative(),
});

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
  extensions: z.number().int().nonnegative(),
  estimate: estimateSchema.optional(),
  // Criteria are frozen from this moment (§3).
  signedOffAt: z.string().optional(),
  unattended: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type Estimate = z.infer<typeof estimateSchema>;
export type Mission = z.infer<typeof missionSchema>;

// Defaults for the counters that live in code rather than in a prompt (§3).
export const LIMITS = {
  maxRounds: 20,
  maxStalls: 3,
  maxResets: 3,
  maxExtensions: 2,
} as const;

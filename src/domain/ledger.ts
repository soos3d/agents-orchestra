// The two ledgers (§3). The task ledger is the outer loop's working memory and is
// what makes a replan informed rather than a retry; the progress ledger is
// recomputed every round and answers whether to continue, replan, or stop.
import { z } from "zod";
import {
  evidenceSchema,
  verifySpecSchema,
  verifySpecWithoutScannerSchema,
} from "./artifacts.js";
import { allowedFetchHost } from "./envelope.js";
import { workerKindSchema } from "./task.js";

// Every entry is addressable because a task has to be able to name what produced it.
// Without ids, "why does this task exist" has no answer and a falsified guess has no
// blast radius (§4.2).
export const ledgerEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  addedRound: z.number().int().nonnegative(),
});

export const factSchema = ledgerEntrySchema.extend({
  source: z.object({
    kind: z.enum(["human", "memory", "research", "worker"]),
    ref: z.string(),
  }),
  observedAt: z.string(),
  // A stale semantic memory enters the ledger as a Guess, never as a Fact (§6).
  stale: z.boolean().optional(),
});

export const guessSchema = ledgerEntrySchema.extend({
  confidence: z.enum(["high", "medium", "low"]),
  basis: z.string(),
  // The task that disproved it. Drives the §4.2 blast radius.
  falsifiedBy: z.string().optional(),
});

export const deadEndSchema = ledgerEntrySchema.extend({
  approach: z.string().min(1),
  evidence: z.string(),
  // `gate_denied` is the §9.4 rule made structural: a human declining a gate is an
  // answer, and recording it stops the next replan proposing the same payment.
  source: z.enum(["verification", "worker", "gate_denied", "human"]),
});

export const criterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  // REQUIRED. A criterion the system cannot evaluate means the progress ledger can
  // never legitimately set isRequestSatisfied, and the mission runs to its reset cap
  // for nothing.
  check: verifySpecSchema,
  met: z.boolean().optional(),
  evidence: evidenceSchema.optional(),
  lastCheckedRound: z.number().int().nonnegative().optional(),
});

// Shown to a criteria-authoring call on a mission that granted no scanner. Rendered
// into the prompt only — nothing parses against it, because `writeOutcomeSpec` is
// still the door and it refuses an ungranted scanner whatever the prompt showed.
export const criterionSchemaWithoutScanner = criterionSchema.extend({
  check: verifySpecWithoutScannerSchema,
});

export const findingSchema = z.object({
  claim: z.string().min(1),
  // Required. A finding with an empty source is rejected and re-entered as a guess,
  // so an unsourced assertion cannot become factsVerified and then ground truth.
  source: z.string().min(1),
  sourceKind: z.enum(["memory", "codebase", "web"]),
  confidence: z.enum(["high", "medium", "low"]),
});

// Intent. A Task is intent that has been synthesized and can run — keeping them
// separate is what lets --plan-only produce a plan and an estimate with no AgentSpec.
export const plannedTaskSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  worker: workerKindSchema,
  satisfies: z.array(z.string()),
  motivatedBy: z.array(z.string()),
  dependsOn: z.array(z.string()),
  estimatedWallMs: z.number().int().positive(),
});

export const taskLedgerSchema = z.object({
  factsGiven: z.array(ledgerEntrySchema),
  factsVerified: z.array(factSchema),
  factsToLookUp: z.array(ledgerEntrySchema),
  factsToDerive: z.array(ledgerEntrySchema),
  guesses: z.array(guessSchema),
  deadEnds: z.array(deadEndSchema),
  criteria: z.array(criterionSchema),
  plan: z.array(plannedTaskSchema),
});

// `isInLoop` and `isProgressBeingMade` are different failures needing different
// responses. Not progressing means the work is hard — keep going. In a loop means
// the work is repeating — replan now.
export const progressLedgerSchema = z.object({
  isRequestSatisfied: z.boolean(),
  isInLoop: z.boolean(),
  isProgressBeingMade: z.boolean(),
  nextTasks: z.array(z.string()),
  instruction: z.string(),
  unmetCriteria: z.array(z.string()),
});

export const criterionDiffSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), criterion: criterionSchema }),
  z.object({ op: z.literal("remove"), criterionId: z.string(), reason: z.string() }),
  // Carries `from` as well as `to` so the sign-off screen renders the diff from the
  // event alone, without reading a ledger that has moved on since.
  z.object({
    op: z.literal("amend"),
    criterionId: z.string(),
    from: criterionSchema,
    to: criterionSchema,
    reason: z.string(),
  }),
]);

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type Fact = z.infer<typeof factSchema>;
export type Guess = z.infer<typeof guessSchema>;
export type DeadEnd = z.infer<typeof deadEndSchema>;
export type Criterion = z.infer<typeof criterionSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type PlannedTask = z.infer<typeof plannedTaskSchema>;
export type TaskLedger = z.infer<typeof taskLedgerSchema>;
export type ProgressLedger = z.infer<typeof progressLedgerSchema>;
export type CriterionDiff = z.infer<typeof criterionDiffSchema>;

/**
 * The findings a mission is allowed to believe: everything except a `"web"` finding
 * the mission could not have fetched (PLAN-NEXT 11.3).
 *
 * The other half of `Envelope.research`, and it moves in the same commit as the prompt
 * that asks for a fetched URL — the standing rule that a prompt and its validation move
 * together. A closed mission's research call has no tools, so a finding it sources to a
 * URL is a recollection wearing a citation; kept, it enters `factsVerified` and becomes
 * ground truth the next mission is told not to re-verify.
 *
 * A *granted* mission is the same failure one grant along, and the first real run wrote
 * both shapes: a mission granted `nodejs.org` returned findings sourced to
 * `WebFetch refusal for https://developer.mozilla.org/…`, and a mission granted
 * `example.com` returned twelve `nodejs.org` URLs it had only ever seen in search
 * snippets. So the grant is checked per finding rather than believed wholesale —
 * `allowedFetchHost`, the same function `canUseTool` refuses a live fetch with, because a
 * second host rule is a second meaning for `domains`. A source with no parseable host is
 * not a fetched URL either and goes the same way: `WebSearch` cannot be constrained to a
 * host, so a search-derived claim is legitimate research and belongs in `guesses`, which
 * is what the granted prompt now says.
 *
 * Dropped rather than demoted to a guess. A guess carries an id that has to stay unique
 * across memory's and research's lists, and inventing one here to hold a claim the model
 * has already been told to put in `guesses` buys a second reducer for a case the prompt
 * already handles. The caller warns, which is what keeps the drop visible.
 */
export function groundedFindings(
  findings: readonly Finding[],
  research: "closed" | "web",
  domains: readonly string[],
): Finding[] {
  return findings.filter(
    (finding) =>
      finding.sourceKind !== "web" ||
      (research === "web" && allowedFetchHost(finding.source, domains)),
  );
}

export const emptyLedger = (): TaskLedger => ({
  factsGiven: [],
  factsVerified: [],
  factsToLookUp: [],
  factsToDerive: [],
  guesses: [],
  deadEnds: [],
  criteria: [],
  plan: [],
});

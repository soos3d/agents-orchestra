// What a worker hands back (§4.1).
//
// Load-bearing in a way that is easy to miss: context discipline denies the
// orchestrator the transcript, so this report is the *entire* evidence base for
// isProgressBeingMade, isInLoop, and every criterion judgment. Prose cannot carry
// that job, which is why it is a schema and why a worker that returns prose gets
// one reformat attempt and then fails.
import { z } from "zod";
import { artifactSchema } from "./artifacts.js";

export const workerReportSchema = z.object({
  outcome: z.enum(["completed", "partial", "blocked", "failed"]),
  summary: z.string().min(1).max(2000), // ≤ ~200 words
  criteriaTouched: z.array(z.string()),
  claims: z.array(z.string()),
  // What the worker could not determine — becomes factsToLookUp.
  unknowns: z.array(z.string()),
  // Approaches shown not to work — appended to the ledger. This is what makes a
  // failed task useful: the dead end it found stops the next replan walking into it.
  deadEnds: z.array(z.string()),
  artifacts: z.array(artifactSchema),
  // Advisory only. The orchestrator plans, not the worker.
  nextSuggestion: z.string().optional(),
});

export type WorkerReport = z.infer<typeof workerReportSchema>;

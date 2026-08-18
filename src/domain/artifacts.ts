// What work produces, how it gets checked, and what makes a check auditable.
//
// The orchestrator sees artifact metadata and short worker reports only — never a
// full transcript, never raw stdout. That context discipline is what lets a mission
// run for hours without drowning.
import { z } from "zod";

export const artifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("diff"),
    id: z.string(),
    branch: z.string(),
    files: z.array(z.string()),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("document"), id: z.string(), path: z.string(), summary: z.string() }),
  z.object({
    kind: z.literal("data"),
    id: z.string(),
    path: z.string(),
    schema: z.string().optional(),
  }),
  // Referenced by path, never inlined: a base64 screenshot per browser action would
  // make the log unreplayable within one mission (§9.1).
  z.object({
    kind: z.literal("screenshot"),
    id: z.string(),
    path: z.string(),
    caption: z.string(),
  }),
  z.object({ kind: z.literal("report"), id: z.string(), text: z.string() }),
]);

/**
 * The specialist scanners a `scanner` check may name (PLAN-NEXT 6.3).
 *
 * One entry, because one is what has been verified end to end. A second name here would
 * be a menu entry nobody probed — the `MODELS_BY_VENDOR.openai`-is-empty discipline, in
 * the field a criterion is validated against.
 */
export const SCANNERS = ["deepsec"] as const;

/**
 * deepsec's severity ladder, exactly as its own `--min-severity` help prints it.
 *
 * The order is neither alphabetical nor guessable: `HIGH_BUG` sits between `HIGH` and
 * `MEDIUM` in the export's own sort. Written down rather than derived, because an
 * invented rung is a threshold that silently matches nothing.
 */
export const SCANNER_SEVERITIES = [
  "CRITICAL",
  "HIGH",
  "HIGH_BUG",
  "MEDIUM",
  "BUG",
  "LOW",
] as const;

export type ScannerSeverity = (typeof SCANNER_SEVERITIES)[number];

/**
 * What a scanner criterion is failed at, when it does not say.
 *
 * `HIGH` rather than `LOW`: the gate's job is to stop a mission, and an agent-written
 * scanner reports style-adjacent findings at the bottom of its ladder. A mission that
 * wants those says so in the criterion.
 */
export const DEFAULT_MIN_SEVERITY: ScannerSeverity = "HIGH";

const commandSpecSchema = z.object({
  kind: z.literal("command"),
  command: z.string().min(1),
  cwd: z.enum(["worktree", "repo"]).optional(),
});

const judgeSpecSchema = z.object({
  kind: z.literal("judge"),
  rubric: z.string().min(1),
  agent: z.string().optional(),
});

// A specialist gate over the merged tree (PLAN-NEXT 6.3). `scanner` is an enum of one
// because one is what has been verified; a second name would be an offer nobody
// probed. The variant is refused at `writeOutcomeSpec` unless the mission's envelope
// granted the scanner *and* this machine answered for it — it costs real money per
// file and runs an agent with shell access, so it is never a default.
const scannerSpecSchema = z.object({
  kind: z.literal("scanner"),
  scanner: z.enum(SCANNERS),
  minSeverity: z.enum(SCANNER_SEVERITIES).optional(),
});

// The only kind that has to argue for itself.
const noneSpecSchema = z.object({ kind: z.literal("none"), reason: z.string().min(1) });

export const verifySpecSchema = z.discriminatedUnion("kind", [
  commandSpecSchema,
  judgeSpecSchema,
  scannerSpecSchema,
  noneSpecSchema,
]);

/**
 * The same union with `scanner` removed, for the prompt of a mission that granted none.
 *
 * A criteria-authoring call is shown its schema rendered, and the rendered union was the
 * whole union whatever the envelope said — so a mission granting no scanner still showed
 * the architect a legal-looking `scanner` variant, it wrote one, and `writeOutcomeSpec`
 * refused the spec and spent the architect's one retry. The guard was right and the
 * offer was wrong: `checkAuthoring` already withholds the scanner *paragraph* when
 * nothing is granted, and this withholds the *shape* beside it.
 *
 * Removing a variant rather than adding a prohibition is the deliberate half. The
 * scanner paragraph written unconditionally is what made `Qwen/Qwen3-30B-A3B-Instruct-2507`
 * return no criteria at all (see `checkAuthoring`), so the fix for a prompt that offers
 * too much is less text, never a sentence telling a model what not to do.
 */
export const verifySpecWithoutScannerSchema = z.discriminatedUnion("kind", [
  commandSpecSchema,
  judgeSpecSchema,
  noneSpecSchema,
]);

// What makes `met: true` auditable rather than a model's assertion.
export const evidenceSchema = z.object({
  artifactIds: z.array(z.string()),
  checkOutput: z.string(),
  reasoning: z.string(),
  byTask: z.array(z.string()),
  // Where the full check output was written, when there was a directory to write it
  // to (P2). The log carries a tail; a mission that has to be re-argued weeks later
  // needs the whole thing, and defect 30 is the standing reminder that a string in a
  // log cannot re-open a file that was deleted. Optional because the directory is a
  // runtime dependency and a check without one still runs.
  checkOutputPath: z.string().optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type VerifySpec = z.infer<typeof verifySpecSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

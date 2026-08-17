// A specialist gate: an outside scanner's findings turned into a criterion's verdict
// (PLAN-NEXT 6.3).
//
// This file exists because deepsec is a *program whose output we believe*, and every
// other place this repository believes an outside program it has been bitten. The
// scanner is an AI agent with shell access on the machine it runs on, it costs real
// money per file, and its export is a JSON document written by a version we did not
// pin — so the three things that would quietly go wrong are all here and all pure: the
// argv (a tokenizer, never a shell string), the parse (zod at the boundary, `safeParse`
// and a message naming the fix), and the reading of an exit code that means "findings"
// rather than "broken".
//
// **Exit 1 does not mean "findings", and that was found by running it.** deepsec's own
// docs give `0` for a clean run, `1` for "at least one finding was produced", and
// anything else for a runtime error. A real scan of a seeded vulnerable file on
// 2026-08-16 exited **1 having produced nothing**, printing `Errored batches: 1` and
// `1 batch(es) errored — exiting 1 (agent failure, not a clean review)` — the agent it
// drives had hit its account's usage limit. So the two states the docs describe as
// distinguishable by exit code are not: a scan that found real problems and a scan that
// never ran both exit 1, and reading that as "exit 1, export, nothing above the
// threshold, criterion met" is a security gate that passes because nobody was logged in.
//
// So the threshold lives in this file rather than in deepsec's `--min-severity`. The
// export carries every severity and `findingsAtOrAbove` filters it here, which makes an
// exit of 1 with an empty export unambiguous: deepsec exits 1 only when it produced a
// finding or errored, so nothing at all means it errored. A scan whose findings are all
// below the threshold still exports them, so a genuinely clean-at-HIGH run is never
// mistaken for a broken one.
import { z } from "zod";
import {
  DEFAULT_MIN_SEVERITY,
  SCANNER_SEVERITIES,
  type ScannerSeverity,
} from "../domain/artifacts.js";

/**
 * One finding, as `deepsec export --format json` writes it.
 *
 * Deliberately **not** exhaustive over the fields deepsec emits, and `passthrough` is
 * why: the export carries ownership, labels, run ids and a revalidation block that this
 * gate has no opinion about, and a schema that refused an unknown key would turn every
 * upstream addition into a mission that fails its own security check. What is pinned is
 * what is read — where the problem is and how bad it is.
 */
export const scannerFindingSchema = z
  .object({
    title: z.string(),
    metadata: z
      .object({
        filePath: z.string(),
        severity: z.enum(SCANNER_SEVERITIES),
        lineNumbers: z.array(z.number()).optional(),
        vulnSlug: z.string().optional(),
        confidence: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** The export is a bare array, not an object with a `findings` key. Asserting the
 *  wrapper that is not there is how a parser reports "no findings" for a document full
 *  of them. */
export const scannerExportSchema = z.array(scannerFindingSchema);

export type ScannerFinding = z.infer<typeof scannerFindingSchema>;

/**
 * The findings this criterion is failed on: everything at `minSeverity` or above.
 *
 * Filtered here rather than by deepsec's own `--min-severity`, and the reason is the
 * exit code above: the export has to carry every finding for "exit 1 and nothing at all"
 * to mean "the scan broke". Ordered by `SCANNER_SEVERITIES`, which is written down
 * because the ladder is not guessable — `HIGH_BUG` sits between `HIGH` and `MEDIUM`.
 */
export function findingsAtOrAbove(
  findings: readonly ScannerFinding[],
  minSeverity: ScannerSeverity = DEFAULT_MIN_SEVERITY,
): ScannerFinding[] {
  const floor = SCANNER_SEVERITIES.indexOf(minSeverity);
  return findings.filter(
    (finding) => SCANNER_SEVERITIES.indexOf(finding.metadata.severity) <= floor,
  );
}

export type ScannerParse =
  | { ok: true; findings: ScannerFinding[] }
  | { ok: false; message: string };

/**
 * The export file, at the boundary.
 *
 * A criterion is failed on what this returns, so a document that cannot be read has to
 * be a loud failure and never an empty finding list — "the parse broke" and "the code is
 * clean" are the two answers that must not look alike, and one of them ends a mission
 * with a green light.
 */
export function parseScannerExport(text: string): ScannerParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message:
        `The scanner's JSON export could not be parsed (${(error as Error).message}). ` +
        `Check the file it wrote, and re-run 'orchestra doctor' if the deepsec version ` +
        `on this machine changed — its export shape is not pinned by anything here.`,
    };
  }

  const parsed = scannerExportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message:
        `The scanner's JSON export is not the shape this gate reads: ` +
        `${issue?.path.join(".") || "(root)"} ${issue?.message}. Expected a bare array of ` +
        `findings, each with 'metadata.filePath' and a 'metadata.severity' of ` +
        `${SCANNER_SEVERITIES.join(", ")}. Re-run 'orchestra doctor' if deepsec was ` +
        `upgraded, or drop the scanner check from the criterion.`,
    };
  }

  return { ok: true, findings: parsed.data };
}

/**
 * The two commands a scan is, as argv rather than a line.
 *
 * `--files` and not `--diff`, and the cost is the reason. deepsec's own figures put a
 * 2,000-file repository at hours and hundreds of dollars; the files this mission's tasks
 * actually wrote are a list the fold already holds, and scanning them is the difference
 * between a gate and a bill. `process` investigates, `export` is what writes JSON — there
 * is no `--json` on `process`, and its stdout carries progress lines before the payload,
 * so the export goes to a file and the file is what gets read.
 *
 * **No `--min-severity` and no `--agent`.** The threshold is `findingsAtOrAbove`'s, so
 * that an empty export means the scan produced nothing at all rather than nothing
 * interesting — see the exit-code note at the top of this file. The agent is deepsec's
 * own configuration to make (`defaultAgent` in the operator's `deepsec.config.ts`, and
 * `codex` when they have not said); naming one here would override a choice that belongs
 * to whoever holds the account it bills.
 *
 * **`--files-from -` rather than `--files <csv>`**, so the list goes over stdin. A comma
 * is a legal character in a filename and would split one path into two that do not exist,
 * which arrives as "the scanner is broken" rather than "that file is misspelled"; and a
 * mission that touched a few hundred files would build one argv element long enough to
 * matter. `filesInput` is what gets piped.
 *
 * **`--since` scopes the export to this scan.** deepsec's store lives in `.deepsec/` and
 * persists across rounds, so an unscoped export carries every finding the project has ever
 * recorded — including ones a later round fixed, which would keep the criterion red for
 * the rest of the mission. `--since` filters on the most recent *analysis*, so a finding
 * this scan re-confirmed is in and one it no longer sees is out.
 */
export function scannerArgv(input: {
  files: readonly string[];
  out: string;
  /** ISO timestamp taken immediately before the scan starts. */
  since: string;
}): { scan: readonly string[]; filesInput: string; export: readonly string[] } {
  return {
    scan: ["process", "--files-from", "-"],
    filesInput: `${input.files.join("\n")}\n`,
    export: ["export", "--format", "json", "--since", input.since, "--out", input.out],
  };
}

/** What the criterion's evidence says, one line per finding — where it is, how bad, and
 *  which rule. The full export stays on disk; this is the part that has to fit in a
 *  progress call's context every round for the rest of the mission. */
export function describeFindings(findings: readonly ScannerFinding[]): string {
  return findings
    .map((finding) => {
      const meta = finding.metadata;
      const line = meta.lineNumbers?.[0];
      return (
        `${meta.severity} ${meta.filePath}${line === undefined ? "" : `:${line}`} — ` +
        `${finding.title}${meta.vulnSlug ? ` (${meta.vulnSlug})` : ""}`
      );
    })
    .join("\n");
}

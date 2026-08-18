// Task verification: did this worker do its job?
//
// Distinct from criterion verification, which asks whether the *outcome* is met (§4).
// They fire at different times and can disagree, and every task green with the
// criterion unmet is the most informative signal the loop produces — it means the
// plan was wrong rather than the work.
//
// `judge` here grades the task's own goal rather than a mission criterion, so the
// judge call gets a criterion shaped from the task. It still reads artifacts and
// never the worker's report: grading a summary written by the thing being graded is
// not verification.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir, FILE_MODE } from "../config/hygiene.js";
import {
  DEFAULT_MIN_SEVERITY,
  type Artifact,
  type Evidence,
  type VerifySpec,
} from "../domain/artifacts.js";
import { type Criterion } from "../domain/ledger.js";
import { type Task } from "../domain/task.js";
import { needsShell, parseCommand } from "../runtime/command.js";
import { run } from "../runtime/sh.js";
import { redact, withoutSecrets, type Secret } from "../workers/redact.js";
import { type Calls } from "./calls.js";
import { panelVerdict } from "./criteria.js";
import {
  describeFindings,
  findingsAtOrAbove,
  parseScannerExport,
  scannerArgv,
} from "./scanner.js";

export interface VerifyContext {
  task: Task;
  /** Where a `command` check runs: the worktree for code, the repo otherwise. */
  cwd: string;
  artifacts: readonly Artifact[];
  /** Where the full check output is kept (P2). Absent means the log's tail is the
   *  only record, which is the behaviour before the artifact directory existed. */
  evidenceDir?: string;
}

export interface VerifyResult {
  passed: boolean;
  output: string;
}

export type Verifier = (spec: VerifySpec, context: VerifyContext) => Promise<VerifyResult>;

export interface VerifierDeps {
  calls: Pick<Calls, "judge">;
  timeoutMs?: number;
  /**
   * The values of the variables this mission granted (PLAN-NEXT 7.3), scrubbed out of
   * check output, judge reasoning and every evidence file before it is written.
   *
   * A check runs in a tree a worker with a credential just wrote, and its output is
   * pasted into an event and into a file under `.orchestra/`. Absent is a mission that
   * granted no variable, which is every mission before `--env`.
   */
  secrets?: readonly Secret[];
  signal?: AbortSignal;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Enough to see which assertion failed, short enough that the log stays replayable. */
const OUTPUT_TAIL = 4000;

export function createVerifier(deps: VerifierDeps): Verifier {
  return async (spec, context) => {
    if (spec.kind === "none") {
      return { passed: true, output: `No check: ${spec.reason}` };
    }

    if (spec.kind === "judge") {
      const paths = artifactPaths(context.artifacts, context.cwd);
      const result = await deps.calls.judge({
        criterion: { id: context.task.id, statement: context.task.goal, check: spec },
        check: spec,
        artifactPaths: paths,
      });
      // A judge reads the files the work left behind and quotes them back, so its
      // reasoning is worker output one hop along (PLAN-NEXT 7.3).
      const reasoning = redact(result.evidence.reasoning, deps.secrets ?? []);
      keepEvidence(
        context.evidenceDir,
        "check.txt",
        [
          `task: ${context.task.id}`,
          `graded: ${paths.join(", ") || "(no artifact paths)"}`,
          "",
          reasoning,
        ],
        deps.secrets ?? [],
      );
      return { passed: result.met, output: reasoning };
    }

    // A scanner grades the *merged* outcome over the files a mission landed, which is a
    // criterion's question and not a task's (PLAN-NEXT 6.3). Refused here rather than
    // run against one worktree: a per-task scan would bill the mission once per task for
    // an answer about a tree that does not exist yet, and `SYNTHESIZE_PROMPT` does not
    // offer the variant — so reaching this line means a spec got in another way.
    if (spec.kind === "scanner") {
      return {
        passed: false,
        output:
          `A '${spec.scanner}' scan grades the merged repository, so it cannot verify one ` +
          `task's work. Put the scanner check on an outcome criterion and give this task a ` +
          `command or a judge rubric.`,
      };
    }

    const result = await runCommand(spec.command, context.cwd, deps);
    keepEvidence(
      context.evidenceDir,
      "check.txt",
      [`task: ${context.task.id}`, `command: ${spec.command}`, "", result.output],
      deps.secrets ?? [],
    );
    return result;
  };
}

/**
 * Writes a check's full output beside the work it graded (P2), and never fails the
 * check for failing to.
 *
 * The log carries a tail, and a tail is enough to see which assertion failed and not
 * enough to re-argue a mission weeks later — defect 30 is the standing reminder that a
 * string in a log cannot re-open a file. A write that does not happen is a missing
 * convenience; a check that fails because a disk was full would be a mission lost to
 * bookkeeping, so this is best-effort by design and returns the path only on success.
 */
function keepEvidence(
  dir: string | undefined,
  name: string,
  lines: readonly string[],
  // Required rather than optional, so a call site added later cannot forget it: the
  // parameter is how "no secret reaches a file" is checked by the compiler instead of
  // by whoever reviews the next evidence line.
  secrets: readonly Secret[],
): string | undefined {
  if (!dir) return undefined;
  const file = path.join(dir, name);
  try {
    ensurePrivateDir(dir);
    fs.writeFileSync(file, `${redact(lines.join("\n"), secrets)}\n`, { mode: FILE_MODE });
    fs.chmodSync(file, FILE_MODE);
    return file;
  } catch {
    return undefined;
  }
}

/** Shared by both levels of check, so a criterion and a task read a failing command
 *  the same way. Not a shell (defect 6): a piped command says so rather than running
 *  as a program with a literal `|` argument. */
async function runCommand(
  command: string,
  cwd: string,
  deps: VerifierDeps,
): Promise<VerifyResult> {
  if (needsShell(command)) {
    return {
      passed: false,
      // Redacted like the run's own output: this quotes the command back, and a criterion
      // whose command was written with a value in it would otherwise put it on the log
      // through the one path that never runs anything.
      output: redact(
        `Verification command '${command}' needs a shell (pipes, redirects, or ` +
          `substitution), and verification runs a program directly. Wrap it in a script ` +
          `and name that instead.`,
        deps.secrets ?? [],
      ),
    };
  }

  const { cmd, args } = parseCommand(command);
  const result = await run(cmd, args, {
    cwd,
    timeoutMs: deps.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    signal: deps.signal,
  });

  const streams = `${result.stdout}\n${result.stderr}`.trim();
  return {
    passed: result.code === 0 && !result.timedOut,
    // Redacted here rather than at each caller: this string becomes a `verification_run`
    // event, a `criterion_checked` evidence field, an evidence file and a failure message,
    // and a check that ran in a tree a credentialed worker just wrote can echo the value
    // in any of them (PLAN-NEXT 7.3).
    output: redact(
      `exit ${result.code}${result.timedOut ? " (timed out)" : ""}\n` + streams.slice(-OUTPUT_TAIL),
      deps.secrets ?? [],
    ),
  };
}

/**
 * Only artifacts that resolve to a file on disk, **every one of them against `cwd`** —
 * the worktree for a task check, the repo for a criterion check, which is the §4
 * timing made concrete.
 *
 * A `diff` artifact carries no path of its own, and dropping the files it names handed
 * the judge an empty list on every code task; a judge with no paths "inspects the
 * repository" and reads main, where unmerged work does not exist yet (defect 33).
 *
 * Resolving the *other* kinds is defect 39, which is the same bug one branch over and
 * was found the same way — on a mission, not in the suite. A worker reports what it
 * wrote the way it thinks of it, which is relative to the directory it was given, and
 * that directory is its worktree. Passed through verbatim, `CLAMP_CONVENTIONS.md`
 * resolves against whatever the orchestrator's process happens to be sitting in, the
 * judge reads "File does not exist", and it fails the task — correctly, and on work
 * that was done correctly. `path.resolve` leaves an absolute path alone, so a worker
 * that reported one still gets what it meant.
 */
export function artifactPaths(artifacts: readonly Artifact[], cwd: string): string[] {
  return artifacts.flatMap((artifact) => {
    if ("path" in artifact) return [path.resolve(cwd, artifact.path)];
    if (artifact.kind === "diff") return artifact.files.map((f) => path.resolve(cwd, f));
    return [];
  });
}

export interface CriterionContext {
  /** The tasks that listed this criterion in `satisfies`, and what they produced. */
  tasks: readonly Task[];
  /** Where a `command` check runs. The repo, not a worktree: a criterion is about the
   *  outcome, and by now the work has merged. */
  cwd: string;
  /** Where the full verdict is kept (P2). The mission's artifact root rather than any
   *  one task's: a criterion is about work several tasks landed. */
  evidenceDir?: string;
  /**
   * The seats to convene for a `judge` check, one entry per call, by lens
   * (`criteria.ts` `panelSeats`) — PLAN-NEXT 6.1.
   *
   * Absent is one unlensed seat, which is exactly the single judge this call made before
   * panels existed. Passed in rather than derived here because how many judges a mission
   * buys is the loop's decision and a cost one: deriving it in the checker would put a
   * multiplier on the mission's largest recurring spend in the file that cannot see the
   * mission.
   */
  panel?: readonly (string | undefined)[];
}

/** One seat's vote, in the order the panel was convened. Returned so the loop can put
 *  each one in the log: a 2-1 split is the most informative thing a panel produces and
 *  the resolved verdict cannot carry it. Present even for a panel of one, where it holds
 *  the single vote the resolved verdict already reports. */
export interface PanelVote {
  seat: number;
  lens?: string;
  met: boolean;
  /** This seat's own reasoning, not the panel's. It is what the seat's event carries, so
   *  a log holds three arguments rather than three copies of one conclusion. */
  evidence: Evidence;
}

export type CriterionChecker = (
  criterion: Criterion,
  context: CriterionContext,
) => Promise<{ met: boolean; evidence: Evidence; votes?: readonly PanelVote[] }>;

/**
 * What the panel decided, as one piece of evidence (PLAN-NEXT 6.1).
 *
 * A panel of one returns its seat's evidence untouched — the identity case is the point,
 * not an optimization: it is what keeps a quick mission's verdict, its evidence file and
 * its `criterion_checked` event byte-identical to the mission before panels existed.
 *
 * A real panel gets the seats quoted rather than summarized, because the reasoning is the
 * whole value of a split. A 2-1 that resolves `met: true` with the dissent deleted is a
 * unanimous verdict as far as anyone reading the mission later can tell, and the seat
 * that objected is usually the one worth reading.
 */
export function mergePanelEvidence(
  votes: readonly { seat: number; lens?: string; met: boolean; evidence: Evidence }[],
): Evidence {
  const only = votes[0];
  if (!only) throw new Error("A panel returned no votes, so there is nothing to decide from.");
  if (votes.length === 1) return only.evidence;

  const met = votes.filter((vote) => vote.met).length;
  return {
    artifactIds: [...new Set(votes.flatMap((vote) => vote.evidence.artifactIds))],
    byTask: [...new Set(votes.flatMap((vote) => vote.evidence.byTask))],
    checkOutput: "",
    reasoning: [
      `Panel of ${votes.length}: ${met} for, ${votes.length - met} against.`,
      ...votes.map(
        (vote) =>
          `\n[seat ${vote.seat}${vote.lens ? ` — ${vote.lens}` : ""}] met: ${vote.met}\n` +
          vote.evidence.reasoning,
      ),
    ].join("\n"),
  };
}

/**
 * Criterion verification asks whether the *outcome* is met — a different question
 * from whether a worker did its job, asked at a different time (§4).
 *
 * Every answer carries evidence, because `met: true` with nothing behind it is a
 * model's opinion and the mission terminates on it.
 */
export function createCriterionChecker(deps: VerifierDeps): CriterionChecker {
  return async (criterion, context) => {
    const artifacts = context.tasks.flatMap((task) => task.artifacts);
    const byTask = context.tasks.map((task) => task.id);
    const artifactIds = artifacts.map((artifact) => artifact.id);

    if (criterion.check.kind === "judge") {
      const check = criterion.check;
      const paths = artifactPaths(artifacts, context.cwd);
      const seats = context.panel ?? [undefined];

      // Sequential, not `Promise.all`. Three judges in flight are three ways to be
      // mid-spend when the first one throws: `resilience.ts` turns a second failure into
      // a `DecisionPointError` the loop parks on, and parking with two calls still
      // running bills a mission for verdicts nothing will ever read. Wall time is the
      // price and a panel is opt-in for the mission profile that wants it.
      if (seats.length === 0) {
        throw new Error(
          `A panel with no seats was convened for criterion '${criterion.id}'. ` +
            `\`CriterionContext.panel\` must name at least one seat, or be absent for one.`,
        );
      }

      const votes: { seat: number; lens?: string; met: boolean; evidence: Evidence }[] = [];
      for (const [seat, lens] of seats.entries()) {
        const result = await deps.calls.judge({
          criterion,
          check,
          artifactPaths: paths,
          ...(lens ? { lens } : {}),
        });
        // The paths are kept alongside the verdict deliberately: defect 33, 39 and 40
        // were each a judge reading the wrong files or none, and every one of them was
        // diagnosed from a verdict that did not say what it had opened.
        if (seats.length > 1) {
          keepEvidence(
            context.evidenceDir,
            `criterion-${criterion.id}-${lens ?? seat}.txt`,
            [
              `criterion: ${criterion.id} — ${criterion.statement}`,
              `seat ${seat}${lens ? ` (${lens})` : ""}`,
              `met: ${result.met}`,
              `graded: ${paths.join(", ") || "(no artifact paths)"}`,
              "",
              result.evidence.reasoning,
            ],
            deps.secrets ?? [],
          );
        }
        votes.push({
          seat,
          ...(lens ? { lens } : {}),
          met: result.met,
          // Redacted before it is a vote, so every reader downstream — the merged panel
          // evidence, the `criterion_checked` event, the file — gets the scrubbed text
          // from one place (PLAN-NEXT 7.3).
          evidence: {
            ...result.evidence,
            reasoning: redact(result.evidence.reasoning, deps.secrets ?? []),
          },
        });
      }

      const met = panelVerdict(votes.map((vote) => vote.met));
      const evidence = mergePanelEvidence(votes);
      const kept = keepEvidence(
        context.evidenceDir,
        `criterion-${criterion.id}.txt`,
        [
          `criterion: ${criterion.id} — ${criterion.statement}`,
          `met: ${met}`,
          `graded: ${paths.join(", ") || "(no artifact paths)"}`,
          "",
          evidence.reasoning,
        ],
        deps.secrets ?? [],
      );
      return {
        met,
        evidence: {
          ...evidence,
          byTask: evidence.byTask.length ? evidence.byTask : byTask,
          ...(kept ? { checkOutputPath: kept } : {}),
        },
        votes,
      };
    }

    // `writeOutcomeSpec` rejects a criterion whose check is `none`, so reaching here
    // means one got in another way. It is unmet rather than met: an outcome nothing
    // checked has not been shown.
    if (criterion.check.kind === "none") {
      return {
        met: false,
        evidence: {
          artifactIds,
          checkOutput: "",
          reasoning:
            `Criterion '${criterion.id}' has no check, so nothing can show it is met. ` +
            `It should have been rejected when the outcome spec was written.`,
          byTask,
        },
      };
    }

    if (criterion.check.kind === "scanner") {
      return runScanner(criterion, criterion.check, context, deps, artifactIds, byTask);
    }

    const result = await runCommand(criterion.check.command, context.cwd, deps);
    const kept = keepEvidence(
      context.evidenceDir,
      `criterion-${criterion.id}.txt`,
      [
        `criterion: ${criterion.id} — ${criterion.statement}`,
        `met: ${result.passed}`,
        `command: ${criterion.check.command}`,
        "",
        result.output,
      ],
      deps.secrets ?? [],
    );
    return {
      met: result.passed,
      evidence: {
        artifactIds,
        checkOutput: result.output,
        reasoning: result.passed
          ? `'${criterion.check.command}' passed against the work from ${byTask.join(", ")}.`
          : `'${criterion.check.command}' did not pass, so the outcome is not met yet.`,
        byTask,
        ...(kept ? { checkOutputPath: kept } : {}),
      },
    };
  };
}

/**
 * How long a scan may take before it is a hang rather than a scan.
 *
 * Half an hour, against the ten minutes every other check gets. deepsec's own published
 * figures put a hundred files at five to fifteen minutes, and a gate that times out
 * halfway has spent the money and kept none of the answer. It is still a ceiling and not
 * a budget: the file list is what bounds the cost, and this bounds the wait.
 */
export const SCANNER_TIMEOUT_MS = 30 * 60_000;

/**
 * How many changed files a scan will look at before refusing.
 *
 * A cost ceiling and not a technical one. deepsec bills per file investigated, and its own
 * FAQ puts 500 files at $130–300 and 2,000 at $500–1200. A mission that touched more than
 * this has outgrown a per-file security gate, and refusing with the number in the message
 * is a better answer than a bill nobody approved.
 */
export const MAX_SCANNED_FILES = 200;

/**
 * The specialist gate, end to end (PLAN-NEXT 6.3): scan the files this mission landed,
 * export the findings above the threshold, and fail the criterion on what came back.
 *
 * Three things here are load-bearing and none is a preference.
 *
 * **The file list is the cost control.** deepsec bills per file investigated and its own
 * FAQ puts two thousand files at hundreds of dollars; the files a criterion's contributing
 * tasks wrote are already in the fold, and scanning those is the difference between a gate
 * and an invoice. A scan with nothing to scan is unmet rather than met — an outcome
 * nothing looked at has not been shown, which is the `kind: "none"` reading one branch up.
 *
 * **Exit 1 means "findings *or* a failed batch", which the docs do not say and a real
 * scan proved.** deepsec exits 1 both when it found something and when the agent it
 * drives could not run at all — observed on 2026-08-16, where a seeded vulnerable file
 * came back `Errored batches: 1` and exit 1 with an empty export. So the three states are
 * separated by exit code *and* export contents: 0 is clean, 1 with findings is a verdict,
 * 1 with nothing at all is a scan that never happened, and anything else is a runtime
 * error. Only the first can pass the criterion.
 *
 * **The export goes to a file, never to stdout.** deepsec prints human progress lines on
 * the same stream as the JSON, so parsing its stdout would parse a log with a document at
 * the end of it — the `extractJsonObject` class of mistake (defect 38), avoidable here for
 * the price of one `--out`.
 */
async function runScanner(
  criterion: Criterion,
  check: Extract<VerifySpec, { kind: "scanner" }>,
  context: CriterionContext,
  deps: VerifierDeps,
  artifactIds: string[],
  byTask: string[],
): Promise<{ met: boolean; evidence: Evidence }> {
  // Only files that are still on the merged tree. `artifact.files` is a git diff's name
  // list, so it includes deletions and renames-away; handing deepsec a path that is not
  // there errors the batch, and the operator reads "the scanner did not run — check your
  // credentials" about a criterion whose real problem is that a refactor removed a file.
  const files = [...new Set(
    context.tasks
      .flatMap((task) => task.artifacts)
      .flatMap((artifact) => (artifact.kind === "diff" ? artifact.files : []))
      .map((file) => path.relative(context.cwd, path.resolve(context.cwd, file)))
      .filter((file) => file !== "" && !file.startsWith(".."))
      .filter((file) => fs.existsSync(path.resolve(context.cwd, file))),
  )];

  const answer = (met: boolean, rawReasoning: string, rawOutput = ""): {
    met: boolean;
    evidence: Evidence;
  } => {
    // Scrubbed before either sink, and the scanner is the one check where this is not
    // hypothetical: a hardcoded credential is exactly what it exists to find, and
    // `describeFindings` quotes the code it flagged — so the security gate would be the
    // thing that copied the value into `criterion_checked` (PLAN-NEXT 7.3).
    const reasoning = redact(rawReasoning, deps.secrets ?? []);
    const checkOutput = redact(rawOutput, deps.secrets ?? []);
    const kept = keepEvidence(
      context.evidenceDir,
      `criterion-${criterion.id}.txt`,
      [
        `criterion: ${criterion.id} — ${criterion.statement}`,
        `met: ${met}`,
        `scanner: ${check.scanner} (min severity ${check.minSeverity ?? DEFAULT_MIN_SEVERITY})`,
        `scanned: ${files.join(", ") || "(nothing)"}`,
        "",
        reasoning,
        checkOutput,
      ],
      deps.secrets ?? [],
    );
    return {
      met,
      evidence: {
        artifactIds,
        checkOutput,
        reasoning,
        byTask,
        ...(kept ? { checkOutputPath: kept } : {}),
      },
    };
  };

  if (files.length === 0) {
    return answer(
      false,
      `The ${check.scanner} scan had no files to look at: none of ${byTask.join(", ") || "the " +
        "contributing tasks"} left a diff behind. A scanner criterion has to be satisfied by ` +
        `work that changes files.`,
    );
  }

  if (files.length > MAX_SCANNED_FILES) {
    return answer(
      false,
      `${files.length} files changed, and this gate scans at most ${MAX_SCANNED_FILES}. ` +
        `${check.scanner} bills per file investigated and its own figures put a scan this ` +
        `size in the hundreds of dollars, so it refuses rather than spends it. Narrow the ` +
        `criterion to the tasks that touch the code you want scanned, or drop the scanner ` +
        `check.`,
    );
  }

  // A fresh directory per scan when there is nowhere durable to write. `os.tmpdir()` plus
  // a name derived from the criterion id is a path anybody on the machine can predict, and
  // a file planted there would be read as this scan's findings by the one check whose
  // whole job is a security verdict.
  const outDir = context.evidenceDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-scan-"));
  // Created before the export rather than by `keepEvidence` afterwards: `--out` names a
  // file in this directory and deepsec will not make one, so an artifact root that has not
  // been written to yet turns a clean scan into "the export failed".
  ensurePrivateDir(outDir);
  const out = path.join(outDir, `criterion-${criterion.id}-${check.scanner}.json`);
  // Removed before the scan, never after. The path is the same every round, and
  // `readFileSync` succeeding is the only evidence this code has that an export happened —
  // so a round where the export writes nothing would otherwise grade the *previous*
  // round's findings, which passes a criterion whose scan produced no output at all.
  fs.rmSync(out, { force: true });

  const argv = scannerArgv({ files, out, since: new Date().toISOString() });
  const timeoutMs = Math.max(deps.timeoutMs ?? 0, SCANNER_TIMEOUT_MS);
  // The scanner does not get the mission's granted values. `run` defaults to
  // `process.env`, and this child is an AI agent with shell access whose own store
  // persists in the repository — defect 42's hole, one caller along, with a disk sink at
  // the end of it that no `redact` call covers. Withheld rather than allowlisted, for the
  // reason `withoutSecrets` gives: the scanner needs the operator's environment to find
  // its own credentials, and a name list for it is one nobody can write correctly.
  const where = {
    cwd: context.cwd,
    timeoutMs,
    env: withoutSecrets(process.env, deps.secrets ?? []),
    ...(deps.signal ? { signal: deps.signal } : {}),
  };

  const scan = await run(check.scanner, [...argv.scan], { ...where, input: argv.filesInput });
  if (scan.timedOut || (scan.code !== 0 && scan.code !== 1)) {
    return answer(
      false,
      `'${check.scanner} ${argv.scan.join(" ")}' did not run` +
        `${scan.timedOut ? ` (timed out after ${timeoutMs}ms)` : ` (exit ${scan.code})`}. ` +
        `That is a broken scan and not a clean one, so the criterion is unmet. Check the ` +
        `scanner's credentials and run 'orchestra doctor'.`,
      `${scan.stdout}\n${scan.stderr}`.trim().slice(-OUTPUT_TAIL),
    );
  }

  const exported = await run(check.scanner, [...argv.export], where);
  if (exported.code !== 0 || exported.timedOut) {
    return answer(
      false,
      `'${check.scanner} ${argv.export.join(" ")}' ` +
        `${exported.timedOut ? `timed out after ${timeoutMs}ms` : `failed (exit ${exported.code})`}` +
        `, so the findings could not be read. The scan itself ran; re-run the export by ` +
        `hand to see what it says.`,
      `${exported.stdout}\n${exported.stderr}`.trim().slice(-OUTPUT_TAIL),
    );
  }

  let text: string;
  try {
    // Scrubbed and written back, not just scrubbed on the way past. The failure message
    // below names this file to the human, and the finding a scanner is most likely to
    // quote verbatim is "hardcoded credential" — so without the write-back the security
    // gate would be the one thing that copies a granted value into `.orchestra/` while
    // reporting, correctly, that it found one.
    text = redact(fs.readFileSync(out, "utf8"), deps.secrets ?? []);
    // The scanner wrote it, so it arrives with the scanner's umask — 0644 in the observed
    // run. Every other file this system writes is 0600 and this one holds a map of the
    // repository's vulnerabilities, which makes it the last one to leave world-readable.
    fs.writeFileSync(out, text, { mode: FILE_MODE });
    fs.chmodSync(out, FILE_MODE);
  } catch (error) {
    return answer(
      false,
      `The ${check.scanner} export wrote nothing to ${out} (${(error as Error).message}), so ` +
        `there is nothing to grade. Run the export by hand to see what it says.`,
    );
  }

  const parsed = parseScannerExport(text);
  if (!parsed.ok) return answer(false, parsed.message);

  // Exit 1 with an empty export is the state the docs do not describe: deepsec exits 1
  // for a finding *and* for a batch its agent could not run, so nothing at all means the
  // second. Read as clean it would pass a security criterion nobody ever scanned.
  if (scan.code === 1 && parsed.findings.length === 0) {
    return answer(
      false,
      `${check.scanner} exited 1 having produced no findings at all, which is how it reports ` +
        `a batch its own agent could not run — not a clean scan. The criterion is unmet. ` +
        `Check the scanner's model credentials and quota, then re-run.`,
      `${scan.stdout}\n${scan.stderr}`.trim().slice(-OUTPUT_TAIL),
    );
  }

  const floor = check.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const above = findingsAtOrAbove(parsed.findings, floor);
  if (above.length === 0) {
    return answer(
      true,
      `${check.scanner} found nothing at ${floor} or above in ${files.length} ` +
        `file${files.length === 1 ? "" : "s"}: ${files.join(", ")}` +
        `${parsed.findings.length > 0 ? ` (${parsed.findings.length} below the threshold)` : ""}.`,
    );
  }

  return answer(
    false,
    `${check.scanner} found ${above.length} issue${above.length === 1 ? "" : "s"} at ` +
      `${floor} or above. The full export is at ${out}.\n\n${describeFindings(above)}`,
  );
}

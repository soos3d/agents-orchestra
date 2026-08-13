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
import path from "node:path";
import { ensurePrivateDir, FILE_MODE } from "../config/hygiene.js";
import { type Artifact, type Evidence, type VerifySpec } from "../domain/artifacts.js";
import { type Criterion } from "../domain/ledger.js";
import { type Task } from "../domain/task.js";
import { needsShell, parseCommand } from "../runtime/command.js";
import { run } from "../runtime/sh.js";
import { type Calls } from "./calls.js";

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
      keepEvidence(context.evidenceDir, "check.txt", [
        `task: ${context.task.id}`,
        `graded: ${paths.join(", ") || "(no artifact paths)"}`,
        "",
        result.evidence.reasoning,
      ]);
      return { passed: result.met, output: result.evidence.reasoning };
    }

    const result = await runCommand(spec.command, context.cwd, deps);
    keepEvidence(context.evidenceDir, "check.txt", [
      `task: ${context.task.id}`,
      `command: ${spec.command}`,
      "",
      result.output,
    ]);
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
function keepEvidence(dir: string | undefined, name: string, lines: readonly string[]): string | undefined {
  if (!dir) return undefined;
  const file = path.join(dir, name);
  try {
    ensurePrivateDir(dir);
    fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: FILE_MODE });
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
      output:
        `Verification command '${command}' needs a shell (pipes, redirects, or ` +
        `substitution), and verification runs a program directly. Wrap it in a script ` +
        `and name that instead.`,
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
    output:
      `exit ${result.code}${result.timedOut ? " (timed out)" : ""}\n` + streams.slice(-OUTPUT_TAIL),
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
}

export type CriterionChecker = (
  criterion: Criterion,
  context: CriterionContext,
) => Promise<{ met: boolean; evidence: Evidence }>;

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
      const paths = artifactPaths(artifacts, context.cwd);
      const result = await deps.calls.judge({
        criterion,
        check: criterion.check,
        artifactPaths: paths,
      });
      // The paths are kept alongside the verdict deliberately: defect 33, 39 and 40
      // were each a judge reading the wrong files or none, and every one of them was
      // diagnosed from a verdict that did not say what it had opened.
      const kept = keepEvidence(context.evidenceDir, `criterion-${criterion.id}.txt`, [
        `criterion: ${criterion.id} — ${criterion.statement}`,
        `met: ${result.met}`,
        `graded: ${paths.join(", ") || "(no artifact paths)"}`,
        "",
        result.evidence.reasoning,
      ]);
      return {
        met: result.met,
        evidence: {
          ...result.evidence,
          byTask: result.evidence.byTask.length ? result.evidence.byTask : byTask,
          ...(kept ? { checkOutputPath: kept } : {}),
        },
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

    const result = await runCommand(criterion.check.command, context.cwd, deps);
    const kept = keepEvidence(context.evidenceDir, `criterion-${criterion.id}.txt`, [
      `criterion: ${criterion.id} — ${criterion.statement}`,
      `met: ${result.passed}`,
      `command: ${criterion.check.command}`,
      "",
      result.output,
    ]);
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

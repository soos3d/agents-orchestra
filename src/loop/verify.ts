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
import path from "node:path";
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
      const result = await deps.calls.judge({
        criterion: { id: context.task.id, statement: context.task.goal, check: spec },
        check: spec,
        artifactPaths: artifactPaths(context.artifacts, context.cwd),
      });
      return { passed: result.met, output: result.evidence.reasoning };
    }

    return runCommand(spec.command, context.cwd, deps);
  };
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

/** Only artifacts that resolve to a file on disk. A `diff` artifact carries no path
 *  of its own, but the files it names exist in the tree the check runs against —
 *  dropping them handed the judge an empty list on every code task, and a judge with
 *  no paths "inspects the repository" and reads main, where unmerged work does not
 *  exist yet (defect 33). Resolved against `cwd`: the worktree for a task check, the
 *  repo for a criterion check, which is the §4 timing made concrete. */
export function artifactPaths(artifacts: readonly Artifact[], cwd: string): string[] {
  return artifacts.flatMap((artifact) => {
    if ("path" in artifact) return [artifact.path];
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
      const result = await deps.calls.judge({
        criterion,
        check: criterion.check,
        artifactPaths: artifactPaths(artifacts, context.cwd),
      });
      return {
        met: result.met,
        evidence: { ...result.evidence, byTask: result.evidence.byTask.length ? result.evidence.byTask : byTask },
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
    return {
      met: result.passed,
      evidence: {
        artifactIds,
        checkOutput: result.output,
        reasoning: result.passed
          ? `'${criterion.check.command}' passed against the work from ${byTask.join(", ")}.`
          : `'${criterion.check.command}' did not pass, so the outcome is not met yet.`,
        byTask,
      },
    };
  };
}

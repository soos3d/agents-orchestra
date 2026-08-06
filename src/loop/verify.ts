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
import { type Artifact, type VerifySpec } from "../domain/artifacts.js";
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
        artifactPaths: artifactPaths(context.artifacts),
      });
      return { passed: result.met, output: result.evidence.reasoning };
    }

    if (needsShell(spec.command)) {
      return {
        passed: false,
        output:
          `Verification command '${spec.command}' needs a shell (pipes, redirects, or ` +
          `substitution), and verification runs a program directly. Wrap it in a script ` +
          `and name that instead.`,
      };
    }

    const { cmd, args } = parseCommand(spec.command);
    const result = await run(cmd, args, {
      cwd: context.cwd,
      timeoutMs: deps.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      signal: deps.signal,
    });

    const streams = `${result.stdout}\n${result.stderr}`.trim();
    return {
      passed: result.code === 0 && !result.timedOut,
      output:
        `exit ${result.code}${result.timedOut ? " (timed out)" : ""}\n` +
        streams.slice(-OUTPUT_TAIL),
    };
  };
}

/** Only artifacts that are a file on disk. A judge cannot open a diff summary. */
export function artifactPaths(artifacts: readonly Artifact[]): string[] {
  return artifacts.flatMap((artifact) => ("path" in artifact ? [artifact.path] : []));
}

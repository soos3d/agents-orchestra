// Claude Code as a `cli` transport: one headless `claude -p` session in a worktree.
//
// Takes its model and timeout explicitly rather than reading a config singleton, so
// a synthesized AgentSpec (§7) decides them per task instead of the process deciding
// them once. Replacing `--dangerously-skip-permissions` with ACP's permission
// channel is Phase 7 (defect 14).
import { run } from "../runtime/sh.js";

export interface CliWorkerOptions {
  model: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_WORKER_TIMEOUT_MS = 20 * 60_000;

export async function runClaudeCode(
  task: string,
  worktree: string,
  options: CliWorkerOptions,
): Promise<string> {
  const result = await run(
    "claude",
    [
      "-p",
      task,
      "--model",
      options.model,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: worktree,
      timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      signal: options.signal,
    },
  );

  try {
    // Shape: { result: string, ... }. Fall back to raw text if the shape drifts —
    // §12's point about flag drift applies to the output format too.
    return JSON.parse(result.stdout).result ?? result.stdout;
  } catch {
    return result.stdout || result.stderr || `claude exited with code ${result.code}`;
  }
}

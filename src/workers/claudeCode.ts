// Claude Code worker: runs a single headless `claude -p` session inside a worktree.
// Strength: careful multi-file reasoning and refactors.
import { run } from "../sh.js";
import { config } from "../config.js";

export async function runClaudeCode(task: string, worktree: string): Promise<string> {
  // `--output-format json` returns a single JSON object with the final result.
  // `--dangerously-skip-permissions` is acceptable *because* we run inside a throwaway
  // worktree; tighten this (allowedTools / a settings file) once the flow is proven.
  const r = await run(
    "claude",
    [
      "-p",
      task,
      "--model",
      config.claudeWorkerModel,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ],
    { cwd: worktree, timeoutMs: 20 * 60_000 },
  );

  try {
    const parsed = JSON.parse(r.stdout);
    // Shape: { result: string, ... }. Fall back to raw text if the shape changes.
    return parsed.result ?? r.stdout;
  } catch {
    return r.stdout || r.stderr || `claude exited with code ${r.code}`;
  }
}

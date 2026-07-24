// Codex worker: runs a single headless `codex exec` session inside a worktree.
// Strength: well-scoped, clearly specified tasks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../sh.js";
import { config } from "../config.js";

export async function runCodex(task: string, worktree: string): Promise<string> {
  const outFile = path.join(os.tmpdir(), `codex-${Date.now()}.txt`);

  // `--full-auto` pre-approves actions (headless codex fails on interactive prompts).
  // `--output-last-message` captures just the final answer, leaving stdout for events.
  // Exact approval/sandbox flags vary by codex version — adjust to your install.
  const r = await run(
    "codex",
    [
      "exec",
      task,
      "--model",
      config.codexWorkerModel,
      "--full-auto",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
    ],
    { cwd: worktree, timeoutMs: 20 * 60_000 },
  );

  try {
    const msg = fs.readFileSync(outFile, "utf8").trim();
    fs.unlinkSync(outFile);
    if (msg) return msg;
  } catch {
    /* fall through */
  }
  return r.stdout || r.stderr || `codex exited with code ${r.code}`;
}

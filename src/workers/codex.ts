// Codex as a `cli` transport: one headless `codex exec` session in a worktree.
//
// `--full-auto` is deprecated (defect 13) and `--sandbox workspace-write` replaces
// it; `--json` and `--output-schema` are both better than scraping
// `--output-last-message`. Both are Phase 7, alongside the move to ACP — the change
// here is only that the model and timeout arrive as arguments rather than from a
// config singleton.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../runtime/sh.js";
import { DEFAULT_WORKER_TIMEOUT_MS, type CliWorkerOptions } from "./claudeCode.js";

export async function runCodex(
  task: string,
  worktree: string,
  options: CliWorkerOptions,
): Promise<string> {
  const outFile = path.join(os.tmpdir(), `codex-${process.pid}-${outFileCounter++}.txt`);

  const result = await run(
    "codex",
    [
      "exec",
      task,
      "--model",
      options.model,
      "--full-auto",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
    ],
    {
      cwd: worktree,
      timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      signal: options.signal,
    },
  );

  try {
    const message = fs.readFileSync(outFile, "utf8").trim();
    if (message) return message;
  } catch {
    /* the file is only written on a clean finish; fall through to the streams */
  } finally {
    fs.rmSync(outFile, { force: true });
  }

  return result.stdout || result.stderr || `codex exited with code ${result.code}`;
}

// `Date.now()` collided when two workers started in the same millisecond, which is
// exactly what a parallel dispatch does.
let outFileCounter = 0;

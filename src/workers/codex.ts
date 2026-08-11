// Codex as a `cli` transport: one headless `codex exec` session in a worktree.
//
// **Defect 13 is closed here, and it was closed against the installed binary rather
// than against §12.** `codex exec --full-auto` on codex-cli 0.146.1 (2026-08-10) prints
// "warning: `--full-auto` is deprecated; use `--sandbox workspace-write` instead" and
// carries on — which is the worst shape a drift can take, since it neither fails nor
// stays true. `--sandbox workspace-write` is what the CLI itself names, so that is what
// is passed; `--dangerously-bypass-approvals-and-sandbox` exists next to it in the help
// and is deliberately not reached for.
//
// Two things §12 also lists are verified present and deliberately *not* adopted here:
// `--json` (JSONL events) and `--output-schema <FILE>`. This transport is the fallback
// path now that ACP ships (`workers/acp/`), and a structured-output rework of it would
// be work spent on the road out. `--output-last-message` still exists and still works,
// so the scrape stays until the fallback either goes or earns the investment.
//
// The argv is a pure function because that is the only part of this file a test can
// see. Everything a subprocess *receives* belongs in one, for the reason five defects
// hid in `agentCalls.ts`: a green suite says nothing about arguments nothing asserts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../runtime/sh.js";
import { DEFAULT_WORKER_TIMEOUT_MS, type CliWorkerOptions } from "./claudeCode.js";

/** The exact command line, so the flags are assertable without spawning anything. */
export function codexArgs(task: string, model: string, outFile: string): string[] {
  return [
    "exec",
    task,
    "--model",
    model,
    // The replacement `codex` names for the deprecated `--full-auto`. The worker writes
    // inside its own worktree, which is the workspace this bounds.
    "--sandbox",
    "workspace-write",
    // A worktree is a repo, but a research or general task runs in a plain directory.
    "--skip-git-repo-check",
    "--output-last-message",
    outFile,
  ];
}

export async function runCodex(
  task: string,
  worktree: string,
  options: CliWorkerOptions,
): Promise<string> {
  const outFile = path.join(os.tmpdir(), `codex-${process.pid}-${outFileCounter++}.txt`);

  const result = await run(
    "codex",
    codexArgs(task, options.model, outFile),
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

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
import { PROCESS_BASELINE_VARS } from "./childEnv.js";
import { runCliProcess, type CliOutcome, type CliWorkerOptions } from "./claudeCode.js";

/** What `codex` needs from the environment to start and find its own credentials
 *  (defect 42), beside the launch that needs it. It authenticates from `~/.codex` on a
 *  logged-in machine — `CODEX_HOME` moves that directory — and an API key is the other
 *  supported way in. Same list-beside-the-launch rule as `CLAUDE_TRANSPORT_VARS`: an
 *  adapter's credential is that adapter's business and no other worker's. */
export const CODEX_TRANSPORT_VARS: readonly string[] = [
  ...PROCESS_BASELINE_VARS,
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
];

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

/**
 * Always `{ text }` and never a token count, which is the honest answer rather than a
 * missing feature (§9.5). This transport scrapes the final message out of
 * `--output-last-message`; the JSONL event stream that would carry usage is `--json`,
 * which the header above explains is deliberately not adopted while this path is the
 * fallback. `spendOf` therefore books an unmeasured dispatch, which is true.
 */
export async function runCodex(
  task: string,
  worktree: string,
  options: CliWorkerOptions,
): Promise<CliOutcome> {
  // A directory rather than a bare file under `os.tmpdir()`, because under containment
  // it has to be mounted — and mounting the whole of `/tmp` into a sandbox to read one
  // message back would hand the worker every other process's scratch space. Contained or
  // not, this is the same path, so the scrape below does not know the difference.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-${process.pid}-`));
  const outFile = path.join(outDir, "last-message.txt");

  const result = await runCliProcess(
    "codex",
    codexArgs(task, options.model, outFile),
    worktree,
    options,
    [outDir],
  );

  try {
    const message = fs.readFileSync(outFile, "utf8").trim();
    if (message) return { text: message };
  } catch {
    /* the file is only written on a clean finish; fall through to the streams */
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  return { text: result.stdout || result.stderr || `codex exited with code ${result.code}` };
}

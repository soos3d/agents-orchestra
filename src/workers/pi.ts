// pi as a `cli` transport: one headless `pi --mode json -p` session in a worktree.
//
// **It is a `cli` row and not an `acp` one, and the capture is what decided that.** pi 0.84.2
// has no `acp` subcommand — `pi acp` is read as a prompt, not a command — and the headless
// protocol it does ship (`--mode rpc`) is pi's own JSON dialect over stdio, not Zed's ACP. An
// `acp/pi` row would therefore be a third transport wearing the second one's name: none of
// `session/new`, `session/prompt` or `session/request_permission` exists on that wire, so
// `acp/transport.ts` would drive it into silence. What pi *does* have is exactly the shape
// `codex.ts` already answers for — a prompt in the argv, a worktree as cwd, one final message —
// so that is the shape this file takes.
//
// Two things pi does that neither of the other two CLI targets does, both from
// `src/testing/cli-transcripts/`:
//
// **It waits for stdin.** `pi -p` does not finish while its stdin is an open pipe: the run that
// produced these captures returned in under a second redirected from `/dev/null` and hung past
// two minutes without. `runtime/sh.ts` already ends the child's stdin, so this transport works —
// but nothing else it spawns needs that line, so `sh.test.ts` now pins it. A worker in the other
// state burns its whole wall-clock budget and is recorded as a timeout, which points an
// investigation at the model rather than at the spawn.
//
// **It runs its tools unattended with no flag to that effect.** `claude` needs
// `--dangerously-skip-permissions` and `codex` needs `--sandbox workspace-write`; pi's `-p` mode
// executed a `write` into the worktree with neither asked for nor offered. There is nothing to
// pass and nothing to withhold, so what bounds a pi worker is the worktree and the envelope's
// containment, exactly as it bounds an OpenCode one whose permission channel is off.
//
// The argv and the parse are pure functions because they are the only part of a subprocess a
// test can see — the `agentCalls.ts` lesson, applied before the fact.
import { PROCESS_BASELINE_VARS } from "./childEnv.js";
import { isEmptyUsage, type TokenUsage } from "../domain/budget.js";
import { runCliProcess, type CliOutcome, type CliWorkerOptions } from "./claudeCode.js";

/** What `pi` needs from the environment to start and find its own credentials (defect 42),
 *  beside the launch that needs it.
 *
 *  Longer than the other two lists and not by preference: pi has no single home provider. It
 *  authenticates from `~/.pi/agent/auth.json` on a logged-in machine (baseline `$HOME`), and
 *  otherwise from whichever vendor key its configured provider reads — so the keys of the
 *  vendors it can be pointed at are named here, the same way `CODEX_TRANSPORT_VARS` names
 *  `OPENAI_API_KEY`. A key the parent does not hold stays absent rather than becoming `""`
 *  (`buildWorkerEnv`), so naming one that is not set costs nothing. `PI_OFFLINE` is pi's own
 *  switch for the network calls it makes at startup, and belongs to the operator. */
export const PI_TRANSPORT_VARS: readonly string[] = [
  ...PROCESS_BASELINE_VARS,
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "PI_OFFLINE",
];

/** The exact command line, so the flags are assertable without spawning anything.
 *
 *  `--mode json` rather than the default text mode, and that is the difference between a priced
 *  dispatch and an unmeasured one: text mode prints the final message and nothing else, while the
 *  JSON stream carries `usage` on every assistant frame. `--no-session` because a worker is one
 *  turn in a disposable worktree and a session file outliving it is state nothing reads. */
export function piArgs(task: string, model: string): string[] {
  return ["-p", task, "--model", model, "--mode", "json", "--no-session"];
}

/**
 * pi's JSON event stream, read down to `{ text, usage }`.
 *
 * One JSON object per line, and only two line types matter: an assistant `message_end` carries
 * both the final text of its turn and the `usage` of the API call that produced it. A session
 * that called tools has several of them, so the text is the *last* one holding text and the
 * usage is the *sum* — each call bills its whole input, so summing is the charge rather than a
 * double count.
 *
 * Every line is parsed inside its own `try`, which is not defensiveness but the one framing
 * hazard this input actually has: `run()` ring-buffers stdout, so a long session arrives with its
 * *first* line truncated mid-object. Skipping an unparseable line loses that fragment's usage and
 * keeps the rest; taking the buffer down with it would lose the worker's whole report. Splitting
 * on `\n` alone is pi's own documented framing, and a trailing `\r` is stripped for the same
 * reason it documents that. Text spanning newlines is not a case: it arrives JSON-escaped.
 */
export function parsePiResult(result: { stdout: string; stderr: string; code: number }): CliOutcome {
  const fallback = result.stdout || result.stderr || `pi exited with code ${result.code}`;

  let text: string | undefined;
  const total: { input: number; output: number; cacheRead: number; cacheWrite: number } = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let measured = false;

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed === "") continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const message = assistantMessageEnd(event);
    if (message === undefined) continue;

    const said = finalText(message.content);
    if (said !== undefined) text = said;

    const usage = readUsage(message.usage);
    if (usage !== undefined) {
      measured = true;
      total.input += usage.input ?? 0;
      total.output += usage.output ?? 0;
      total.cacheRead += usage.cacheRead ?? 0;
      total.cacheWrite += usage.cacheWrite ?? 0;
    }
  }

  // A session whose frames carried no recognisable usage is unmeasured, not free (§9.5) — the
  // same rule `parseClaudeCodeResult` holds, and the reason `spendOf` can tell the two apart.
  return measured
    ? { text: text ?? fallback, usage: total }
    : { text: text ?? fallback };
}

interface PiAssistantMessage {
  readonly content: unknown;
  readonly usage: unknown;
}

/** The one line type this parse reads, or `undefined` for every other. Written as a narrowing
 *  rather than a zod schema because the input is a stream of shapes we deliberately ignore:
 *  a schema here would either have to describe pi's whole event union or reject most of it. */
function assistantMessageEnd(event: unknown): PiAssistantMessage | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const record = event as { type?: unknown; message?: unknown };
  if (record.type !== "message_end") return undefined;
  if (typeof record.message !== "object" || record.message === null) return undefined;

  const message = record.message as { role?: unknown; content?: unknown; usage?: unknown };
  if (message.role !== "assistant") return undefined;
  return { content: message.content, usage: message.usage };
}

/** The text parts of one assistant message joined, or `undefined` for a message that only made
 *  tool calls — which must not overwrite the prose of an earlier turn with an empty string. */
function finalText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const parts = content.flatMap((part): string[] => {
    if (typeof part !== "object" || part === null) return [];
    const entry = part as { type?: unknown; text?: unknown };
    return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
  });

  return parts.length === 0 ? undefined : parts.join("");
}

/** Reads what is actually there, on the same rule as `parseClaudeCodeResult`'s: a usage block
 *  with nothing recognisable in it is a call we cannot price, not a call that cost nothing. */
function readUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;

  const read = (field: string): number | undefined => {
    const value = (usage as Record<string, unknown>)[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const found: TokenUsage = {
    ...maybe("input", read("input")),
    ...maybe("output", read("output")),
    ...maybe("cacheRead", read("cacheRead")),
    ...maybe("cacheWrite", read("cacheWrite")),
  };

  return isEmptyUsage(found) ? undefined : found;
}

const maybe = (key: keyof TokenUsage, value: number | undefined): TokenUsage =>
  value === undefined ? {} : { [key]: value };

/**
 * One pi session in a worktree.
 *
 * No `--skip-git-repo-check` equivalent is passed because pi needs none: the capture ran it in a
 * plain directory that was not a repository and it worked, which is the case a `research` or
 * `review` task with no worktree lands in.
 */
export async function runPi(
  task: string,
  worktree: string,
  options: CliWorkerOptions,
): Promise<CliOutcome> {
  const result = await runCliProcess("pi", piArgs(task, options.model), worktree, options);
  return parsePiResult(result);
}

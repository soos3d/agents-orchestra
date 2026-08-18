// What an ACP dispatch cost, read from the agent's own books.
//
// **The wire says nothing.** Not one captured frame carries a token count
// (`protocol.ts`, and re-checked against the published adapter), so every ACP dispatch
// was recorded as `unmeasured: 1` — which is honest but useless, and it was hiding the
// largest number in the mission. On a real run measured while writing this file, the
// one dispatch the report called unmeasured had read **288,446 cached tokens and
// written 34,455**, against an orchestrator total of 19,415. The work was seventeen
// times the accounting.
//
// **The agent keeps its own.** Claude Code writes one JSONL per session at
// `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, and `sessionId` is the id ACP's
// `session/new` already hands back — so the file for a dispatch is addressable without
// guessing. Every assistant line carries the API's own `usage` block.
//
// Two facts about that file are captured rather than documented, and both are load
// bearing. Neither is guessable and both were established by diffing this reader's
// output against spend the orchestrator had already measured for itself:
//
//  - **Usage repeats across a message's content blocks.** One API response that emits
//    text and then a tool call writes two lines carrying the *same* usage object.
//    Summing lines multiplies the session by its block count; the dedupe by
//    `message.id` is what makes the totals real. Deduped, this reader reproduced three
//    known sessions of that mission exactly — 2,493, 1,856 and 1,703 tokens.
//  - **On the ACP path, `output_tokens` is the `message_start` snapshot.** SDK-driven
//    sessions write the final count; the ACP adapter's lines report 1–31 per message
//    for a session that wrote 5.9 kB of files. So input and cache are exact and output
//    is a *floor*, and `confidence` says which — the floor lands in `estimated`, never
//    in `measured`. A number is never trusted further than its source.
//
// This is another tool's private file layout, which is why the reader is pure, why it
// is tested against a committed capture rather than a description, and why every
// failure path returns "no reading" instead of throwing: a mission must not fail
// because an accounting file moved.
import path from "node:path";
import { type TokenUsage } from "../../domain/budget.js";

export interface SessionUsage {
  usage: TokenUsage;
  /** `final` when the output figure is the API's last word, `floor` when it is the
   *  snapshot taken as the message began — see the header. */
  confidence: "final" | "floor";
  /** How many API messages the session took. Not a cost, but the only honest measure
   *  of how much work a dispatch was: turns, not tokens, is what a lease bounds. */
  messages: number;
  /** The model the agent actually ran, which is not necessarily the one the spec asked
   *  for — `AgentSpec.model` is not sent over ACP at all. */
  model?: string;
}

/**
 * Where the agent writes the log for a session started in `cwd`.
 *
 * The slug is the absolute path with **each** non-alphanumeric character replaced by a
 * dash — one dash per character, not one per run. The distinction is invisible on an
 * ordinary path and decides everything on a worktree: `…/scratchpad/.orchestra-worktrees`
 * has a `/` and a `.` side by side and the real directory carries both dashes. Collapsing
 * runs found the log for a mission run from a home directory and silently missed it for
 * every mission run from a worktree — which is to say, for every `code` task there is.
 *
 * Captured from a live run rather than reasoned about, and it is why the fixture test
 * below is not the whole story: a shape can be right about a file and wrong about where
 * the file is.
 */
export function sessionLogPath(home: string, cwd: string, sessionId: string): string {
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(home, ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/** An output count this small on a message that also carried a tool call is the
 *  snapshot rather than the total. The threshold is deliberately generous: the
 *  observed snapshots were 1–31 tokens and a real assistant turn is hundreds. */
const SNAPSHOT_OUTPUT = 64;

/**
 * The session's usage, from the file's text.
 *
 * Takes text rather than a path so the parse is testable against a committed capture
 * with no filesystem — the same split `assets.ts` and `fold` are built on.
 */
export function readSessionUsage(text: string): SessionUsage | null {
  // Deduped by API message id, because one response writes a line per content block
  // and each of them repeats the same usage.
  const byMessage = new Map<string, TokenUsage>();
  let model: string | undefined;

  for (const line of text.split("\n")) {
    const entry = parseLine(line);
    if (!entry) continue;

    const previous = byMessage.get(entry.id) ?? {};
    byMessage.set(entry.id, {
      input: keepLarger(previous.input, entry.usage.input),
      output: keepLarger(previous.output, entry.usage.output),
      cacheRead: keepLarger(previous.cacheRead, entry.usage.cacheRead),
      cacheWrite: keepLarger(previous.cacheWrite, entry.usage.cacheWrite),
    });
    model = entry.model ?? model;
  }

  if (byMessage.size === 0) return null;

  const usage: Required<TokenUsage> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const message of byMessage.values()) {
    usage.input += message.input ?? 0;
    usage.output += message.output ?? 0;
    usage.cacheRead += message.cacheRead ?? 0;
    usage.cacheWrite += message.cacheWrite ?? 0;
  }

  // Every message reporting a snapshot-sized output is the ACP shape; one real count
  // anywhere means the file is carrying finals and the total can be believed.
  const everySnapshot = [...byMessage.values()].every(
    (message) => (message.output ?? 0) <= SNAPSHOT_OUTPUT,
  );

  return {
    usage,
    confidence: everySnapshot ? "floor" : "final",
    messages: byMessage.size,
    ...(model === undefined ? {} : { model }),
  };
}

/** The larger of two readings of one field. The snapshot and the final count for the
 *  same message differ only in that the final is bigger. */
const keepLarger = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

interface Reading {
  id: string;
  usage: TokenUsage;
  model?: string;
}

/** One line, or nothing. A line this does not recognise — a summary record, a queue
 *  operation, a half-written last line — is skipped rather than fatal: this file is
 *  read *after* the work, and no accounting problem may cost a finished dispatch. */
function parseLine(line: string): Reading | null {
  if (line.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const record = message as { id?: unknown; model?: unknown; usage?: unknown };
  const usage = record.usage;
  if (typeof usage !== "object" || usage === null) return null;

  // `requestId` is the fallback identity: every captured line carried `message.id`,
  // but a line without one must not silently merge with another message's usage.
  const id =
    typeof record.id === "string"
      ? record.id
      : typeof (parsed as { requestId?: unknown }).requestId === "string"
        ? ((parsed as { requestId: string }).requestId)
        : null;
  if (id === null) return null;

  const read = (field: string): number | undefined => {
    const value = (usage as Record<string, unknown>)[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  return {
    id,
    usage: {
      input: read("input_tokens"),
      output: read("output_tokens"),
      cacheRead: read("cache_read_input_tokens"),
      cacheWrite: read("cache_creation_input_tokens"),
    },
    ...(typeof record.model === "string" ? { model: record.model } : {}),
  };
}

/**
 * The wire estimate, for when there is no session log to read.
 *
 * Characters that crossed the connection, over four. It is in the `estimated` bucket
 * and it belongs there: it counts the *conversation*, while a session is billed for
 * its context re-read on every turn, so on the dispatch measured above it would report
 * roughly eight thousand tokens against an input-equivalent of three hundred thousand.
 * That is a floor with a known direction, which is worth more than a blank — and it is
 * never allowed to be called `measured`.
 */
export const estimateFromWire = (characters: number): TokenUsage => ({
  output: Math.ceil(characters / 4),
});

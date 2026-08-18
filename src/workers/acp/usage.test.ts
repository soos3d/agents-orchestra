// The failure mode under test: an accounting number that is wrong in a way nothing can
// see, because the only witness is another tool's private file.
//
// The fixture is a real ACP dispatch's session log — this repo's own calculator mission,
// 2026-08-15, with the message content stripped and every usage block left exactly as
// the agent wrote it. It is a *capture*, in the same sense and for the same reason as
// `acp-transcripts/`: the two facts this reader depends on are not documented anywhere
// and only real traffic proves them.
//
// Fact one: one API response writes several lines — text, then tool call — each
// repeating the same usage object. Summing lines instead of messages multiplies the
// session by its block count, which is the difference between 322,913 tokens and about
// double that. Fact two: on the ACP path the output figure is the snapshot taken as the
// message began, so it is a floor and must never be reported as measured.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { readSessionUsage, sessionLogPath } from "./usage.js";

const fixture = (): string =>
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "testing",
      "acp-transcripts",
      "claude-session-usage.jsonl",
    ),
    "utf8",
  );

describe("reading a real dispatch's session log", () => {
  test("counts API messages, not lines", () => {
    const reading = readSessionUsage(fixture())!;

    // 19 assistant lines, 10 API responses. The line count is what a naive reader
    // would report, and it would inflate every figure below by ~2x.
    assert.equal(reading.messages, 10);
  });

  test("reports the numbers the API itself reported", () => {
    const reading = readSessionUsage(fixture())!;

    assert.deepEqual(reading.usage, {
      input: 12,
      output: 71,
      cacheRead: 288446,
      cacheWrite: 34455,
    });
  });

  // The whole point of the change. This dispatch was recorded as `unmeasured: 1` while
  // the mission's entire measured spend was 19,415 tokens.
  test("the cached input dwarfs everything the mission had been counting", () => {
    const reading = readSessionUsage(fixture())!;
    const inputEquivalent =
      (reading.usage.input ?? 0) + (reading.usage.cacheRead ?? 0) + (reading.usage.cacheWrite ?? 0);

    assert.ok(inputEquivalent > 300_000, `input-equivalent was ${inputEquivalent}`);
  });

  test("knows its output figure is a floor", () => {
    const reading = readSessionUsage(fixture())!;

    // 71 output tokens for a session that wrote two files is the message_start
    // snapshot, not the total — every message reports a snapshot-sized number.
    assert.equal(reading.confidence, "floor");
  });

  test("names the model that actually ran, which is not the one the spec asked for", () => {
    const reading = readSessionUsage(fixture())!;

    // The task's AgentSpec said claude-sonnet-4-5. ACP never sent it, so the adapter
    // used its own — and the log said sonnet while opus did the work.
    assert.equal(reading.model, "claude-opus-4-6");
  });
});

describe("a log that says something else", () => {
  test("a session with final output counts is believed", () => {
    const final = [
      usageLine("msg_1", { input_tokens: 8, output_tokens: 2485, cache_read_input_tokens: 33498 }),
      usageLine("msg_1", { input_tokens: 8, output_tokens: 2485, cache_read_input_tokens: 33498 }),
    ].join("\n");

    const reading = readSessionUsage(final)!;

    assert.equal(reading.confidence, "final");
    assert.equal(reading.usage.output, 2485, "the repeated line was counted twice");
  });

  test("a partial last line does not lose the lines before it", () => {
    const truncated = `${usageLine("msg_1", { input_tokens: 5, output_tokens: 900 })}\n{"message":{"id":"msg_2","usa`;

    const reading = readSessionUsage(truncated)!;

    assert.equal(reading.messages, 1);
    assert.equal(reading.usage.output, 900);
  });

  test("a file with no usage at all is no reading rather than a zero", () => {
    assert.equal(readSessionUsage('{"type":"queue-operation"}\n'), null);
    assert.equal(readSessionUsage(""), null);
  });

  test("a line carrying usage but no identity is skipped, not merged", () => {
    // Merging two anonymous messages under one key would report the larger of the two
    // as the whole session.
    assert.equal(readSessionUsage('{"message":{"usage":{"input_tokens":900}}}'), null);
  });
});

describe("finding the file", () => {
  test("the slug is the absolute cwd with its separators flattened", () => {
    assert.equal(
      sessionLogPath("/home/dev", "/Users/dev/code/ledger", "abc-123"),
      "/home/dev/.claude/projects/-Users-dev-code-ledger/abc-123.jsonl",
    );
  });

  // The bug a fixture could not have found, and a live mission did on the first try:
  // one dash per character, not per run. A worktree path has `/` and `.` adjacent, and
  // collapsing them looked for a directory that does not exist — so every code task
  // silently fell back to the wire estimate while the real log sat next to it.
  test("adjacent separators each get their own dash", () => {
    assert.equal(
      sessionLogPath("/home/dev", "/tmp/x/.orchestra-worktrees/task-r0", "s1"),
      "/home/dev/.claude/projects/-tmp-x--orchestra-worktrees-task-r0/s1.jsonl",
    );
  });

  test("a relative cwd is resolved before it is flattened", () => {
    // A relative path would produce a slug that matches nothing, and the dispatch
    // would silently go back to being unmeasured.
    assert.match(sessionLogPath("/home/dev", ".", "abc-123"), /projects\/-[A-Za-z0-9-]+\/abc-123/);
  });
});

const usageLine = (id: string, usage: Record<string, number>): string =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", usage } });

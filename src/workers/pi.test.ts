// The failure mode under test: a parser written from pi's documentation rather than from its
// stdout, which reads every example in `docs/json.md` and then hands the mission a worker report
// that is a tool call, an empty string, or a confident zero-token bill.
//
// So `src/testing/cli-transcripts/*.jsonl` are executable fixtures, exactly as
// `acp-transcripts/` are for the ACP parsers: every assertion below runs over stdout a real
// pi 0.84.2 actually printed, and a pi upgrade that renames a field fails the suite instead of
// failing a mission. Three of the cases here — the tool-calling turn, the truncated first line,
// and the unmeasured session — are the three ways this parse can quietly return the wrong thing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { parsePiResult, piArgs, PI_TRANSPORT_VARS } from "./pi.js";

const TRANSCRIPT_DIR = fileURLToPath(new URL("../testing/cli-transcripts/", import.meta.url));
const transcript = (file: string): string => readFileSync(TRANSCRIPT_DIR + file, "utf8");

const outcomeOf = (stdout: string) => parsePiResult({ stdout, stderr: "", code: 0 });

describe("piArgs", () => {
  test("passes the task's model through and asks for the JSON event stream", () => {
    const args = piArgs("Do the thing", "anthropic/claude-sonnet-4-5");

    // `--model` carries the spec's model verbatim: the capture showed it reaching the provider
    // as the model of the request, which is what `honoursModel: true` on the `cli/pi` row means.
    assert.deepEqual(args, [
      "-p",
      "Do the thing",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--mode",
      "json",
      "--no-session",
    ]);
  });

  test("passes no approval flag, because pi has none to pass", () => {
    // `claude` needs `--dangerously-skip-permissions` and `codex` needs `--sandbox`; the capture
    // showed pi executing a `write` under plain `-p` with neither offered nor required. This
    // pins the *absence*, so a future flag is added deliberately rather than discovered.
    const args = piArgs("Do the thing", "sonnet");
    assert.equal(
      args.some((arg) => arg.startsWith("--sandbox") || arg.includes("permission")),
      false,
    );
  });
});

describe("PI_TRANSPORT_VARS", () => {
  test("names the baseline plus the provider keys pi may authenticate with", () => {
    // A child environment is *constructed* from this list (defect 42), so a key missing here is
    // a worker that cannot reach its provider — and one that is here but unset on the machine
    // stays absent rather than becoming "" (`buildWorkerEnv`).
    assert.ok(PI_TRANSPORT_VARS.includes("HOME"));
    assert.ok(PI_TRANSPORT_VARS.includes("ANTHROPIC_API_KEY"));
    assert.ok(PI_TRANSPORT_VARS.includes("OPENAI_API_KEY"));
    // Never a granted mission secret: those arrive through `Envelope.env` and `AgentSpec.env`.
    assert.equal(PI_TRANSPORT_VARS.includes("PATH_TO_SECRET"), false);
  });
});

describe("parsePiResult over captured stdout", () => {
  test("a tool-calling session reports the closing prose, not the tool call", () => {
    // The turn that wrote the file ends with a `message_end` whose content is a `toolCall` and
    // no text. Taking the last assistant message outright would hand the mission a serialized
    // tool call as the worker's report; taking its empty text would hand it "".
    const outcome = outcomeOf(transcript("pi-write-file.jsonl"));

    assert.equal(outcome.text, "Wrote hello.txt as requested.");
  });

  test("usage is the sum of every API call in the session", () => {
    // Two calls, 20/9 then 40/6. Each call bills its whole input, so summing is the charge
    // rather than a double count — and a session priced from one call alone is priced short.
    const outcome = outcomeOf(transcript("pi-write-file.jsonl"));

    assert.deepEqual(outcome.usage, { input: 60, output: 15, cacheRead: 0, cacheWrite: 0 });
  });

  test("a one-call session with no tools reports its text and its usage", () => {
    const outcome = outcomeOf(transcript("pi-text-only.jsonl"));

    assert.equal(outcome.text, "Done: OK.");
    assert.deepEqual(outcome.usage, { input: 40, output: 6, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("parsePiResult on damaged and unfamiliar output", () => {
  test("a first line truncated by the ring buffer costs that line and nothing else", () => {
    // `run()` ring-buffers stdout, so a long session arrives with its opening object cut in
    // half. That fragment is unparseable by construction; taking the buffer down with it would
    // lose the worker's whole report over bytes that were already gone.
    const whole = transcript("pi-text-only.jsonl");
    const truncated = whole.slice(whole.indexOf("\n") - 20);

    const outcome = outcomeOf(truncated);

    assert.equal(outcome.text, "Done: OK.");
  });

  test("CRLF line endings parse, because pi documents accepting them", () => {
    const outcome = outcomeOf(transcript("pi-text-only.jsonl").split("\n").join("\r\n"));

    assert.equal(outcome.text, "Done: OK.");
  });

  test("a session whose frames carry no usage is unmeasured rather than free", () => {
    // The §9.5 rule the whole codebase holds: absent stays absent. Booking a zero here would
    // price a session nobody measured as having cost nothing.
    const stdout = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const outcome = outcomeOf(stdout);

    assert.equal(outcome.text, "done");
    assert.equal(outcome.usage, undefined);
  });

  test("stdout that is not the event stream at all becomes the report", () => {
    // pi refusing to start prints prose, and the mission is better served by being shown it
    // than by being told the worker said nothing.
    const outcome = parsePiResult({
      stdout: "No models available. Use /login to log into a provider.",
      stderr: "",
      code: 0,
    });

    assert.equal(outcome.text, "No models available. Use /login to log into a provider.");
    assert.equal(outcome.usage, undefined);
  });

  test("silence falls back to stderr and then to the exit code", () => {
    assert.equal(
      parsePiResult({ stdout: "", stderr: "boom", code: 1 }).text,
      "boom",
    );
    assert.equal(
      parsePiResult({ stdout: "", stderr: "", code: 137 }).text,
      "pi exited with code 137",
    );
  });

  test("a user or toolResult message is never mistaken for the worker's answer", () => {
    // Every `message_end` line carries a `message.role`, and the fixtures contain `user` and
    // `toolResult` ones whose content is text. Reading role-blind would report the prompt back.
    const outcome = outcomeOf(transcript("pi-write-file.jsonl"));

    assert.equal(outcome.text.includes("Successfully wrote"), false);
    assert.equal(outcome.text.includes("Write hello.txt"), false);
  });
});

// The failure mode under test: a mission that cost real tokens and reports zero.
//
// `claude -p --output-format json` has always returned a `usage` block and this
// transport has always thrown it away, reading `.result` and nothing else. The cost
// was not a missing number on a dashboard — `spendOf` in `loop/dispatch.ts` counts a
// transport that reports nothing as one *unmeasured* dispatch (§9.5), so every CLI
// mission read as ~0 measured tokens and the budget's token ceiling could never bind.
//
// Two of the cases below are the ones that make the difference between a metric and a
// lie, and both come straight from §9.5: absent usage must stay **absent**, never 0,
// because a confident zero is indistinguishable from a cheap mission; and a `usage`
// whose shape has drifted must degrade to unmeasured rather than taking the text down
// with it. The parse is a pure function for the `agentCalls.ts` reason — anything a
// subprocess *returns* belongs somewhere a test can read it, since the fixture harness
// substitutes for the transport and cannot.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseClaudeCodeResult } from "./claudeCode.js";

const envelope = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", result: "Added the clamp.", ...extra });

describe("parseClaudeCodeResult", () => {
  test("reads the final message out of the JSON envelope", () => {
    const outcome = parseClaudeCodeResult({ stdout: envelope(), stderr: "", code: 0 });
    assert.equal(outcome.text, "Added the clamp.");
  });

  test("keeps all four numbers the CLI reports, not their sum", () => {
    // Input, output and cached input are priced differently — 5x and 10x apart — so a
    // total cannot be turned back into money. This used to keep input + output and
    // discard the two cache fields, which on an agentic session is most of the bill.
    const outcome = parseClaudeCodeResult({
      stdout: envelope({
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 288446,
          cache_creation_input_tokens: 34455,
        },
      }),
      stderr: "",
      code: 0,
    });

    assert.deepEqual(outcome.usage, {
      input: 1200,
      output: 340,
      cacheRead: 288446,
      cacheWrite: 34455,
    });
  });

  test("absent usage is unmeasured, not zero (§9.5)", () => {
    // The whole point of the three-way split. A transport that reports nothing must
    // leave the field undefined so `spendOf` counts an unmeasured dispatch; a 0 here
    // would make a real mission read as a free one.
    const outcome = parseClaudeCodeResult({ stdout: envelope(), stderr: "", code: 0 });
    assert.equal(outcome.usage, undefined);
  });

  test("a usage block whose shape drifted does not take the message with it", () => {
    // §12's point about flag drift, applied to the output format: the text is the work
    // and must survive a field we no longer recognise.
    const outcome = parseClaudeCodeResult({
      stdout: envelope({ usage: { input: "1200", output: null } }),
      stderr: "",
      code: 0,
    });
    assert.equal(outcome.text, "Added the clamp.");
    assert.equal(outcome.usage, undefined);
  });

  test("a half-reported usage keeps what was said and omits what was not", () => {
    // The missing fields stay missing rather than becoming zeros: "this CLI did not
    // report cached input" and "this session read no cached input" are different
    // claims, and only one of them is true here.
    const outcome = parseClaudeCodeResult({
      stdout: envelope({ usage: { output_tokens: 340 } }),
      stderr: "",
      code: 0,
    });

    assert.deepEqual(outcome.usage, { output: 340 });
  });

  test("falls back to raw stdout when the envelope is not JSON at all", () => {
    const outcome = parseClaudeCodeResult({ stdout: "I added the clamp.", stderr: "", code: 0 });
    assert.equal(outcome.text, "I added the clamp.");
    assert.equal(outcome.usage, undefined);
  });

  test("falls back to stderr, then to the exit code, when there is no stdout", () => {
    assert.equal(
      parseClaudeCodeResult({ stdout: "", stderr: "not logged in", code: 1 }).text,
      "not logged in",
    );
    assert.equal(
      parseClaudeCodeResult({ stdout: "", stderr: "", code: 127 }).text,
      "claude exited with code 127",
    );
  });

  test("a JSON envelope with no result field falls back rather than returning undefined", () => {
    const outcome = parseClaudeCodeResult({
      stdout: JSON.stringify({ type: "result", subtype: "error_max_turns" }),
      stderr: "",
      code: 0,
    });
    assert.equal(typeof outcome.text, "string");
    assert.notEqual(outcome.text, "");
  });
});

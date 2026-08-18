// The failure mode under test: a worker did its job, wrote a correct report, and the
// task failed because the extractor cut the report in half.
//
// This file had no tests until a real ACP mission produced "Unterminated string in
// JSON" reports that read like a truncated transport. The transport was fine. A worker
// summarising code work writes a fenced block inside its `summary`, one non-greedy
// fence match ended at *that* fence, and what came out was a JSON document missing its
// second half — from a message that was complete on the wire the whole time. It is the
// same class as defect 34: a scanner that does not know what it is inside of.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { extractJsonObject, renderSchema } from "./json.js";

describe("extractJsonObject", () => {
  test("takes a bare object", () => {
    assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  });

  test("strips the prose a model wraps around an answer", () => {
    assert.equal(extractJsonObject('Sure! Here you go:\n{"a":1}\nHope that helps.'), '{"a":1}');
  });

  test("unwraps a fence, with or without the json tag", () => {
    assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(extractJsonObject('```\n{"a":1}\n```'), '{"a":1}');
  });

  // The defect. Every character of the report is present; the first `\`\`\`` inside the
  // summary is what the old scanner stopped at.
  test("survives a fenced code block inside a string value", () => {
    const report = {
      outcome: "completed",
      summary: "Added clamp:\n```js\nexport const clamp = () => {};\n```\nand its tests.",
    };
    const raw = `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;

    const extracted = extractJsonObject(raw);

    assert.ok(extracted);
    assert.deepEqual(JSON.parse(extracted), report);
  });

  test("finds the answer when a model shows a fenced example first", () => {
    const raw = 'For reference the shape is:\n```\nnot json at all\n```\nMy answer:\n```json\n{"a":1}\n```';

    assert.equal(extractJsonObject(raw), '{"a":1}');
  });

  test("returns undefined when there is no object at all", () => {
    assert.equal(extractJsonObject("I could not do that."), undefined);
    assert.equal(extractJsonObject("[1,2,3]"), undefined);
  });

  // Nothing parses, so nothing is recoverable — but the caller's error message should be
  // about the largest thing that looked like an answer, not the first fragment.
  test("hands back the widest candidate when none of them parse", () => {
    const raw = '```json\n{"a":\n```\ntrailing {"b": unquoted}';

    const extracted = extractJsonObject(raw);

    assert.ok(extracted?.includes("unquoted"));
  });
});

describe("renderSchema", () => {
  test("renders a schema as the JSON Schema a prompt can carry", () => {
    const rendered = renderSchema(z.object({ name: z.string(), count: z.number().optional() }));

    assert.match(rendered, /"name"/);
    assert.match(rendered, /"required"/);
  });

  // §4's deliberately open `criteria` field: it must render rather than throw, or the
  // prompt that teaches the shape cannot be built at all.
  test("renders an unrepresentable field instead of throwing", () => {
    assert.doesNotThrow(() => renderSchema(z.object({ criteria: z.array(z.unknown()) })));
  });
});

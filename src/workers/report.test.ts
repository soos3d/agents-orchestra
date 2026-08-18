// The report is the orchestrator's entire evidence base, so the rule under test is
// the one that keeps it that way: exactly one reformat attempt, then the task fails
// as a transport error rather than the loop inventing what the worker meant.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseWorkerReport, WorkerReportError } from "./report.js";
import { aReport } from "../testing/fixtures.js";

const valid = JSON.stringify(aReport({ claims: ["the endpoint returns 200"] }));

describe("parseWorkerReport", () => {
  test("accepts a bare JSON report", async () => {
    const report = await parseWorkerReport(valid);

    assert.equal(report.outcome, "completed");
    assert.deepEqual(report.claims, ["the endpoint returns 200"]);
  });

  // Workers wrap JSON in fences and commentary more often than not, and a reformat
  // round trip to strip ``` is pure waste.
  test("accepts a report wrapped in prose and a fenced block", async () => {
    const raw = `Here is what I did.\n\n\`\`\`json\n${valid}\n\`\`\`\n\nLet me know if you need more.`;

    assert.equal((await parseWorkerReport(raw)).outcome, "completed");
  });

  test("fails without a reformatter when the worker returns prose", async () => {
    await assert.rejects(
      () => parseWorkerReport("I added the endpoint and the tests pass."),
      WorkerReportError,
    );
  });

  test("asks for a reformat exactly once and accepts the result", async () => {
    let calls = 0;

    const report = await parseWorkerReport("I added the endpoint.", {
      reformat: async () => {
        calls++;
        return valid;
      },
    });

    assert.equal(calls, 1);
    assert.equal(report.outcome, "completed");
  });

  // A second attempt would let a worker that cannot follow the schema burn the
  // task's whole budget on retries.
  test("does not ask twice when the reformat is also wrong", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        parseWorkerReport("prose", {
          reformat: async () => {
            calls++;
            return "still prose";
          },
        }),
      /after one reformat attempt/,
    );
    assert.equal(calls, 1);
  });

  test("classifies the failure as transport, which is what §9.4 retries", async () => {
    const err = await parseWorkerReport("prose").catch((e: unknown) => e);

    assert.ok(err instanceof WorkerReportError);
    assert.equal(err.failure, "transport");
    assert.equal(err.raw, "prose");
  });

  test("names the specific field when the shape is close but wrong", async () => {
    const missingSummary = JSON.stringify({ ...aReport(), summary: undefined });

    await assert.rejects(() => parseWorkerReport(missingSummary), /summary/);
  });
});

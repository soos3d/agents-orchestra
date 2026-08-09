// The failure mode under test: the one reformat attempt §4.1 promises, never made.
//
// `parseWorkerReport` has taken a `reformat` since Phase 1a and no entry point ever
// supplied one, so the `if (!options.reformat)` branch was the only one a real mission
// took: a worker whose last message was prose failed outright. It surfaced on a real
// code mission where two dispatches in a row ended `Worker did not return a
// WorkerReport` — one of them "does not match WorkerReport", which is a message that
// was *almost* right and would have survived one restatement.
//
// The report is the orchestrator's entire evidence base (§4.1); it never sees the
// transcript. So a worker that did the work and described it in prose has thrown the
// work away, and the cheapest thing that recovers it is asking once.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aReport } from "../testing/fixtures.js";
import { parseWorkerReport } from "./report.js";
import {
  createCliReformatter,
  REFORMAT_MODEL,
  REFORMAT_TIMEOUT_MS,
  tail,
} from "./transport.js";

/** Records what the restating session was told, and answers with a canned message. */
function fakeCli(answer: string) {
  const seen: { prompt: string; cwd: string; model: string; timeoutMs?: number }[] = [];
  const run = async (
    prompt: string,
    cwd: string,
    options: { model: string; timeoutMs?: number },
  ) => {
    seen.push({ prompt, cwd, model: options.model, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
    return answer;
  };
  return { run, seen };
}

describe("the worker report reformatter", () => {
  test("recovers a report from a worker that answered in prose", async () => {
    const { run } = fakeCli(JSON.stringify(aReport({ summary: "Added clamp and a test." })));
    const reformat = createCliReformatter({ cwd: "/repo", run });

    const report = await parseWorkerReport("I added the clamp function. Tests pass.", {
      reformat,
    });

    assert.equal(report.summary, "Added clamp and a test.");
  });

  // The schema is rendered rather than described, so what the restating session is
  // asked for cannot drift from what the parser will accept — the same rule the
  // worker's own instruction follows.
  test("shows the schema and quotes what the worker actually said", async () => {
    const { run, seen } = fakeCli(JSON.stringify(aReport()));
    const reformat = createCliReformatter({ cwd: "/repo", run });

    await parseWorkerReport("all done, the endpoint works", { reformat });

    assert.match(seen[0]!.prompt, /"criteriaTouched"/);
    assert.match(seen[0]!.prompt, /"deadEnds"/);
    assert.match(seen[0]!.prompt, /all done, the endpoint works/);
    // The specific complaint, so the second attempt fixes the thing that was wrong
    // rather than guessing.
    assert.match(seen[0]!.prompt, /no JSON object found/);
  });

  // Restating one object is not the work. Given the task's own model and wall-clock it
  // would be a second full dispatch against a worker that already failed once.
  test("runs cheap and short rather than on the task's budget", async () => {
    const { run, seen } = fakeCli(JSON.stringify(aReport()));

    await parseWorkerReport("prose", { reformat: createCliReformatter({ cwd: "/repo", run }) });

    assert.equal(seen[0]!.model, REFORMAT_MODEL);
    assert.equal(seen[0]!.timeoutMs, REFORMAT_TIMEOUT_MS);
    assert.ok(REFORMAT_TIMEOUT_MS < 20 * 60_000, "a restatement must not inherit a worker timeout");
  });

  // Exactly one. A second would let a worker that cannot follow the schema spend the
  // task's whole budget proving it.
  test("asks once, then fails as a transport error", async () => {
    const { run, seen } = fakeCli("still prose, sorry");
    const reformat = createCliReformatter({ cwd: "/repo", run });

    await assert.rejects(
      () => parseWorkerReport("prose", { reformat }),
      (error: Error & { failure?: string }) => {
        assert.equal(error.failure, "transport");
        assert.match(error.message, /after one reformat attempt/);
        return true;
      },
    );

    assert.equal(seen.length, 1);
  });

  test("a worker that got it right the first time is never asked again", async () => {
    const { run, seen } = fakeCli("unused");
    const reformat = createCliReformatter({ cwd: "/repo", run });

    await parseWorkerReport(JSON.stringify(aReport()), { reformat });

    assert.equal(seen.length, 0);
  });

  test("sends the end of a long message, where a report would be", () => {
    const long = `${"x".repeat(50)}THE REPORT`;

    assert.equal(tail(long, 10), "…THE REPORT");
    assert.equal(tail("short", 10), "short");
  });
});

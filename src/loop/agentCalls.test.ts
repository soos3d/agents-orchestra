// The model itself is not testable for free; the boundary around it is, and the
// boundary is what breaks. These drive the real `Calls` implementation through a
// fake transport and assert the three rules from §3: structured return validated at
// the edge, exactly one reformat attempt, and spend recorded as measured.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Spend } from "../domain/budget.js";
import { aCriterion, aPlannedTask, aProgressLedger, anAgentSpec } from "../testing/fixtures.js";
import { createAgentCalls, CallFormatError, PROGRESS_MODEL, type RunQuery } from "./agentCalls.js";
import { type ProgressInput } from "./calls.js";

const config = { orchestratorModel: "fable" };

const someSpend = (): Spend => ({
  tokens: { measured: 1200, estimated: 0, unmeasured: 0 },
  wallMs: 900,
  dispatches: 1,
});

interface Recorded {
  prompts: string[];
  models: string[];
  systemPrompts: string[];
}

/** Answers in order, recording what it was asked. */
function transport(answers: readonly string[]): { run: RunQuery; seen: Recorded } {
  const seen: Recorded = { prompts: [], models: [], systemPrompts: [] };
  let index = 0;

  const run: RunQuery = async ({ prompt, model, systemPrompt }) => {
    seen.prompts.push(prompt);
    seen.models.push(model);
    seen.systemPrompts.push(systemPrompt);
    const text = answers[index++];
    if (text === undefined) throw new Error(`transport ran out of answers at call ${index}`);
    return { text, spend: someSpend() };
  };

  return { run, seen };
}

const aProgressInput = (): ProgressInput => ({
  criteria: [aCriterion()],
  reports: [],
  recentProgress: [],
  counters: { round: 1, stalls: 0, resets: 0 },
  frontier: [],
});

describe("createAgentCalls", () => {
  test("returns the validated value when the model answers cleanly", async () => {
    const { run } = transport([JSON.stringify(aProgressLedger({ instruction: "keep going" }))]);
    const calls = createAgentCalls({ config, runQuery: run });

    const ledger = await calls.progress(aProgressInput());

    assert.equal(ledger.instruction, "keep going");
  });

  // Models wrap JSON in prose and fences more often than not; a reformat round trip
  // to strip ``` would cost a call and teach nothing.
  test("accepts an answer wrapped in prose and a fenced block", async () => {
    const { run, seen } = transport([
      `Here's my read on the round:\n\n\`\`\`json\n${JSON.stringify(aProgressLedger())}\n\`\`\`\nHope that helps.`,
    ]);
    const calls = createAgentCalls({ config, runQuery: run });

    await calls.progress(aProgressInput());

    assert.equal(seen.prompts.length, 1);
  });

  describe("the structured-return boundary", () => {
    test("asks for a reformat exactly once, and accepts the second answer", async () => {
      const { run, seen } = transport([
        "I think it's going fine, honestly.",
        JSON.stringify(aProgressLedger({ isInLoop: true })),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const ledger = await calls.progress(aProgressInput());

      assert.equal(ledger.isInLoop, true);
      assert.equal(seen.prompts.length, 2);
      assert.match(seen.prompts[1] ?? "", /Your last answer was rejected/);
    });

    test("tells the retry what was wrong with the first answer", async () => {
      const { run, seen } = transport([
        JSON.stringify({ isRequestSatisfied: "yes please" }),
        JSON.stringify(aProgressLedger()),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.progress(aProgressInput());

      assert.match(seen.prompts[1] ?? "", /isRequestSatisfied/);
    });

    // A second reformat would let a model that cannot follow the schema spend the
    // mission's budget on retries.
    test("does not ask a third time", async () => {
      const { run, seen } = transport(["nope", "still nope"]);
      const calls = createAgentCalls({ config, runQuery: run });

      const error = await calls.progress(aProgressInput()).catch((e: unknown) => e);

      assert.ok(error instanceof CallFormatError);
      assert.equal(error.call, "progress");
      assert.equal(seen.prompts.length, 2);
      assert.match(error.message, /cannot continue on an unparseable answer/);
    });
  });

  describe("each decision point validates its own return", () => {
    test("research rejects a finding with no source", async () => {
      const bad = { brief: "b", confidence: "high", findings: [{ claim: "it is so" }] };
      const good = { brief: "b", confidence: "high", findings: [] };
      const { run } = transport([JSON.stringify(bad), JSON.stringify(good)]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.research({ question: "q", sources: ["memory"], depth: "scan" });

      assert.deepEqual(result.findings, []);
    });

    // Criteria stay untyped through this boundary on purpose: writeOutcomeSpec is
    // what rejects an uncheckable one, and a schema here would make that case
    // unrepresentable and its test impossible.
    test("research passes an uncheckable criterion through to the spec gate", async () => {
      const { run } = transport([
        JSON.stringify({
          brief: "b",
          confidence: "low",
          findings: [],
          criteria: [{ id: "c1", statement: "make it nicer" }],
        }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.research({ question: "q", sources: ["web"], depth: "deep" });

      assert.equal(result.criteria?.length, 1);
    });

    test("plan returns tasks, and may carry a proposed criteria change", async () => {
      const { run } = transport([
        JSON.stringify({ tasks: [aPlannedTask()], criteria: [aCriterion()] }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.plan({
        goal: "g",
        ledger: { ...aProgressInput(), criteria: [] } as never,
        envelope: {} as never,
      });

      assert.equal(result.tasks[0]?.id, "t1");
      assert.equal(result.criteria?.length, 1);
    });

    test("synthesize returns an agent spec", async () => {
      const { run } = transport([JSON.stringify(anAgentSpec({ role: "invoice-reconciler" }))]);
      const calls = createAgentCalls({ config, runQuery: run });

      const spec = await calls.synthesize({
        task: aPlannedTask(),
        envelope: {} as never,
        toolCatalogue: [],
      });

      assert.equal(spec.role, "invoice-reconciler");
    });

    test("judge returns a verdict with evidence behind it", async () => {
      const { run } = transport([
        JSON.stringify({
          met: true,
          evidence: {
            artifactIds: ["a1"],
            checkOutput: "exit 0",
            reasoning: "the endpoint responds 200",
            byTask: ["t1"],
          },
        }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      const result = await calls.judge({
        criterion: aCriterion(),
        check: { kind: "judge", rubric: "r" },
        artifactPaths: ["/tmp/a"],
      });

      assert.equal(result.met, true);
      assert.deepEqual(result.evidence.artifactIds, ["a1"]);
    });
  });

  describe("models and spend", () => {
    // §3: progress is a small structured judgment called more often than anything
    // else, so it does not run on the model that does the planning.
    test("progress runs on a cheaper model than the rest", async () => {
      const { run, seen } = transport([
        JSON.stringify(aProgressLedger()),
        JSON.stringify({ tasks: [] }),
      ]);
      const calls = createAgentCalls({ config, runQuery: run });

      await calls.progress(aProgressInput());
      await calls.plan({ goal: "g", ledger: {} as never, envelope: {} as never });

      assert.equal(seen.models[0], PROGRESS_MODEL);
      assert.equal(seen.models[1], "fable");
    });

    // The loop's own calls are the portion actually billed (§9.5), so they are
    // measured rather than counted as an unmeasured dispatch.
    test("records measured spend for every attempt, including the rejected one", async () => {
      const recorded: { call: string; spend: Spend }[] = [];
      const { run } = transport(["not json", JSON.stringify(aProgressLedger())]);
      const calls = createAgentCalls({
        config,
        runQuery: run,
        onSpend: (call, spend) => recorded.push({ call, spend }),
      });

      await calls.progress(aProgressInput());

      assert.equal(recorded.length, 2);
      assert.equal(recorded[0]?.call, "progress");
      assert.equal(recorded[0]?.spend.tokens.measured, 1200);
      assert.equal(recorded[0]?.spend.tokens.unmeasured, 0);
    });
  });

  test("carries the whole input into the prompt rather than summarizing it", async () => {
    const { run, seen } = transport([JSON.stringify(aProgressLedger())]);
    const calls = createAgentCalls({ config, runQuery: run });

    await calls.progress(aProgressInput());

    // A hand-written summary here would be a second, undeclared reducer over folded
    // state — and prompt building is supposed to be a pure function of it (§3).
    assert.match(seen.prompts[0] ?? "", /"round": 1/);
    assert.match(seen.prompts[0] ?? "", /GET \/health/);
    assert.match(seen.systemPrompts[0] ?? "", /isInLoop/);
  });
});

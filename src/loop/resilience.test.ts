// Defect 36: a decision point that will not answer used to kill the run process.
//
// The failure mode under test is not "the model was wrong" — it is a *live mission*
// with commits on disk, a signed-off contract, and a ledger, ended by an exception
// unwinding to `main` because one call came back throttled. §9.4 answers every other
// failure in the system with a retry or a park, and these assert it answers this one
// the same way: a transport-shaped failure is tried twice, a schema the model has
// already failed twice is not, and either way what comes out is typed so the loop can
// park on it rather than crash.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CallFormatError } from "./agentCalls.js";
import { type Calls, type ResearchResult } from "./calls.js";
import { DecisionPointError, isRetriable, resilientCalls } from "./resilience.js";

const aResearchResult = (): ResearchResult => ({
  brief: "brief",
  findings: [],
  confidence: "high",
});

/** Only the calls a test exercises; the wrapper never touches the others. */
function stubCalls(overrides: Partial<Calls>): Calls {
  const unused = (name: string) => async () => {
    throw new Error(`${name} was not part of this test`);
  };
  return {
    research: unused("research"),
    intake: unused("intake"),
    plan: unused("plan"),
    synthesize: unused("synthesize"),
    progress: unused("progress"),
    judge: unused("judge"),
    ...overrides,
  } as Calls;
}

describe("isRetriable", () => {
  test("a format error is not — it has already had its one reformat attempt", () => {
    assert.equal(isRetriable(new CallFormatError("research", "no JSON object was found")), false);
  });

  test("anything else is: a throttled call never reached a model to disagree with", () => {
    assert.equal(isRetriable(new Error("429 rate_limit_error")), true);
  });
});

describe("resilientCalls", () => {
  test("passes a successful answer straight through", async () => {
    const calls = resilientCalls(stubCalls({ research: async () => aResearchResult() }));

    assert.equal((await calls.research({ question: "q", sources: [], depth: "scan" })).brief, "brief");
  });

  test("retries a transport failure once and returns the second answer", async () => {
    let attempts = 0;
    const slept: number[] = [];

    const calls = resilientCalls(
      stubCalls({
        research: async () => {
          attempts++;
          if (attempts === 1) throw new Error("429 rate_limit_error");
          return aResearchResult();
        },
      }),
      { sleep: async (ms) => void slept.push(ms) },
    );

    const result = await calls.research({ question: "q", sources: [], depth: "scan" });

    assert.equal(result.brief, "brief");
    assert.equal(attempts, 2);
    assert.equal(slept.length, 1, "it backed off before the second attempt");
  });

  test("gives up as a DecisionPointError naming the call, not a bare throw", async () => {
    const calls = resilientCalls(
      stubCalls({
        progress: async () => {
          throw new Error("429 rate_limit_error");
        },
      }),
      { sleep: async () => {} },
    );

    await assert.rejects(
      () =>
        calls.progress({
          criteria: [],
          reports: [],
          recentProgress: [],
          counters: { round: 1, stalls: 0, resets: 0 },
          frontier: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof DecisionPointError);
        assert.equal(error.call, "progress");
        assert.equal(error.attempts, 2);
        assert.match(error.message, /rate_limit_error/);
        return true;
      },
    );
  });

  // The other half of the judgment: retrying a schema the model has failed twice
  // spends the mission's budget to learn the same thing. `agentCalls.ts` has already
  // asked once, quoted the rejection, and asked again.
  test("does not retry a format error, and says it tried once", async () => {
    let attempts = 0;
    const calls = resilientCalls(
      stubCalls({
        research: async () => {
          attempts++;
          throw new CallFormatError("research", "no JSON object was found in the response");
        },
      }),
      { sleep: async () => {} },
    );

    await assert.rejects(
      () => calls.research({ question: "q", sources: [], depth: "scan" }),
      (error: unknown) => {
        assert.ok(error instanceof DecisionPointError);
        assert.equal(error.attempts, 1);
        return true;
      },
    );
    assert.equal(attempts, 1);
  });

  // A seventh decision point added to `Calls` and forgotten here would be a call with
  // no retry and no park — defect 36 coming back one method over. The wrapper is
  // written over the interface's own keys, and this is what asserts the list is whole.
  test("wraps every call the interface declares", () => {
    const calls = resilientCalls(stubCalls({}));

    assert.deepEqual(Object.keys(calls).sort(), [
      "intake",
      "judge",
      "plan",
      "progress",
      "research",
      "synthesize",
    ]);
  });
});

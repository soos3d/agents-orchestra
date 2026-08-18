// Budgets are a ceiling enforced in code, not a prompt rule, so the case that
// matters is the one where the numbers a subscription CLI does not report must not
// quietly make the ceiling unreachable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addBudget,
  addSpend,
  budgetExceeded,
  isEmptyUsage,
  tokensFrom,
  webSearchRequestsOf,
  zeroSpend,
} from "./budget.js";

const spend = (patch: { wallMs?: number; measured?: number; dispatches?: number } = {}) => ({
  ...zeroSpend(),
  wallMs: patch.wallMs ?? 0,
  tokens: { measured: patch.measured ?? 0, estimated: 0, unmeasured: 0 },
  dispatches: patch.dispatches ?? 0,
});

describe("budget", () => {
  test("wall-clock is the ceiling that binds", () => {
    assert.equal(budgetExceeded({ wallMs: 1000 }, spend({ wallMs: 999 })), false);
    assert.equal(budgetExceeded({ wallMs: 1000 }, spend({ wallMs: 1000 })), true);
  });

  // A mission run entirely on CLI workers reports no tokens, and a token limit is
  // the only one set. Without wall-clock it would never trip at all.
  test("an unmeasurable token limit does not make the mission unbounded", () => {
    const cliOnly = spend({ wallMs: 5000, measured: 0, dispatches: 40 });

    assert.equal(budgetExceeded({ wallMs: 4000, tokens: 500_000 }, cliOnly), true);
  });

  test("a token ceiling binds on the measured portion when it is set", () => {
    assert.equal(budgetExceeded({ wallMs: 10_000, tokens: 100 }, spend({ measured: 100 })), true);
  });

  test("dispatches are the backstop where tokens read zero", () => {
    assert.equal(
      budgetExceeded({ wallMs: 10_000, dispatches: 3 }, spend({ dispatches: 3 })),
      true,
    );
  });

  test("an unset optional limit never trips", () => {
    assert.equal(budgetExceeded({ wallMs: 10_000 }, spend({ measured: 9_000_000 })), false);
  });

  test("spend adds across all three token buckets", () => {
    const total = addSpend(spend({ wallMs: 10, measured: 5, dispatches: 1 }), {
      tokens: { measured: 2, estimated: 3, unmeasured: 4 },
      wallMs: 20,
      dispatches: 1,
    });

    assert.deepEqual(total, {
      tokens: { measured: 7, estimated: 3, unmeasured: 4 },
      wallMs: 30,
      dispatches: 2,
    });
  });

  // The kinds are the second axis: how well a number is known (measured / estimated /
  // unmeasured) and what kind of token it is. Conflating them is what made a mission's
  // cost underivable from its own log.
  describe("token kinds", () => {
    test("measured stays input + output, so every existing reader keeps working", () => {
      const tokens = tokensFrom({ input: 1200, output: 340, cacheRead: 288446, cacheWrite: 34455 });

      // Cache is reported beside the total and deliberately not folded into it: this
      // number is what `budgetExceeded` compares a ceiling against, and every log
      // written before the split means it this way.
      assert.equal(tokens.measured, 1540);
      assert.equal(tokens.cacheRead, 288446);
      assert.equal(tokens.cacheWrite, 34455);
    });

    test("a floor output is estimated, never measured", () => {
      const tokens = tokensFrom({ input: 12, output: 71 }, { estimatedOutput: true });

      // The one source that knows its output figure is a snapshot rather than a total
      // (`workers/acp/usage.ts`). Counting it as measured would make an unknown look
      // like an answer.
      assert.equal(tokens.measured, 12);
      assert.equal(tokens.estimated, 71);
      assert.equal(tokens.output, 71, "the kind is still reported, only not as measured");
    });

    test("a kind nobody reported stays absent rather than becoming zero", () => {
      const tokens = tokensFrom({ output: 340 });

      assert.equal(tokens.input, undefined);
      assert.equal(tokens.cacheRead, undefined);
      assert.equal(isEmptyUsage({}), true);
      assert.equal(isEmptyUsage({ output: 0 }), false, "a reported zero is a report");
    });

    test("adding absent to absent is still absent", () => {
      // Summing an unreported field as zero would turn "this transport does not say"
      // into "this transport says none" the moment two spends were added.
      const total = addSpend(
        { tokens: { measured: 5, estimated: 0, unmeasured: 0 }, wallMs: 1, dispatches: 1 },
        { tokens: { measured: 5, estimated: 0, unmeasured: 0 }, wallMs: 1, dispatches: 1 },
      );

      assert.equal(total.tokens.input, undefined);
    });

    test("adding a reported kind to an unreported one keeps the report", () => {
      const total = addSpend(
        { tokens: { measured: 5, estimated: 0, unmeasured: 0 }, wallMs: 1, dispatches: 1 },
        { tokens: { measured: 5, estimated: 0, unmeasured: 0, input: 4, cacheRead: 90 }, wallMs: 1, dispatches: 1 },
      );

      assert.equal(total.tokens.input, 4);
      assert.equal(total.tokens.cacheRead, 90);
    });
  });

  // Web searches are a third metered quantity, not a token kind. Absent and zero
  // are different claims here too: a transport that never mentioned searches has
  // not reported none, and summing two such spends must not invent a 0.
  describe("web search requests", () => {
    test("zeroSpend omits webSearchRequests rather than claiming zero", () => {
      assert.equal("webSearchRequests" in zeroSpend(), false);
    });

    test("addSpend sums webSearchRequests", () => {
      const total = addSpend(
        { ...spend(), webSearchRequests: 2 },
        { ...spend(), webSearchRequests: 3 },
      );

      assert.equal(total.webSearchRequests, 5);
    });

    test("adding a reported count to an unreported one keeps the report", () => {
      const total = addSpend(spend(), { ...spend(), webSearchRequests: 4 });

      assert.equal(total.webSearchRequests, 4);
    });

    test("adding absent to absent leaves the field missing, not zero", () => {
      const total = addSpend(spend(), spend());

      assert.equal("webSearchRequests" in total, false);
    });
  });

  describe("webSearchRequestsOf", () => {
    test("reads server_tool_use.web_search_requests", () => {
      assert.equal(webSearchRequestsOf({ server_tool_use: { web_search_requests: 3 } }), 3);
    });

    test("a usage with no server_tool_use reports nothing", () => {
      assert.equal(webSearchRequestsOf({}), undefined);
      assert.equal(webSearchRequestsOf({ server_tool_use: null }), undefined);
    });

    test("a non-number search count is ignored, not thrown", () => {
      assert.equal(
        webSearchRequestsOf({ server_tool_use: { web_search_requests: "3" } }),
        undefined,
      );
      assert.equal(
        webSearchRequestsOf({ server_tool_use: { web_search_requests: null } }),
        undefined,
      );
    });
  });

  test("extending a budget keeps an unset optional limit unset", () => {
    assert.deepEqual(addBudget({ wallMs: 1000 }, { wallMs: 500 }), {
      wallMs: 1500,
      tokens: undefined,
      dispatches: undefined,
    });
  });

  test("extending a budget adds a limit that only one side set", () => {
    assert.equal(addBudget({ wallMs: 1000, tokens: 100 }, { wallMs: 500 }).tokens, 100);
  });
});

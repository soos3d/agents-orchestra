// Budgets are a ceiling enforced in code, not a prompt rule, so the case that
// matters is the one where the numbers a subscription CLI does not report must not
// quietly make the ceiling unreachable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addBudget, addSpend, budgetExceeded, zeroSpend } from "./budget.js";

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

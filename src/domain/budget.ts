// What a mission is allowed to spend, and what it actually spent.
//
// `wallMs` is required and the token ceiling is not, which is the §9.5 argument
// expressed in the type: subscription CLIs do not report tokens, so a mission run
// on them has no meaningful token ceiling and `dispatches` is the crude limit that
// still works there.
import { z } from "zod";

export const budgetSchema = z.object({
  wallMs: z.number().int().positive(),
  tokens: z.number().int().positive().optional(),
  dispatches: z.number().int().positive().optional(),
});

// The three-way token split is the point: a single number that silently omits
// every CLI worker reads as a cheap mission when most of the spend is invisible.
export const spendSchema = z.object({
  tokens: z.object({
    measured: z.number().int().nonnegative(),
    estimated: z.number().int().nonnegative(),
    unmeasured: z.number().int().nonnegative(),
  }),
  wallMs: z.number().int().nonnegative(),
  dispatches: z.number().int().nonnegative(),
});

export type Budget = z.infer<typeof budgetSchema>;
export type Spend = z.infer<typeof spendSchema>;

export const zeroSpend = (): Spend => ({
  tokens: { measured: 0, estimated: 0, unmeasured: 0 },
  wallMs: 0,
  dispatches: 0,
});

export function addSpend(a: Spend, b: Spend): Spend {
  return {
    tokens: {
      measured: a.tokens.measured + b.tokens.measured,
      estimated: a.tokens.estimated + b.tokens.estimated,
      unmeasured: a.tokens.unmeasured + b.tokens.unmeasured,
    },
    wallMs: a.wallMs + b.wallMs,
    dispatches: a.dispatches + b.dispatches,
  };
}

export function addBudget(a: Budget, b: Budget): Budget {
  const sum = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    wallMs: a.wallMs + b.wallMs,
    tokens: sum(a.tokens, b.tokens),
    dispatches: sum(a.dispatches, b.dispatches),
  };
}

// Wall-clock is the primary ceiling; the other two only bind when they were set.
export function budgetExceeded(budget: Budget, spend: Spend): boolean {
  if (spend.wallMs >= budget.wallMs) return true;
  if (budget.tokens !== undefined && spend.tokens.measured >= budget.tokens) return true;
  if (budget.dispatches !== undefined && spend.dispatches >= budget.dispatches) return true;
  return false;
}

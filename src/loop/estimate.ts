// What sign-off costs, computed rather than asked for (§4).
//
// The plan already exists at sign-off, so the estimate is arithmetic over it and not
// another model call.
//
// It deliberately predicts no token figure. It used to: four hand-authored per-call
// constants summed into `Estimate.tokens` and rendered as "~45k tokens measured". That
// number was wrong in both directions at once, because it was a prediction of the wrong
// quantity. Prompt caching moved almost all input into `cacheRead` — on a real run input
// was a flat 2 tokens per call — so `measured` (input + output) stopped tracking the work
// a mission does, while actual token movement ran an order of magnitude above it: 45,000
// predicted, 11,662 measured, 470,767 moved. The judge calls the constants charged 6,000
// apiece for were the single largest line, at 68,366 of cache for two of them.
//
// So there is nothing here to calibrate back into agreement — a coefficient fix would
// have kept the same undefined quantity and made it look trustworthy. What a mission
// actually cost is reported from the log by `orchestra metrics`, where every figure is
// measured rather than guessed. Restoring a prediction means first deciding which of the
// four token kinds it is of, and deriving its coefficients from committed logs.
import { type PlannedTask } from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";

export function estimatePlan(plan: readonly PlannedTask[]): Estimate {
  return {
    taskCount: plan.length,
    wallMs: criticalPathMs(plan),
    // Before synthesis, the plan knows the worker kind and nothing about the actions
    // inside it. Every computer task is expected to reach at least one commit gate;
    // §11's rehearsal collapses the rest of them into that one approval.
    expectedGates: plan.filter((task) => task.worker === "computer").length,
  };
}

/** The DAG's longest path by wall-clock. Tasks that fan out run in parallel, so the
 *  sum of every task's budget is not what a mission takes. */
function criticalPathMs(plan: readonly PlannedTask[]): number {
  const byId = new Map(plan.map((task) => [task.id, task]));
  const memo = new Map<string, number>();

  // A cycle would recurse forever. `validatePlan` runs before this and rejects one;
  // the visiting set is what keeps a mistake there from becoming a hang here.
  const visiting = new Set<string>();

  const from = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (!task || visiting.has(id)) return 0;

    visiting.add(id);
    const deps = task.dependsOn.map(from);
    visiting.delete(id);

    const total = task.estimatedWallMs + Math.max(0, ...deps);
    memo.set(id, total);
    return total;
  };

  return Math.max(0, ...plan.map((task) => from(task.id)));
}

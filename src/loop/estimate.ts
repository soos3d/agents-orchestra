// What sign-off costs, computed rather than asked for (§4).
//
// The plan already exists at sign-off, so the estimate is arithmetic over it and not
// another model call. It reports the measured and unmeasured portions separately for
// the §9.5 reason: a single confident token number that silently omits every CLI
// worker reads as a cheap mission when most of the spend is invisible.
import { type PlannedTask } from "../domain/ledger.js";
import { type Estimate } from "../domain/mission.js";

/**
 * Coarse per-call token costs for the in-process decision points (§3). These are the
 * only tokens a mission on subscription CLIs actually bills for, and they are the
 * portion the SDK reports — so they are estimable and worth showing, and they are
 * replaced by measured `spend_recorded` figures the moment a mission has run.
 */
const TOKENS = {
  plan: 8_000,
  synthesize: 4_000,
  progress: 3_000,
  judge: 6_000,
} as const;

export interface EstimateInput {
  plan: readonly PlannedTask[];
  criteriaCount: number;
}

export function estimatePlan({ plan, criteriaCount }: EstimateInput): Estimate {
  const depth = criticalPathDepth(plan);

  return {
    taskCount: plan.length,
    // One plan call, one synthesis per task, one progress call per expected round,
    // one judge per criterion. Rounds are estimated by DAG depth: a plan five layers
    // deep cannot finish in fewer than five rounds.
    tokens:
      TOKENS.plan +
      plan.length * TOKENS.synthesize +
      Math.max(depth, 1) * TOKENS.progress +
      criteriaCount * TOKENS.judge,
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
  return longest(plan, (task) => task.estimatedWallMs);
}

function criticalPathDepth(plan: readonly PlannedTask[]): number {
  return longest(plan, () => 1);
}

function longest(plan: readonly PlannedTask[], weight: (task: PlannedTask) => number): number {
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

    const total = weight(task) + Math.max(0, ...deps);
    memo.set(id, total);
    return total;
  };

  return Math.max(0, ...plan.map((task) => from(task.id)));
}

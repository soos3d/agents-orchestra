// Topological validation of a returned plan (§3).
//
// `plan` returns PlannedTask[] with `dependsOn`, and a graph that cannot be
// topologically sorted has no ready set — ever. Left unchecked, the mission spends
// its whole reset budget replanning a shape the scheduler will never dispatch, and
// none of the counters can tell that apart from hard work.
//
// So the graph is checked before a single agent is synthesized, and a rejection
// quotes the offending edge because the planner's one structured-return retry is
// worthless without it.
import { type Criterion, type PlannedTask } from "../domain/ledger.js";

export type PlanValidation =
  | { ok: true; order: string[] }
  | { ok: false; message: string };

/**
 * @param criteria The contract this plan is supposed to satisfy. Optional because the
 * graph checks stand alone, and supplied by every real caller — a plan that orphans a
 * criterion is as unrunnable as one with a cycle, just later and less visibly
 * (defect 32).
 */
export function validatePlan(
  plan: readonly PlannedTask[],
  criteria: readonly Criterion[] = [],
): PlanValidation {
  const duplicate = firstDuplicateId(plan);
  if (duplicate) {
    return {
      ok: false,
      message:
        `Two planned tasks share the id '${duplicate}', so every dependsOn naming it is ` +
        `ambiguous. Give each task a distinct id.`,
    };
  }

  const known = new Set(plan.map((task) => task.id));
  for (const task of plan) {
    const unknown = task.dependsOn.find((id) => !known.has(id));
    if (unknown !== undefined) {
      return {
        ok: false,
        message:
          `Task '${task.id}' depends on '${unknown}', which is not in the plan. ` +
          `Either add that task or drop the edge.`,
      };
    }
  }

  // Checked after the graph, because an unschedulable plan is the more basic problem
  // and quoting one rejection at a time is what makes the planner's single retry
  // usable (§3).
  const orphaned = criteria.filter(
    (criterion) =>
      criterion.met !== true && !plan.some((task) => task.satisfies.includes(criterion.id)),
  );
  if (orphaned.length > 0) {
    const named = orphaned.map((criterion) => `'${criterion.id}' (${criterion.statement})`);
    return {
      ok: false,
      message:
        `No task in the plan satisfies ${named.join(", ")}. A criterion is checked when ` +
        `the last task listing it in 'satisfies' lands, so one no task claims can never ` +
        `be checked and the mission can never complete. Add work for it, or list it on ` +
        `the task that already covers it.`,
    };
  }

  const sorted = topologicalOrder(plan);
  if ("order" in sorted) return { ok: true, order: sorted.order };

  return {
    ok: false,
    message:
      `The plan has a dependency cycle: ${sorted.cycle.join(" → ")} (each depends on the ` +
      `next). Break it by removing one of those edges — a cycle can never become ready.`,
  };
}

function firstDuplicateId(plan: readonly PlannedTask[]): string | undefined {
  const seen = new Set<string>();
  for (const task of plan) {
    if (seen.has(task.id)) return task.id;
    seen.add(task.id);
  }
  return undefined;
}

/** Kahn's algorithm. Whatever it cannot drain is, by definition, inside a cycle. */
function topologicalOrder(
  plan: readonly PlannedTask[],
): { order: string[] } | { cycle: string[] } {
  const remaining = new Map(plan.map((task) => [task.id, new Set(task.dependsOn)]));
  const order: string[] = [];

  for (;;) {
    const next = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (next.length === 0) break;

    for (const id of next) {
      remaining.delete(id);
      order.push(id);
    }
    for (const deps of remaining.values()) {
      for (const id of next) deps.delete(id);
    }
  }

  if (remaining.size === 0) return { order };
  return { cycle: traceCycle(plan, [...remaining.keys()]) };
}

/** Walk the surviving subgraph until a node repeats: that walk *is* the cycle. */
function traceCycle(plan: readonly PlannedTask[], stuck: readonly string[]): string[] {
  const byId = new Map(plan.map((task) => [task.id, task]));
  const inCycle = new Set(stuck);

  const path: string[] = [];
  let current: string | undefined = stuck[0];
  while (current !== undefined && !path.includes(current)) {
    path.push(current);
    current = byId.get(current)?.dependsOn.find((id) => inCycle.has(id));
  }

  // Every stuck node has a stuck dependency, so the walk always closes. `current` is
  // where it closed; anything before that is the tail that led into the loop.
  if (current === undefined) return path;
  return [...path.slice(path.indexOf(current)), current];
}

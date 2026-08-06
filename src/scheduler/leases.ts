// File leases (§8).
//
// The failure mode worktrees do *not* prevent: two workers making semantically
// incompatible changes, each green in isolation. Worktrees stop file collisions,
// not disagreements — so a code task declares what it owns, and the declaration is
// checked twice, because a declaration is a promise and not a guarantee.
import picomatch from "picomatch";

export interface Lease {
  taskId: string;
  owns: readonly string[];
}

export type LeaseDecision =
  | { granted: true }
  | { granted: false; conflictsWith: string; overlap: string; message: string };

const matcher = (globs: readonly string[]) => picomatch([...globs], { dot: true });

/**
 * Two glob sets overlap if either matches a literal path from the other. Cheap,
 * deterministic, and deliberately approximate: `src/**` and `src/routes/*.ts`
 * overlap by inspection, and proving it in general is not worth a solver.
 *
 * The approximation is one-sided on purpose — it can report an overlap that would
 * not have happened, and rejecting a dispatch costs a replan while missing one costs
 * two workers editing the same file.
 */
export function globsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const matchesA = matcher(a);
  const matchesB = matcher(b);
  return (
    a.some((glob) => matchesB(literalPrefix(glob)) || matchesB(glob)) ||
    b.some((glob) => matchesA(literalPrefix(glob)) || matchesA(glob))
  );
}

/** The part of a glob before its first magic character — `src/routes/**` → `src/routes`. */
function literalPrefix(glob: string): string {
  const magic = glob.search(/[*?[{]/);
  const literal = magic === -1 ? glob : glob.slice(0, magic);
  return literal.replace(/\/$/, "");
}

export function requestLease(
  held: readonly Lease[],
  taskId: string,
  owns: readonly string[],
): LeaseDecision {
  for (const lease of held) {
    if (lease.taskId === taskId) continue;
    const overlap = owns.find((glob) => globsOverlap([glob], lease.owns));
    if (overlap !== undefined) {
      return {
        granted: false,
        conflictsWith: lease.taskId,
        overlap,
        message:
          `Lease on '${overlap}' overlaps ${lease.taskId}'s lease on ` +
          `${lease.owns.join(", ")}. Narrow one of the tasks or make them sequential.`,
      };
    }
  }
  return { granted: true };
}

export interface Escape {
  escaped: true;
  touched: string[];
  message: string;
}

/**
 * The second check, after the worker returns: did it write outside what it declared?
 *
 * A worker that escaped its lease fails the task and is **not** retried — an escape
 * means the plan was wrong about what the work touches, so it goes back to the outer
 * loop rather than back to the same worker with the same instructions.
 */
export function detectEscape(
  declared: readonly string[],
  touched: readonly string[],
): Escape | { escaped: false } {
  const allowed = matcher(declared);
  const outside = touched.filter((file) => !allowed(file));
  if (outside.length === 0) return { escaped: false };

  return {
    escaped: true,
    touched: outside,
    message:
      `Worker wrote outside its lease: ${outside.join(", ")} (declared ${declared.join(", ")}). ` +
      `The task fails without retry — the plan was wrong about what this work touches.`,
  };
}

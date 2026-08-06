// Typed retry (§9.4). Blind retry of a semantic failure is pure waste: the same
// agent, the same prompt, and the same wrong answer, paid for twice.
//
// So the classification comes first and the policy follows from it. Two of the rows
// exist to *stop* a retry that looks reasonable: a lease escape means the plan was
// wrong about what the work touches, and a denied gate means a human said no. Both
// go back to the outer loop, and the second is recorded as a dead end so the next
// replan does not propose the same payment.
export type FailureKind =
  /** Spawn failed, the transport disconnected, the worker could not produce its
   *  return type. Nothing was learned about the work. */
  | "transport"
  /** The check ran and said no. */
  | "verification"
  /** The worker itself reported it did not land the work. */
  | "worker_failed"
  | "lease_escape"
  | "merge_conflict"
  | "envelope_violation"
  | "task_budget"
  | "gate_denied";

export type RetryAction =
  /** Same agent, same instructions — only transport failures qualify. */
  | { kind: "retry"; attempt: number; backoffMs: number }
  /** A new task carrying the failure output, planned by the outer loop. */
  | { kind: "fix"; reason: string }
  /** Back to the outer loop with no automatic follow-up. */
  | { kind: "none"; reason: string };

export const MAX_TRANSPORT_ATTEMPTS = 2;

const BASE_BACKOFF_MS = 1000;

/**
 * What to do about a failed dispatch. `attempts` is how many times this task has
 * already been dispatched, including the one that just failed.
 */
export function retryPolicy(failure: FailureKind, attempts: number): RetryAction {
  switch (failure) {
    case "transport":
      return attempts < MAX_TRANSPORT_ATTEMPTS
        ? {
            kind: "retry",
            attempt: attempts + 1,
            backoffMs: BASE_BACKOFF_MS * 2 ** (attempts - 1),
          }
        : {
            kind: "none",
            reason:
              `The transport failed ${attempts} times, so the worker never ran. ` +
              `Retrying a third time spends the task's budget on the same error.`,
          };

    case "verification":
      return {
        kind: "fix",
        reason:
          "Verification failed, which is information rather than an error. A fix task " +
          "carries the failure output; re-running the same agent would not see it.",
      };

    case "worker_failed":
      return {
        kind: "fix",
        reason: "The worker reported it could not land the work, and said why.",
      };

    case "merge_conflict":
      return {
        kind: "fix",
        reason: "The branch conflicts with the integration branch and has to be resolved on it.",
      };

    case "lease_escape":
      return {
        kind: "none",
        reason:
          "The worker wrote outside its lease, so the plan was wrong about what this work " +
          "touches. That goes back to the planner, not back to the same worker.",
      };

    case "envelope_violation":
      return {
        kind: "none",
        reason:
          "The task asked for a capability outside the mission envelope. Widening an " +
          "envelope is a human decision, so this surfaces as a question.",
      };

    case "task_budget":
      return {
        kind: "none",
        reason: "The task spent its budget. The replan may re-scope it smaller.",
      };

    case "gate_denied":
      return {
        kind: "none",
        reason:
          "A human declined the gate, which is an answer. It is recorded as a dead end so " +
          "the next replan does not propose it again.",
      };
  }
}

/** A denied gate cancels rather than fails: nothing went wrong. */
export const isCancellation = (failure: FailureKind): boolean => failure === "gate_denied";

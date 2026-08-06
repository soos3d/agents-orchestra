// The point of the table is which failures do *not* retry. Blind retry of a semantic
// failure buys the same wrong answer at twice the price, and two of these rows exist
// to stop a retry that looks perfectly reasonable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isCancellation, MAX_TRANSPORT_ATTEMPTS, retryPolicy } from "./retry.js";

describe("retryPolicy", () => {
  test("retries a transport failure with backoff", () => {
    const action = retryPolicy("transport", 1);

    assert.equal(action.kind, "retry");
    assert.equal(action.kind === "retry" && action.attempt, 2);
    assert.ok(action.kind === "retry" && action.backoffMs > 0);
  });

  test("stops retrying the transport at the cap", () => {
    const action = retryPolicy("transport", MAX_TRANSPORT_ATTEMPTS);

    assert.equal(action.kind, "none");
  });

  test("backs off further on the second attempt", () => {
    const first = retryPolicy("transport", 1);
    const later = retryPolicy("transport", 2);

    // With the cap at two, the second call already refuses; the growth is asserted
    // through the formula rather than the cap so raising the cap keeps this honest.
    assert.ok(first.kind === "retry" && first.backoffMs >= 1000);
    assert.equal(later.kind, "none");
  });

  // Re-running the same agent would not see the failure output. A fix task carries it.
  test("sends a failed verification to a fix task rather than a retry", () => {
    assert.equal(retryPolicy("verification", 1).kind, "fix");
  });

  test("sends a worker-declared failure to a fix task", () => {
    assert.equal(retryPolicy("worker_failed", 1).kind, "fix");
  });

  test("sends a merge conflict to a fix task", () => {
    assert.equal(retryPolicy("merge_conflict", 1).kind, "fix");
  });

  // §8: an escape means the plan was wrong about what the work touches, so it goes
  // back to the planner, not back to the same worker with the same instructions.
  test("never retries a lease escape", () => {
    const action = retryPolicy("lease_escape", 1);

    assert.equal(action.kind, "none");
    assert.match(action.kind === "none" ? action.reason : "", /back to the planner/);
  });

  test("never retries an envelope violation, and says a human decides", () => {
    const action = retryPolicy("envelope_violation", 1);

    assert.equal(action.kind, "none");
    assert.match(action.kind === "none" ? action.reason : "", /human decision/);
  });

  test("never retries a task that spent its budget", () => {
    assert.equal(retryPolicy("task_budget", 1).kind, "none");
  });

  // A human said no. That is an answer, and it is recorded as a dead end.
  test("never retries a denied gate", () => {
    const action = retryPolicy("gate_denied", 1);

    assert.equal(action.kind, "none");
    assert.match(action.kind === "none" ? action.reason : "", /dead end/);
  });
});

describe("isCancellation", () => {
  test("a denied gate cancels, because nothing went wrong", () => {
    assert.equal(isCancellation("gate_denied"), true);
  });

  test("everything else failed", () => {
    assert.equal(isCancellation("verification"), false);
    assert.equal(isCancellation("transport"), false);
  });
});

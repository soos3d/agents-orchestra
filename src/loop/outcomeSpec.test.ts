// The failure this exists to prevent: a mission that runs its whole reset budget,
// does every task correctly, and can never legitimately say it is finished — because
// the contract it was given cannot be evaluated by anything.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { writeOutcomeSpec } from "./outcomeSpec.js";

describe("writeOutcomeSpec", () => {
  test("accepts a criterion with a command check", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "GET /health returns 200", check: { kind: "command", command: "npm test" } },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.criteria[0]?.id, "c1");
  });

  test("accepts a criterion checked by a judge, which is how non-code work closes", () => {
    const result = writeOutcomeSpec([
      {
        id: "c1",
        statement: "Every June Xero invoice is matched to a Ramp transaction",
        check: { kind: "judge", rubric: "counts equal, no orphans on either side" },
      },
    ]);

    assert.equal(result.ok, true);
  });

  test("rejects a criterion carrying no check at all", () => {
    const result = writeOutcomeSpec([{ id: "c1", statement: "the checkout flow is less janky" }]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.rejected[0]?.criterion.includes("janky"));
    assert.ok(!result.ok && /check/.test(result.rejected[0]?.reason ?? ""));
  });

  // The vague-criterion case, in the only form code can decide: a check that will
  // never produce an answer.
  test("rejects a check of kind none", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "the code feels cleaner", check: { kind: "none", reason: "subjective" } },
    ]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && /never be evaluated/.test(result.rejected[0]?.reason ?? ""));
  });

  test("rejects an empty spec, which would finish the moment it started", () => {
    const result = writeOutcomeSpec([]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && /nothing to verify/.test(result.rejected[0]?.reason ?? ""));
  });

  test("rejects duplicate ids, which would make satisfies ambiguous", () => {
    const check = { kind: "command", command: "npm test" };
    const result = writeOutcomeSpec([
      { id: "c1", statement: "one", check },
      { id: "c1", statement: "two", check },
    ]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.rejected[0]?.reason.includes("'c1'"));
  });

  test("reports every bad criterion at once, not just the first", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "no check here" },
      { id: "c2", statement: "nor here" },
    ]);

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.rejected.length, 2);
  });

  test("rejects the whole spec when one criterion is bad", () => {
    const result = writeOutcomeSpec([
      { id: "c1", statement: "fine", check: { kind: "command", command: "npm test" } },
      { id: "c2", statement: "not fine" },
    ]);

    assert.equal(result.ok, false);
  });
});

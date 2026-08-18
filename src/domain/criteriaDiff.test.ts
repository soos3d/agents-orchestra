// The failure mode under test: an approved criteria change that changes nothing.
//
// §3 freezes the criteria at sign-off, and `criteria_change_resolved` is the only
// event allowed to move them. That makes this function the entire mechanism by which
// an approved contract change reaches the ledger — a diff applied wrongly, or applied
// to the wrong criterion, is a mission judged against goalposts nobody approved.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyCriteriaDiff } from "./criteriaDiff.js";
import { aCriterion } from "../testing/fixtures.js";

const c1 = aCriterion({ id: "c1" });
const c2 = aCriterion({ id: "c2", statement: "the report names every unmatched invoice" });

describe("applyCriteriaDiff", () => {
  test("an empty diff leaves the criteria exactly as they were", () => {
    assert.deepEqual(applyCriteriaDiff([c1, c2], []), [c1, c2]);
  });

  test("an amend replaces the named criterion in place", () => {
    const to = aCriterion({ id: "c1", statement: "GET /health returns 200 within 500ms" });

    const applied = applyCriteriaDiff([c1, c2], [
      { op: "amend", criterionId: "c1", from: c1, to, reason: "the deadline was never stated" },
    ]);

    assert.deepEqual(applied, [to, c2]);
  });

  // `met` and `evidence` are check *results*, not the contract (§3, `revise.ts`), and
  // an amend that carried them over would resurrect a verdict against a statement
  // nobody has checked yet.
  test("an amended criterion arrives unchecked, whatever the old one recorded", () => {
    const met = { ...c1, met: true, lastCheckedRound: 3 };
    const to = aCriterion({ id: "c1", statement: "GET /health returns 200 and a build sha" });

    const applied = applyCriteriaDiff([met], [
      { op: "amend", criterionId: "c1", from: met, to, reason: "the sha was always required" },
    ]);

    assert.equal(applied[0]?.met, undefined);
    assert.equal(applied[0]?.lastCheckedRound, undefined);
  });

  test("a remove drops the named criterion and keeps the rest", () => {
    const applied = applyCriteriaDiff([c1, c2], [
      { op: "remove", criterionId: "c1", reason: "there is no health endpoint to check" },
    ]);

    assert.deepEqual(applied, [c2]);
  });

  test("an add appends the new criterion", () => {
    const c3 = aCriterion({ id: "c3", statement: "the summary is under 500 words" });

    assert.deepEqual(applyCriteriaDiff([c1], [{ op: "add", criterion: c3 }]), [c1, c3]);
  });

  test("several ops apply in order", () => {
    const to = aCriterion({ id: "c2", statement: "the report names every unmatched invoice, with a reason" });
    const c3 = aCriterion({ id: "c3", statement: "the summary is under 500 words" });

    const applied = applyCriteriaDiff([c1, c2], [
      { op: "remove", criterionId: "c1", reason: "out of scope" },
      { op: "amend", criterionId: "c2", from: c2, to, reason: "a reason was always meant" },
      { op: "add", criterion: c3 },
    ]);

    assert.deepEqual(applied.map((c) => c.id), ["c2", "c3"]);
    assert.equal(applied[0]?.statement, to.statement);
  });

  // A diff naming a criterion that is not there is a diff written against a ledger
  // that has moved on. Silently doing nothing would report an approved change as
  // applied, which is the one thing this must never do.
  test("an op naming a criterion nobody has raises rather than doing nothing", () => {
    assert.throws(
      () => applyCriteriaDiff([c1], [{ op: "remove", criterionId: "c9", reason: "gone" }]),
      /c9/,
    );
    assert.throws(
      () =>
        applyCriteriaDiff([c1], [
          { op: "amend", criterionId: "c9", from: c1, to: c1, reason: "gone" },
        ]),
      /c9/,
    );
  });

  test("an add reusing an existing id raises rather than shadowing it", () => {
    assert.throws(() => applyCriteriaDiff([c1], [{ op: "add", criterion: c1 }]), /c1/);
  });
});

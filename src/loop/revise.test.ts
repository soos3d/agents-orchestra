// The adversarial case, and the reason this module exists: a replan that cannot meet
// a criterion tries to relax it, and must fail to. Everything else in the loop would
// agree the mission succeeded.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyLedger, type Criterion, type DeadEnd, type TaskLedger } from "../domain/ledger.js";
import { aCriterion, aMission } from "../testing/fixtures.js";
import { reviseLedger } from "./revise.js";

const SIGNED_OFF = "2026-07-25T10:05:00.000Z";

const aDeadEnd = (id: string): DeadEnd => ({
  id,
  text: `approach ${id} failed`,
  addedRound: 1,
  approach: `approach ${id}`,
  evidence: "the API returned 403 on every call",
  source: "worker",
});

const ledgerWith = (patch: Partial<TaskLedger> = {}): TaskLedger => ({
  ...emptyLedger(),
  criteria: [aCriterion()],
  ...patch,
});

const signedOff = (ledger: TaskLedger) =>
  aMission({ ledger, signedOffAt: SIGNED_OFF });

describe("reviseLedger", () => {
  test("revises the plan freely — that is what replanning is for", () => {
    const mission = signedOff(ledgerWith());
    const proposed = ledgerWith({
      plan: [
        {
          id: "t1",
          goal: "try the CSV export instead",
          worker: "code",
          satisfies: ["c1"],
          motivatedBy: [],
          dependsOn: [],
          estimatedWallMs: 60_000,
        },
      ],
    });

    const result = reviseLedger(mission, proposed, "the API approach failed");

    assert.equal(result.kind, "revised");
    assert.equal(result.kind === "revised" && result.ledger.plan.length, 1);
  });

  describe("after sign-off, the criteria are frozen", () => {
    test("refuses an amended statement and asks instead", () => {
      const mission = signedOff(ledgerWith());
      const relaxed: Criterion = aCriterion({ statement: "GET /health returns anything at all" });

      const result = reviseLedger(mission, ledgerWith({ criteria: [relaxed] }), "cannot meet it");

      assert.equal(result.kind, "criteria_change");
      assert.equal(result.kind === "criteria_change" && result.diff[0]?.op, "amend");
    });

    test("carries the old criterion in the diff, so sign-off renders it from the event", () => {
      const mission = signedOff(ledgerWith());
      const relaxed = aCriterion({ check: { kind: "judge", rubric: "looks about right" } });

      const result = reviseLedger(mission, ledgerWith({ criteria: [relaxed] }), "tests are slow");

      assert.equal(result.kind, "criteria_change");
      const diff = result.kind === "criteria_change" ? result.diff[0] : undefined;
      assert.equal(diff?.op === "amend" && diff.from.check.kind, "command");
      assert.equal(diff?.op === "amend" && diff.to.check.kind, "judge");
    });

    test("refuses a dropped criterion", () => {
      const mission = signedOff(ledgerWith());

      const result = reviseLedger(mission, ledgerWith({ criteria: [] }), "unreachable");

      assert.equal(result.kind, "criteria_change");
      assert.equal(result.kind === "criteria_change" && result.diff[0]?.op, "remove");
    });

    test("refuses a criterion the replan invented", () => {
      const mission = signedOff(ledgerWith());
      const extra = aCriterion({ id: "c2", statement: "and a metrics endpoint" });

      const result = reviseLedger(mission, ledgerWith({ criteria: [aCriterion(), extra] }), "scope");

      assert.equal(result.kind, "criteria_change");
      assert.equal(result.kind === "criteria_change" && result.diff[0]?.op, "add");
    });

    // `met` and `evidence` are what the checks write. Freezing those would freeze the
    // mission's ability to record that it passed.
    test("lets a check result through, because that is not the contract changing", () => {
      const mission = signedOff(ledgerWith());
      const checked = aCriterion({
        met: true,
        evidence: { artifactIds: ["a1"], checkOutput: "exit 0", reasoning: "tests pass", byTask: ["t1"] },
        lastCheckedRound: 3,
      });

      const result = reviseLedger(mission, ledgerWith({ criteria: [checked] }), "round 3");

      assert.equal(result.kind, "revised");
    });
  });

  test("before sign-off, criteria are ordinary mutable state", () => {
    const mission = aMission({ ledger: ledgerWith(), signedOffAt: undefined });
    const revised = aCriterion({ statement: "GET /health returns 200 and a version" });

    const result = reviseLedger(mission, ledgerWith({ criteria: [revised] }), "revise");

    assert.equal(result.kind, "revised");
    assert.equal(
      result.kind === "revised" && result.ledger.criteria[0]?.statement,
      "GET /health returns 200 and a version",
    );
  });

  describe("append-only fields", () => {
    // A replan that can forget a dead end is a retry wearing a costume.
    test("puts back a dead end the proposal dropped, and says it did", () => {
      const mission = signedOff(ledgerWith({ deadEnds: [aDeadEnd("d1")] }));

      const result = reviseLedger(mission, ledgerWith({ deadEnds: [aDeadEnd("d2")] }), "replan");

      assert.equal(result.kind, "revised");
      assert.deepEqual(
        result.kind === "revised" && result.ledger.deadEnds.map((entry) => entry.id),
        ["d1", "d2"],
      );
      assert.deepEqual(result.kind === "revised" && result.restored, ["d1"]);
    });

    test("keeps everything the human stated", () => {
      const given = { id: "f1", text: "June means the calendar month", addedRound: 0 };
      const mission = signedOff(ledgerWith({ factsGiven: [given] }));

      const result = reviseLedger(mission, ledgerWith({ factsGiven: [] }), "replan");

      assert.deepEqual(result.kind === "revised" && result.ledger.factsGiven, [given]);
      assert.deepEqual(result.kind === "revised" && result.restored, ["f1"]);
    });

    test("says nothing was restored when the proposal kept everything", () => {
      const mission = signedOff(ledgerWith({ deadEnds: [aDeadEnd("d1")] }));

      const result = reviseLedger(mission, ledgerWith({ deadEnds: [aDeadEnd("d1")] }), "replan");

      assert.deepEqual(result.kind === "revised" && result.restored, []);
    });
  });
});

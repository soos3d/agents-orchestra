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

// PLAN-NEXT 6.3's "opt-in per mission, never default", as a property of the code. A
// deepsec scan is an AI agent with shell access and hundreds of dollars of billing on a
// large repository, so the criterion that names one is refused before anything runs
// unless a human granted it and the machine answered for it.
describe("writeOutcomeSpec and specialist scanners", () => {
  const scanned = {
    id: "c1",
    statement: "the changed files carry no high-severity vulnerability",
    check: { kind: "scanner", scanner: "deepsec" },
  };

  test("refuses a scanner nobody granted, which is every mission by default", () => {
    const result = writeOutcomeSpec([scanned]);

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.rejected[0]!.reason : "", /no scanner is available/);
    // Every message in this file names the fix.
    assert.match(!result.ok ? result.rejected[0]!.reason : "", /command to run or a rubric/);
  });

  test("accepts it when the mission was granted that scanner", () => {
    const result = writeOutcomeSpec([scanned], ["deepsec"]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.criteria[0]!.check.kind, "scanner");
  });

  test("a granted scanner does not grant a different one", () => {
    const result = writeOutcomeSpec([scanned], ["something-else"]);

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.rejected[0]!.reason : "", /only something-else is available/);
  });

  // The threshold is the criterion's to set and the schema's to constrain — an invented
  // rung would be a filter that matches nothing.
  test("an invented severity is refused by the schema", () => {
    const result = writeOutcomeSpec(
      [{ ...scanned, check: { kind: "scanner", scanner: "deepsec", minSeverity: "SPICY" } }],
      ["deepsec"],
    );

    assert.equal(result.ok, false);
  });
});

// PLAN-NEXT 7.2's validation half. Mock-first is a prompt convention and needs no new
// machinery — but a convention whose output this gate refused would be a rule the system
// teaches and then punishes, which is the P2 collision (defects 27, 41, 43) in its fourth
// shape. This pins that a mocked build is judgeable exactly like anything else: the
// criterion carries a check that runs, so it is accepted, and being *about* mocks is not
// something this gate has an opinion on.
describe("a mock-first criterion", () => {
  test("is accepted when it carries a command that runs against the fake", () => {
    const result = writeOutcomeSpec([
      {
        id: "mocked",
        statement: "The payment client runs green against the in-repo fake",
        check: { kind: "command", command: "node --test test/payments.test.js" },
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.criteria[0]!.statement.includes("fake"), true);
  });

  test("is accepted when a judge grades the mocked build's artifacts", () => {
    const result = writeOutcomeSpec([
      {
        id: "mocked-judge",
        statement: "Every external dependency is behind an interface with a mock",
        check: {
          kind: "judge",
          rubric: "src/payments/ defines an interface and a fake implementing it",
        },
      },
    ]);

    assert.equal(result.ok, true);
  });

  // The other half of the pair, and the one that keeps the convention honest: naming
  // mocks does not buy a criterion out of carrying a check.
  test("is refused like any other when it has no check", () => {
    const result = writeOutcomeSpec([
      {
        id: "mocked-none",
        statement: "Runs against mocks",
        check: { kind: "none", reason: "we will look at it" },
      },
    ]);

    assert.equal(result.ok, false);
  });
});

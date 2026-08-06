// Approve-or-revise is not a decision without a number, and the number that would be
// wrong is the sum of every task's budget: a plan that fans out does not take as long
// as its parts added together.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type PlannedTask } from "../domain/ledger.js";
import { estimatePlan } from "./estimate.js";

const task = (
  id: string,
  dependsOn: string[] = [],
  patch: Partial<PlannedTask> = {},
): PlannedTask => ({
  id,
  goal: `do ${id}`,
  worker: "code",
  satisfies: ["c1"],
  motivatedBy: [],
  dependsOn,
  estimatedWallMs: 60_000,
  ...patch,
});

describe("estimatePlan", () => {
  test("counts the tasks", () => {
    const estimate = estimatePlan({ plan: [task("t1"), task("t2")], criteriaCount: 1 });

    assert.equal(estimate.taskCount, 2);
  });

  test("takes the critical path, not the sum, when tasks fan out", () => {
    const plan = [task("t1"), task("t2"), task("t3")];

    assert.equal(estimatePlan({ plan, criteriaCount: 1 }).wallMs, 60_000);
  });

  test("adds up a chain", () => {
    const plan = [task("t1"), task("t2", ["t1"]), task("t3", ["t2"])];

    assert.equal(estimatePlan({ plan, criteriaCount: 1 }).wallMs, 180_000);
  });

  test("takes the longest branch when two chains converge", () => {
    const plan = [
      task("t1", [], { estimatedWallMs: 10_000 }),
      task("t2", [], { estimatedWallMs: 90_000 }),
      task("t3", ["t1", "t2"], { estimatedWallMs: 5_000 }),
    ];

    assert.equal(estimatePlan({ plan, criteriaCount: 1 }).wallMs, 95_000);
  });

  test("an empty plan costs no wall-clock", () => {
    assert.equal(estimatePlan({ plan: [], criteriaCount: 0 }).wallMs, 0);
  });

  // The measured portion (§9.5): the loop's own calls are what a mission is billed
  // for, so an estimate that omits them is worse than no estimate.
  test("counts the in-process decision points, and they grow with the plan", () => {
    const one = estimatePlan({ plan: [task("t1")], criteriaCount: 1 });
    const two = estimatePlan({ plan: [task("t1"), task("t2")], criteriaCount: 1 });

    assert.ok(one.tokens > 0);
    assert.ok(two.tokens > one.tokens, `${two.tokens} should exceed ${one.tokens}`);
  });

  test("each criterion adds a judge call", () => {
    const plan = [task("t1")];
    const one = estimatePlan({ plan, criteriaCount: 1 });
    const three = estimatePlan({ plan, criteriaCount: 3 });

    assert.ok(three.tokens > one.tokens);
  });

  test("expects one gate per computer task and none for code", () => {
    const plan = [task("t1"), task("t2", [], { worker: "computer" })];

    assert.equal(estimatePlan({ plan, criteriaCount: 1 }).expectedGates, 1);
  });

  // validatePlan rejects a cycle before this runs; this is what stops a bug there
  // from becoming a hang here.
  test("terminates on a cycle rather than recursing forever", () => {
    const plan = [task("t1", ["t2"]), task("t2", ["t1"])];

    assert.ok(estimatePlan({ plan, criteriaCount: 1 }).wallMs >= 0);
  });
});

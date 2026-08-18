// A plan that cannot be scheduled produces a mission that runs to its reset cap
// having dispatched nothing — every round finds an empty ready set and every replan
// re-proposes the same unschedulable graph. So the graph is checked before a single
// agent is synthesized, and the message names the edge the planner has to fix.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Criterion, type PlannedTask } from "../domain/ledger.js";
import { validatePlan } from "./validate.js";

const task = (id: string, dependsOn: string[] = []): PlannedTask => ({
  id,
  goal: `do ${id}`,
  worker: "code",
  satisfies: ["c1"],
  motivatedBy: [],
  dependsOn,
  estimatedWallMs: 60_000,
});

describe("validatePlan", () => {
  test("accepts a DAG and returns a runnable order", () => {
    const result = validatePlan([task("t3", ["t1", "t2"]), task("t1"), task("t2", ["t1"])]);

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.order.indexOf("t1") < result.order.indexOf("t2"));
    assert.ok(result.ok && result.order.indexOf("t2") < result.order.indexOf("t3"));
  });

  test("accepts an empty plan", () => {
    assert.equal(validatePlan([]).ok, true);
  });

  // Walked in dependency direction: t1 depends on t3 depends on t2 depends on t1.
  test("rejects a cycle and names the edges in it", () => {
    const result = validatePlan([task("t1", ["t3"]), task("t2", ["t1"]), task("t3", ["t2"])]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.message.includes("t1 → t3 → t2 → t1"));
  });

  test("rejects a task that depends on itself", () => {
    const result = validatePlan([task("t1", ["t1"])]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.message.includes("t1 → t1"));
  });

  // The planner gets one structured-return retry, and it can only use it if the
  // rejection says which edge was wrong.
  test("rejects an edge naming a task that is not in the plan", () => {
    const result = validatePlan([task("t1"), task("t2", ["t9"])]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.message.includes("t2"));
    assert.ok(!result.ok && result.message.includes("t9"));
  });

  test("rejects duplicate ids, which would make dependsOn ambiguous", () => {
    const result = validatePlan([task("t1"), task("t1")]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.message.includes("t1"));
  });

  // Defect 32's other half. A criterion's check fires when the last task listing it
  // lands (§4), so a plan that lists it nowhere is a criterion that can never be
  // checked and a mission that can never legitimately complete. The real mission that
  // found this replanned itself into exactly that shape and then spun to its cap.
  describe("criteria coverage", () => {
    const criterion = (id: string, patch: Partial<Criterion> = {}): Criterion => ({
      id,
      statement: `${id} holds`,
      check: { kind: "command", command: "npm test" },
      ...patch,
    });

    const satisfying = (id: string, satisfies: string[]): PlannedTask => ({
      ...task(id),
      satisfies,
    });

    test("accepts a plan whose tasks cover every criterion", () => {
      const result = validatePlan(
        [satisfying("t1", ["c1"]), satisfying("t2", ["c2"])],
        [criterion("c1"), criterion("c2")],
      );

      assert.equal(result.ok, true);
    });

    test("rejects a plan that leaves a criterion with no task, naming it", () => {
      const result = validatePlan(
        [satisfying("t1", ["c1"])],
        [criterion("c1"), criterion("c2"), criterion("c3")],
      );

      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.message.includes("c2"));
      assert.ok(!result.ok && result.message.includes("c3"));
      assert.ok(!result.ok && !result.message.includes("c1"));
    });

    // A criterion already shown met needs no further work planned against it, and
    // demanding one would make every replan re-propose work that is already done.
    test("a criterion already met needs no task", () => {
      const result = validatePlan(
        [satisfying("t1", ["c1"])],
        [criterion("c1"), criterion("c2", { met: true })],
      );

      assert.equal(result.ok, true);
    });

    test("checks nothing when no criteria are supplied", () => {
      assert.equal(validatePlan([satisfying("t1", [])]).ok, true);
    });
  });
});

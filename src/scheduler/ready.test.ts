// The failures this guards: two browser sessions in the same account submitting the
// same form, two overlapping code tasks dispatched in one batch because neither had
// a lease yet, a dependency wait that never ends, and a cycle that reads as a stall.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Task } from "../domain/task.js";
import { aCodeTask, aMissionState } from "../testing/fixtures.js";
import { promotable, readyTasks, standstill, unreachable } from "./ready.js";

const plain = (id: string, patch: Partial<Task> = {}): Task =>
  ({
    ...aCodeTask({ id, ...patch }),
    worker: "research",
    branch: undefined,
    owns: undefined,
  }) as unknown as Task;

const ids = (tasks: readonly Task[]) => tasks.map((task) => task.id);

describe("readyTasks", () => {
  test("dispatches a todo task with no dependencies", () => {
    const state = aMissionState({ tasks: [aCodeTask({ id: "t1" })] });

    assert.deepEqual(ids(readyTasks(state)), ["t1"]);
  });

  test("holds a task back until every dependency is done", () => {
    const blockedByT1 = aCodeTask({
      id: "t2",
      status: "todo",
      dependsOn: ["t1"],
      branch: "feat/two",
      owns: ["src/two.ts"],
    });

    const running = aMissionState({
      tasks: [aCodeTask({ id: "t1", status: "running" }), blockedByT1],
    });
    assert.deepEqual(ids(readyTasks(running)), []);

    const done = aMissionState({
      tasks: [aCodeTask({ id: "t1", status: "done" }), blockedByT1],
    });
    assert.deepEqual(ids(readyTasks(done)), ["t2"]);
  });

  test("skips anything that is not todo", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "waiting" }),
        aCodeTask({ id: "t2", status: "blocked" }),
        aCodeTask({ id: "t3", status: "done" }),
        aCodeTask({ id: "t4", status: "failed" }),
      ],
    });

    assert.deepEqual(ids(readyTasks(state)), []);
  });

  test("caps each kind separately, so research does not starve behind code", () => {
    const state = aMissionState({
      tasks: [
        ...[1, 2, 3, 4, 5].map((n) =>
          aCodeTask({ id: `c${n}`, branch: `feat/${n}`, owns: [`src/${n}.ts`] }),
        ),
        plain("r1"),
      ],
    });

    assert.deepEqual(ids(readyTasks(state)), ["c1", "c2", "c3", "c4", "r1"]);
  });

  test("a task still verifying holds its slot", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "c1", status: "verifying" }),
        aCodeTask({ id: "c2", branch: "feat/2", owns: ["src/2.ts"] }),
      ],
    });

    assert.deepEqual(ids(readyTasks(state)), ["c2"]);
  });

  describe("leases", () => {
    test("refuses a task overlapping a lease already held", () => {
      const state = aMissionState({
        tasks: [aCodeTask({ id: "t2", owns: ["src/routes/**"], branch: "fix/router" })],
        leases: { t1: ["src/routes/health.ts"] },
      });

      assert.deepEqual(ids(readyTasks(state)), []);
    });

    // The one an in-flight-only check misses: neither task holds a lease yet, so
    // both look grantable until the batch is built with the other one in it.
    test("refuses two overlapping tasks in the same batch", () => {
      const state = aMissionState({
        tasks: [
          aCodeTask({ id: "t1", owns: ["src/routes/health.ts"], branch: "feat/health" }),
          aCodeTask({ id: "t2", owns: ["src/routes/**"], branch: "fix/router" }),
        ],
      });

      assert.deepEqual(ids(readyTasks(state)), ["t1"]);
    });

    test("sibling directories sharing a prefix do not overlap", () => {
      const state = aMissionState({
        tasks: [
          aCodeTask({ id: "t1", owns: ["src/routes/**"], branch: "feat/routes" }),
          aCodeTask({ id: "t2", owns: ["src/routers/**"], branch: "feat/routers" }),
        ],
      });

      assert.deepEqual(ids(readyTasks(state)), ["t1", "t2"]);
    });
  });
});

describe("promotable", () => {
  test("promotes a waiting task the moment its last dependency lands", () => {
    const waiting = aCodeTask({ id: "t3", status: "waiting", dependsOn: ["t1", "t2"] });

    const partial = aMissionState({
      tasks: [aCodeTask({ id: "t1", status: "done" }), aCodeTask({ id: "t2" }), waiting],
    });
    assert.deepEqual(ids(promotable(partial)), []);

    const complete = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "done" }),
        aCodeTask({ id: "t2", status: "done" }),
        waiting,
      ],
    });
    assert.deepEqual(ids(promotable(complete)), ["t3"]);
  });

  test("never promotes behind a failure", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "failed" }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
      ],
    });

    assert.deepEqual(ids(promotable(state)), []);
  });
});

describe("unreachable", () => {
  test("names the frontier stranded behind a failure, transitively", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "failed" }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
        aCodeTask({ id: "t3", status: "waiting", dependsOn: ["t2"] }),
        aCodeTask({ id: "t4", status: "todo" }),
      ],
    });

    assert.deepEqual(ids(unreachable(state)).sort(), ["t2", "t3"]);
  });

  test("a cancelled dependency strands its dependents the same way", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "cancelled" }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
      ],
    });

    assert.deepEqual(ids(unreachable(state)), ["t2"]);
  });
});

describe("standstill", () => {
  test("is moving while anything is dispatchable", () => {
    const state = aMissionState({ tasks: [aCodeTask({ id: "t1" })] });

    assert.equal(standstill(state).kind, "moving");
  });

  test("is moving while a computer task runs even though nothing else can start", () => {
    const browser = (id: string, status: Task["status"]): Task =>
      ({
        ...aCodeTask({ id, status }),
        worker: "computer",
        surface: "browser",
        allowedDomains: [],
        branch: undefined,
        owns: undefined,
      }) as unknown as Task;

    const state = aMissionState({ tasks: [browser("t1", "running"), browser("t2", "todo")] });

    assert.equal(standstill(state).kind, "moving");
  });

  // A dependency landing is the most common thing that happens in a round, and the
  // dependent is still `waiting` until the next round promotes it. Reading that as a
  // deadlock reports a cycle nearly every round.
  test("is moving when a waiting task's last dependency just landed", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "done" }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
      ],
    });

    assert.equal(standstill(state).kind, "moving");
  });

  test("settles when every task is terminal", () => {
    const state = aMissionState({
      tasks: [aCodeTask({ id: "t1", status: "done" }), aCodeTask({ id: "t2", status: "failed" })],
    });

    assert.equal(standstill(state).kind, "settled");
  });

  test("parks in blocked when a task is waiting on a person", () => {
    const state = aMissionState({
      tasks: [aCodeTask({ id: "t1", status: "blocked" }), aCodeTask({ id: "t2", status: "done" })],
    });
    const result = standstill(state);

    assert.equal(result.kind, "blocked");
    assert.deepEqual(result.kind === "blocked" && result.taskIds, ["t1"]);
  });

  // The scheduler never cancels these — the replan decides.
  test("reports an unreachable frontier rather than a cycle", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "failed" }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
      ],
    });
    const result = standstill(state);

    assert.equal(result.kind, "frontier");
    assert.deepEqual(result.kind === "frontier" && result.taskIds, ["t2"]);
  });

  // Corruption, not a stall: it raises rather than spinning to the reset cap.
  test("reports a cycle when tasks only wait on each other", () => {
    const state = aMissionState({
      tasks: [
        aCodeTask({ id: "t1", status: "waiting", dependsOn: ["t2"] }),
        aCodeTask({ id: "t2", status: "waiting", dependsOn: ["t1"] }),
      ],
    });
    const result = standstill(state);

    assert.equal(result.kind, "cycle");
    assert.match(result.kind === "cycle" ? result.message : "", /escaped validation/);
  });
});

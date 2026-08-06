// §9.2. The rule that matters most here is the one for `computer` tasks: a worker
// that died mid-flight may already have submitted the form, so it is never
// auto-retried whatever else is true.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold } from "../events/fold.js";
import { liveWorktrees, reconcileOrphans } from "./resume.js";
import { aCodeTask, missionCreated, stamp } from "../testing/fixtures.js";
import { type EventInput } from "../events/schema.js";
import { type Task } from "../domain/task.js";

const orchestrator = { missionId: "m1", actor: "orchestrator" } as const;

const aComputerTask = (patch: Partial<Task> = {}): Task =>
  ({
    ...aCodeTask(),
    id: "t9",
    worker: "computer",
    surface: "browser",
    allowedDomains: ["xero.com"],
    branch: undefined,
    owns: undefined,
    ...patch,
  }) as Task;

function stateWith(tasks: Task[], statuses: Record<string, Task["status"]>) {
  const events: EventInput[] = [
    missionCreated(),
    ...tasks.map((task): EventInput => ({ ...orchestrator, type: "task_planned", task })),
    ...tasks
      .filter((task) => statuses[task.id])
      .map(
        (task): EventInput => ({
          ...orchestrator,
          taskId: task.id,
          type: "task_status",
          from: "todo",
          to: statuses[task.id],
          reason: "dispatched",
        }),
      ),
  ];
  return fold(stamp(events));
}

const noCommits = { hasCommits: async () => false };
const withCommits = { hasCommits: async () => true };

describe("reconcileOrphans", () => {
  test("leaves a mission with nothing in flight alone", async () => {
    const state = stateWith([aCodeTask()], { t1: "done" });

    const { decisions } = await reconcileOrphans(state, noCommits);

    assert.deepEqual(decisions, []);
  });

  test("requeues a code task whose worktree is clean, spending an attempt", async () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/wt" })], { t1: "running" });

    const [decision] = (await reconcileOrphans(state, noCommits)).decisions;

    assert.equal(decision.to, "todo");
    assert.equal(decision.countsAsAttempt, true);
  });

  // Work is not thrown away: a worktree with commits goes to verification instead of
  // being redone from scratch.
  test("sends a code task with commits to verification instead of discarding it", async () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/wt" })], { t1: "running" });

    const [decision] = (await reconcileOrphans(state, withCommits)).decisions;

    assert.equal(decision.to, "verifying");
    assert.equal(decision.countsAsAttempt, false);
    assert.match(decision.action, /re-running verification/);
  });

  test("requeues a research task, which is cheap to redo", async () => {
    const research = { ...aCodeTask(), id: "t2", worker: "research" } as unknown as Task;
    const state = stateWith([research], { t2: "running" });

    const [decision] = (await reconcileOrphans(state, noCommits)).decisions;

    assert.equal(decision.to, "todo");
  });

  // The rule that exists because a side effect may already have landed.
  test("blocks a computer task rather than auto-retrying it", async () => {
    const state = stateWith([aComputerTask()], { t9: "running" });

    const [decision] = (await reconcileOrphans(state, withCommits)).decisions;

    assert.equal(decision.to, "blocked");
    assert.equal(decision.countsAsAttempt, false);
    assert.match(decision.action, /a human must confirm/);
  });

  test("treats a task orphaned mid-verification as an orphan too", async () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/wt" })], { t1: "verifying" });

    assert.equal((await reconcileOrphans(state, noCommits)).decisions.length, 1);
  });

  test("emits a resumed event naming every orphan, then one status event each", async () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/wt" }), aComputerTask()], {
      t1: "running",
      t9: "running",
    });

    const { events } = await reconcileOrphans(state, noCommits);

    assert.equal(events[0].type, "resumed");
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.slice(1).map((e) => e.taskId),
      ["t1", "t9"],
    );
  });

  // Resuming into a fresh ledger would re-walk every dead end. The events are
  // returned rather than written so nothing lands until the whole set exists.
  test("returns events without writing them", async () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/wt" })], { t1: "running" });

    const { events } = await reconcileOrphans(state, noCommits);

    assert.ok(events.every((event) => !("seq" in event)));
  });
});

describe("liveWorktrees", () => {
  test("keeps a worktree whose task is still in play", () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/live" })], { t1: "running" });

    assert.deepEqual(liveWorktrees(state), ["/tmp/live"]);
  });

  test("releases a worktree once its task is done", () => {
    const state = stateWith([aCodeTask({ worktree: "/tmp/done" })], { t1: "done" });

    assert.deepEqual(liveWorktrees(state), []);
  });

  test("ignores tasks that never had a worktree", () => {
    const state = stateWith([aComputerTask()], { t9: "running" });

    assert.deepEqual(liveWorktrees(state), []);
  });
});

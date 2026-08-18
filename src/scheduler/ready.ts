// The ready-set rule (§3), and the two standstills that mean different things.
//
// This is the code half of the inner loop: pure, deterministic, and it never calls a
// model. `dependsOn` and `nextTasks` implied a scheduler and nothing owned one, which
// left two decisions unmade — when a dependency wait ends, and what happens when the
// board stops moving.
//
// One rule it deliberately does not have: the scheduler never cancels work the
// planner created. A task whose dependency failed stays `waiting` and surfaces as an
// unreachable frontier; cancelling that branch is a planning decision.
import { isCodeTask, isTerminal, type Task, type TaskRef, type WorkerKind } from "../domain/task.js";
import { type MissionState } from "../events/fold.js";
import { requestLease, type Lease } from "./leases.js";

/** Per worker kind, not one global number. */
export const CONCURRENCY: Record<WorkerKind, number> = {
  code: 4,
  research: 4,
  review: 4,
  general: 4,
  computer: 4,
};

/** A slot is occupied from dispatch until the task leaves verification: a code task
 *  running its test suite is still holding the worktree and the CPU. */
const IN_FLIGHT = ["running", "verifying"] as const;

const occupies = (task: Task): boolean =>
  (IN_FLIGHT as readonly string[]).includes(task.status);

const leaseOf = (task: Task): string[] => (isCodeTask(task) ? task.owns : []);

/**
 * Tasks whose dependencies have all landed, so the scheduler may move them from
 * `waiting` to `todo`. Nobody is told: a dependency wait is not an inbox item, which
 * is the whole reason `waiting` is a separate status from `blocked` (§4).
 */
export function promotable(state: MissionState): Task[] {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  return state.tasks.filter(
    (task) =>
      task.status === "waiting" &&
      task.dependsOn.every((id) => byId.get(id)?.status === "done"),
  );
}

/**
 * The dispatch set for this round.
 *
 * Leases accumulate as the batch is built, not only against what is already in
 * flight: two overlapping code tasks that are both `todo` would otherwise be
 * dispatched together, which is the exact collision §8 exists to prevent.
 */
export function readyTasks(state: MissionState): Task[] {
  const limits = CONCURRENCY;
  const byId = new Map(state.tasks.map((task) => [task.id, task]));

  const slots: Record<string, number> = {};
  for (const task of state.tasks) {
    if (occupies(task)) slots[task.worker] = (slots[task.worker] ?? 0) + 1;
  }

  const held: Lease[] = Object.entries(state.leases).map(([taskId, owns]) => ({ taskId, owns }));
  const chosen: Task[] = [];

  for (const task of state.tasks) {
    if (task.status !== "todo") continue;
    if (!task.dependsOn.every((id) => byId.get(id)?.status === "done")) continue;
    if ((slots[task.worker] ?? 0) >= limits[task.worker]) continue;

    const owns = leaseOf(task);
    if (owns.length > 0 && !requestLease(held, task.id, owns).granted) continue;

    slots[task.worker] = (slots[task.worker] ?? 0) + 1;
    if (owns.length > 0) held.push({ taskId: task.id, owns });
    chosen.push(task);
  }

  return chosen;
}

export type Standstill =
  /** Something is in flight or dispatchable. The loop keeps going. */
  | { kind: "moving" }
  /** Every task reached a terminal status. */
  | { kind: "settled" }
  /** Nothing runs and a human has to answer — the §3 definition of mission `blocked`. */
  | { kind: "blocked"; taskIds: TaskRef[] }
  /** Nothing runs and the frontier is unreachable behind a failure. The replan
   *  decides what to do with it; the scheduler does not cancel it. */
  | { kind: "frontier"; taskIds: TaskRef[] }
  /** Nothing runs, nothing is blocked, and tasks still wait on each other. That is a
   *  cycle that escaped plan-time validation — corruption, and it raises. */
  | { kind: "cycle"; taskIds: TaskRef[]; message: string };

/**
 * Why the board stopped. Two terminal shapes look identical from a distance and are
 * completely different: a mission waiting on a person is resting, and a mission
 * waiting on itself is broken.
 */
export function standstill(state: MissionState): Standstill {
  if (state.tasks.some(occupies)) return { kind: "moving" };
  if (readyTasks(state).length > 0) return { kind: "moving" };
  // A task whose last dependency landed this round is still `waiting` until the next
  // round promotes it. Counting that as a standstill reports a cycle every time a
  // dependency chain advances — which is most rounds.
  if (promotable(state).length > 0) return { kind: "moving" };

  const blocked = state.tasks.filter((task) => task.status === "blocked");
  if (blocked.length > 0) return { kind: "blocked", taskIds: blocked.map((task) => task.id) };

  const waiting = state.tasks.filter((task) => task.status === "waiting" || task.status === "todo");
  if (waiting.length === 0) return { kind: "settled" };

  const stranded = unreachable(state).map((task) => task.id);
  const spinning = waiting.filter((task) => !stranded.includes(task.id));
  if (spinning.length === 0) return { kind: "frontier", taskIds: stranded };

  const ids = spinning.map((task) => task.id);
  return {
    kind: "cycle",
    taskIds: ids,
    message:
      `Tasks ${ids.join(", ")} are waiting on each other with nothing running and nothing ` +
      `blocked, so the plan contains a cycle that escaped validation. This is corruption ` +
      `rather than a stall — fix the plan validator rather than retrying the mission.`,
  };
}

/**
 * Tasks that can never become ready, because a dependency failed or was cancelled.
 * Transitive: a task waiting on an unreachable task is itself unreachable.
 *
 * The progress prompt shows these as the unreachable frontier, which is what turns
 * "nothing happened this round" into a named blocking task the replan can act on.
 */
export function unreachable(state: MissionState): Task[] {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const stranded = new Set<string>();

  const dead = (id: string): boolean => {
    const task = byId.get(id);
    // A dependency the plan never created cannot land either. Plan validation is
    // what normally catches this; here it is one more way forward is closed.
    if (!task) return true;
    return (isTerminal(task.status) && task.status !== "done") || stranded.has(task.id);
  };

  let grew = true;
  while (grew) {
    grew = false;
    for (const task of state.tasks) {
      if (stranded.has(task.id) || isTerminal(task.status)) continue;
      if (task.dependsOn.some(dead)) {
        stranded.add(task.id);
        grew = true;
      }
    }
  }

  return state.tasks.filter((task) => stranded.has(task.id));
}

// Resume (§9.2). A loop that runs for hours on a laptop will be interrupted.
//
// Replaying the log rebuilds state exactly; what replay cannot know is what happened
// to the processes. Any task left `running` or `verifying` is an orphan, and the
// right answer depends on the worker kind — which is the whole reason §9.2 is a
// table and not a rule.
import { isCodeTask, type Task, type TaskStatus } from "../domain/task.js";
import { type MissionState } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";

export interface OrphanDecision {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  /** Reason, written for a human reading `orchestra resume` output. */
  action: string;
  /** Whether the orphan costs the task one of its attempts. */
  countsAsAttempt: boolean;
}

/** Injected so reconciliation is testable without a git repo. */
export interface WorktreeProbe {
  hasCommits(task: Task): Promise<boolean>;
}

const ORPHAN_STATUSES: readonly TaskStatus[] = ["running", "verifying"];

async function decide(task: Task, probe: WorktreeProbe): Promise<OrphanDecision> {
  const base = { taskId: task.id, from: task.status };

  // Never auto-retried. A side effect on a real app may already have landed, and a
  // human confirms the state of the world before it runs again.
  if (task.worker === "computer") {
    return {
      ...base,
      to: "blocked",
      action: "computer task interrupted — a human must confirm what already happened",
      countsAsAttempt: false,
    };
  }

  if (isCodeTask(task) && task.worktree && (await probe.hasCommits(task))) {
    return {
      ...base,
      to: "verifying",
      action: "worktree has commits — re-running verification rather than discarding the work",
      countsAsAttempt: false,
    };
  }

  return {
    ...base,
    to: "todo",
    action: isCodeTask(task) ? "worktree is clean — requeued" : "cheap to redo — requeued",
    countsAsAttempt: true,
  };
}

export interface Reconciliation {
  decisions: OrphanDecision[];
  /** Events to append, in order. The caller writes them; this stays pure. */
  events: EventInput[];
}

/**
 * Work out what to do with every orphan, and produce the events that record it.
 *
 * Returns events rather than writing them, so the decision is testable on its own
 * and so nothing reaches disk until the caller has the whole set — a half-recorded
 * reconciliation is worse than none.
 */
export async function reconcileOrphans(
  state: MissionState,
  probe: WorktreeProbe,
): Promise<Reconciliation> {
  const orphans = state.tasks.filter((task) => ORPHAN_STATUSES.includes(task.status));
  const decisions = await Promise.all(orphans.map((task) => decide(task, probe)));

  const events: EventInput[] = [
    {
      type: "resumed",
      missionId: state.mission.id,
      actor: "runtime",
      fromSeq: state.lastSeq,
      orphans: decisions.map((d) => ({ taskId: d.taskId, action: d.action })),
    },
    ...decisions.map(
      (d): EventInput => ({
        type: "task_status",
        missionId: state.mission.id,
        taskId: d.taskId,
        actor: "runtime",
        from: d.from,
        to: d.to,
        reason: d.action,
      }),
    ),
  ];

  return { decisions, events };
}

/** Worktrees this mission still needs, so pruning does not delete live work (§9.3). */
export function liveWorktrees(state: MissionState): string[] {
  return state.tasks
    .filter((task) => isCodeTask(task) && task.worktree !== undefined)
    .filter((task) => task.status !== "done" && task.status !== "cancelled")
    .map((task) => (task as { worktree?: string }).worktree!)
    .filter(Boolean);
}

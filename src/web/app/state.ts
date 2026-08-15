// The page's own fold — the second reducer, contained.
//
// Ported from `web/page/projection.ts`, which carried this same switch as client
// JavaScript inside a TypeScript template literal. The behaviour is unchanged and the
// containment is unchanged. What changed is that the union it switches on is now the
// real one: `Event` is imported as a *type*, so the bundler erases it entirely and no
// zod reaches the browser, while `tsc` checks every `case` against the schema the
// server actually appends. A projection that reads a field an event does not carry
// used to be a blank panel found by a human; it is now a compile error.
//
// The containment rule is the one that matters and it did not move: the projection
// covers only what is *displayed*, and **no decision is taken from it**. The page
// sends intents and the loop decides, so a divergence here shows a stale screen and
// can never approve the wrong thing. Keep every `case` one-liner small — review is
// the only net under this file, exactly as it is under `agentCalls.ts`.
import { type Workspace, type WorkspaceProbe } from "../../config/workspaces.js";
import { type Event } from "../../events/schema.js";
import { type Artifact } from "../../domain/artifacts.js";
import {
  type Criterion,
  type CriterionDiff,
  type Guess,
  type PlannedTask,
  type TaskLedger,
} from "../../domain/ledger.js";
import { type Estimate } from "../../domain/mission.js";
import { type Task } from "../../domain/task.js";

/** An inbox card. `id` is present only where the card can be answered — a gate has
 *  no reply box here, and an intake question is answered on its own screen. */
export interface InboxItem {
  kind: "intake" | "question" | "gate" | "permission";
  text: string;
  id?: string;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  options?: readonly string[];
}

export interface PendingChange {
  diff: readonly CriterionDiff[];
  reasoning: string;
}

/** A mission in the serve-mode listing. */
export interface MissionSummary {
  id: string;
  goal: string;
  status: string;
}

/** A task as the board draws it: the record, plus when it started running, which is
 *  what the live timer counts from and is not a field of `Task`. */
export type BoardTask = Task & { startedAt?: string };

/** The workspace half of the view (UI plan U4). All four fields are the server's, so
 *  they survive a mission stream resetting — except `chosen`, which is this tab's own
 *  selection and is the workspace half of what `selected` is for tasks. */
export interface WorkspaceView {
  /** `null` on a per-run server, which has one directory and nothing to choose. */
  list: readonly Workspace[] | null;
  /** The directory the server last resolved, awaiting confirmation. */
  probe: WorkspaceProbe | null;
  /** workspace id → the mission holding it. The per-directory cap, as data. */
  live: Readonly<Record<string, string>>;
  /** Where serve was launched: what `compose` targets when it names no workspace. */
  defaultId: string | null;
  /** This tab's pick. Page state, never sent as anything but the id that was clicked. */
  chosen: string | null;
}

export interface View {
  /** `null` on a per-run server; a listing under `orchestra serve`. */
  missions: readonly MissionSummary[] | null;
  /** Which mission this tab is streaming, under serve. */
  watching: string | null;
  workspaces: WorkspaceView;

  goal: string;
  status: string;
  brief: string;
  outOfScope: readonly string[];
  criteria: readonly Criterion[];
  guesses: readonly Guess[];
  plan: readonly PlannedTask[];
  estimate: Estimate | null;
  round: number;
  stalls: number;
  resets: number;
  paused: boolean;
  inbox: ReadonlyMap<string, InboxItem>;
  questions: readonly IntakeQuestion[];
  pendingChange: PendingChange | null;
  tasks: ReadonlyMap<string, BoardTask>;
  artifacts: readonly { taskId?: string; artifact: Artifact }[];
  ledger: TaskLedger | null;
  selected: string | null;
}

/** Everything that belongs to one mission's stream.
 *
 *  Separate from the listing on purpose: a reconnect replays from seq 0, and applying
 *  a replay on top of a stale view would double every count. `missions` and
 *  `watching` survive that reset because they are the server's, not the mission's. */
export const emptyWorkspaces = (): WorkspaceView => ({
  list: null,
  probe: null,
  live: {},
  defaultId: null,
  chosen: null,
});

export const emptyMission = (): Omit<View, "missions" | "watching" | "workspaces"> => ({
  goal: "",
  status: "",
  brief: "",
  outOfScope: [],
  criteria: [],
  guesses: [],
  plan: [],
  estimate: null,
  round: 0,
  stalls: 0,
  resets: 0,
  paused: false,
  inbox: new Map(),
  questions: [],
  pendingChange: null,
  tasks: new Map(),
  artifacts: [],
  ledger: null,
  selected: null,
});

export const emptyView = (): View => ({
  missions: null,
  watching: null,
  workspaces: emptyWorkspaces(),
  ...emptyMission(),
});

/**
 * An approved change is the one thing that moves a signed-off criterion (§3), and the
 * criteria the page draws come from `outcome_spec_written`, which is never re-emitted
 * for one. So the display follows the diff — an ordinary projection update, taking no
 * decision: the server's fold is what the loop is judged against.
 */
function applyChange(criteria: readonly Criterion[], diff: readonly CriterionDiff[]): Criterion[] {
  return diff.reduce<Criterion[]>((all, op) => {
    if (op.op === "add") return all.concat([op.criterion]);
    if (op.op === "remove") return all.filter((criterion) => criterion.id !== op.criterionId);
    return all.map((criterion) => (criterion.id === op.criterionId ? op.to : criterion));
  }, [...criteria]);
}

const withEntry = <T>(map: ReadonlyMap<string, T>, key: string, value: T): Map<string, T> =>
  new Map(map).set(key, value);

const without = <T>(map: ReadonlyMap<string, T>, key: string): Map<string, T> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** One event onto the view. Returns a new view rather than mutating, so a render is
 *  a pure function of what came back and Preact can tell that something changed. */
export function apply(view: View, event: Event): View {
  switch (event.type) {
    case "mission_created":
      return { ...view, goal: event.goal };
    case "mission_status":
      return { ...view, status: event.to };
    case "round_started":
      return { ...view, round: event.round };
    case "stall_detected":
      return { ...view, stalls: event.stalls };
    case "replan_started":
      return { ...view, resets: event.resets, stalls: 0 };
    case "pause_requested":
      return { ...view, paused: true };
    case "pause_lifted":
      return { ...view, paused: false };
    case "research_completed":
      return { ...view, brief: event.brief };
    case "ledger_revised":
      return { ...view, ledger: event.ledger, plan: event.ledger.plan, guesses: event.ledger.guesses };
    case "outcome_spec_written":
      return {
        ...view,
        criteria: event.criteria,
        guesses: event.guesses,
        outOfScope: event.outOfScope,
        estimate: event.estimate,
      };
    // The mid-mission return (§3): the mission is back at `awaiting_signoff` and the
    // screen must show what a replan wants to change, not the plan it already
    // approved. The diff carries `from` as well as `to` (§4.0), so this needs no
    // ledger lookup — and the resolution only clears it, because the authoritative
    // criteria arrive as they always do, from the server's own fold.
    case "criteria_change_requested":
      return { ...view, pendingChange: { diff: event.diff, reasoning: event.reasoning } };
    case "criteria_change_resolved":
      return {
        ...view,
        criteria:
          event.approved && view.pendingChange
            ? applyChange(view.criteria, view.pendingChange.diff)
            : view.criteria,
        pendingChange: null,
      };
    case "criterion_checked":
      return {
        ...view,
        criteria: view.criteria.map((criterion) =>
          criterion.id === event.criterionId ? { ...criterion, met: event.met } : criterion,
        ),
      };
    case "task_planned":
    case "task_replanned":
      return { ...view, tasks: withEntry(view.tasks, event.task.id, event.task) };
    case "task_status": {
      const taskId = event.taskId;
      const task = taskId === undefined ? undefined : view.tasks.get(taskId);
      if (!task || taskId === undefined) return view;
      return {
        ...view,
        tasks: withEntry(view.tasks, taskId, {
          ...task,
          status: event.to,
          ...(event.to === "running" ? { startedAt: event.at } : {}),
        }),
      };
    }
    case "artifact_written":
      return {
        ...view,
        artifacts: view.artifacts.concat([{ taskId: event.taskId, artifact: event.artifact }]),
      };
    case "intake_question":
      return {
        ...view,
        inbox: withEntry(view.inbox, event.questionId, { kind: "intake", text: event.question }),
        questions: view.questions.concat([
          { id: event.questionId, question: event.question, ...(event.options ? { options: event.options } : {}) },
        ]),
      };
    case "intake_answered":
      return {
        ...view,
        inbox: without(view.inbox, event.questionId),
        questions: view.questions.filter((question) => question.id !== event.questionId),
      };
    case "question_asked":
      return {
        ...view,
        inbox: withEntry(view.inbox, event.questionId, {
          kind: "question",
          text: event.question,
          id: event.questionId,
        }),
      };
    case "question_answered":
      return { ...view, inbox: without(view.inbox, event.questionId) };
    case "gate_requested":
      return {
        ...view,
        inbox: withEntry(view.inbox, event.gateId, { kind: "gate", text: event.description }),
      };
    case "gate_resolved":
      return { ...view, inbox: without(view.inbox, event.gateId) };
    // A live worker asking for a capability outside its grant. It carries its id so
    // the card can answer it, exactly as a question does.
    case "permission_requested":
      return {
        ...view,
        inbox: withEntry(view.inbox, event.requestId, {
          kind: "permission",
          id: event.requestId,
          text: `${event.tool} — ${event.detail}`,
        }),
      };
    case "permission_resolved":
      return { ...view, inbox: without(view.inbox, event.requestId) };
    default:
      return view;
  }
}

/** One timeline line. The detail is per-type because "task_status" alone says nothing
 *  a person can act on, and the whole event is far too much to read at a glance. */
export function line(event: Event): string {
  const at = String(event.at).slice(11, 19);
  const detail =
    event.type === "mission_status"
      ? event.to
      : event.type === "task_status"
        ? `${event.taskId} → ${event.to}`
        : event.type === "progress_ledger"
          ? `progressing ${event.ledger.isProgressBeingMade ? "✓" : "✗"}  inLoop ${event.ledger.isInLoop ? "✓" : "✗"}`
          : event.type === "replan_started"
            ? event.reason
            : event.type === "signoff_revised"
              ? event.feedback
              : "";
  return `${at}  ${event.type}${detail ? `  ${detail}` : ""}`;
}

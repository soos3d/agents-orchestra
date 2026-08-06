// Folding the log into state. Every projection on disk is built by this function
// and nothing else, which is what "the event log is the source of truth" means in
// practice: if a field can change without a corresponding event, resume loses it
// silently.
//
// The handler table below is a mapped type over the event union, so TypeScript
// fails the build when an event type is added without deciding what it does to
// state. That compile error is the real enforcement of the rule above.
import { addBudget, addSpend, zeroSpend, type Spend } from "../domain/budget.js";
import {
  emptyLedger,
  type Criterion,
  type ProgressLedger,
  type TaskLedger,
} from "../domain/ledger.js";
import { type Mission } from "../domain/mission.js";
import { type WorkerReport } from "../domain/report.js";
import { isTerminal, type Task } from "../domain/task.js";
import { type Event, type EventType } from "./schema.js";
import { LogCorruptionError } from "./log.js";

export interface InboxItem {
  id: string;
  kind: "intake" | "question" | "gate" | "permission" | "criteria_change" | "budget_extension";
  taskId?: string;
  summary: string;
  openedAt: string;
  resolvedAt?: string;
  approved?: boolean;
}

export interface Note {
  scope: "global" | "task";
  taskId?: string;
  text: string;
  at: string;
  deliveredAt?: string;
}

export interface WorkerHandle {
  taskId: string;
  pid?: number;
  startedAt: string;
  lastHeartbeatAt: string;
}

export interface MissionState {
  mission: Mission;
  tasks: Task[];
  /** Reports by round — the orchestrator's entire evidence base each round (§4.1). */
  reports: { taskId: string; round: number; report: WorkerReport }[];
  /** Every progress ledger, in order. `isInLoop` is a question about the last few
   *  rounds, so keeping only the current one makes it unanswerable. */
  progressLedgers: { round: number; ledger: ProgressLedger }[];
  verifications: Record<string, { passed: boolean; output: string }>;
  /** Granted leases by task id, cleared when the task reaches a terminal status (§8). */
  leases: Record<string, string[]>;
  inbox: InboxItem[];
  notes: Note[];
  workers: Record<string, WorkerHandle>;
  panicked: boolean;
  lastSeq: number;
}

type Handler<K extends EventType> = (state: MissionState, event: Extract<Event, { type: K }>) => void;
type Handlers = { [K in EventType]: Handler<K> };

const noop = () => {};

function requireTaskId(event: Event): string {
  if (!event.taskId) {
    throw new LogCorruptionError(
      `seq ${event.seq}: a '${event.type}' event carries no taskId, so it cannot be applied.`,
    );
  }
  return event.taskId;
}

function patchTask(state: MissionState, taskId: string, patch: Partial<Task>): void {
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) {
    throw new LogCorruptionError(`seq: unknown task '${taskId}' — no task_planned event precedes it.`);
  }
  state.tasks = state.tasks.map((task, i) =>
    i === index ? ({ ...task, ...patch } as Task) : task,
  );
}

function patchCriterion(state: MissionState, id: string, patch: Partial<Criterion>): void {
  state.mission = {
    ...state.mission,
    ledger: {
      ...state.mission.ledger,
      criteria: state.mission.ledger.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    },
  };
}

function recordSpend(state: MissionState, phase: string, spend: Spend): void {
  const previous = state.mission.spendByPhase[phase] ?? zeroSpend();
  state.mission = {
    ...state.mission,
    spend: addSpend(state.mission.spend, spend),
    spendByPhase: { ...state.mission.spendByPhase, [phase]: addSpend(previous, spend) },
  };
}

function openInbox(state: MissionState, item: InboxItem): void {
  state.inbox = [...state.inbox, item];
}

function resolveInbox(state: MissionState, id: string, at: string, approved?: boolean): void {
  state.inbox = state.inbox.map((item) =>
    item.id === id && !item.resolvedAt ? { ...item, resolvedAt: at, approved } : item,
  );
}

function resolveLatest(state: MissionState, kind: InboxItem["kind"], at: string, approved: boolean) {
  const open = [...state.inbox].reverse().find((i) => i.kind === kind && !i.resolvedAt);
  if (open) resolveInbox(state, open.id, at, approved);
}

// Criteria are frozen from the moment of sign-off (§3). Enforced at write time too,
// but asserted here as well: a log that violates it is a log that could report
// success against goalposts the system moved itself, and that must be loud.
function assertLedgerRules(previous: Mission, next: TaskLedger): void {
  if (previous.signedOffAt) {
    const before = JSON.stringify(previous.ledger.criteria.map((c) => [c.id, c.statement, c.check]));
    const after = JSON.stringify(next.criteria.map((c) => [c.id, c.statement, c.check]));
    if (before !== after) {
      throw new LogCorruptionError(
        `Criteria changed after sign-off without a criteria_change_requested event. ` +
          `A replan may revise the plan; it may not revise the contract.`,
      );
    }
  }
  assertAppendOnly("deadEnds", previous.ledger.deadEnds, next.deadEnds);
  assertAppendOnly("factsGiven", previous.ledger.factsGiven, next.factsGiven);
}

function assertAppendOnly(
  field: string,
  before: readonly { id: string }[],
  after: readonly { id: string }[],
): void {
  const kept = new Set(after.map((entry) => entry.id));
  const dropped = before.filter((entry) => !kept.has(entry.id));
  if (dropped.length > 0) {
    throw new LogCorruptionError(
      `A ledger revision dropped ${field} entries (${dropped.map((d) => d.id).join(", ")}). ` +
        `${field} is append-only: a replan may add, it may never forget.`,
    );
  }
}

const handlers: Handlers = {
  // ── mission lifecycle ──────────────────────────────────────────────
  mission_created: noop, // seeds the state before folding; see `fold` below
  mission_status: (state, event) => {
    state.mission = { ...state.mission, status: event.to };
  },
  scan_completed: (state, event) => recordSpend(state, "scan", event.spend),
  intake_question: (state, event) =>
    openInbox(state, {
      id: event.questionId,
      kind: "intake",
      summary: event.question,
      openedAt: event.at,
    }),
  intake_answered: (state, event) => resolveInbox(state, event.questionId, event.at),
  research_completed: (state, event) => recordSpend(state, "research", event.spend),

  // ── the contract ───────────────────────────────────────────────────
  outcome_spec_written: (state, event) => {
    state.mission = {
      ...state.mission,
      estimate: event.estimate,
      ledger: { ...state.mission.ledger, criteria: event.criteria, guesses: event.guesses },
    };
  },
  outcome_spec_rejected: noop, // the rejection drives the retry; no state to change
  signoff_requested: noop,
  signoff_granted: (state, event) => {
    state.mission = { ...state.mission, signedOffAt: event.at, unattended: event.unattended };
  },
  signoff_revised: noop,
  criteria_change_requested: (state, event) =>
    openInbox(state, {
      id: `criteria-${event.seq}`,
      kind: "criteria_change",
      summary: event.reasoning,
      openedAt: event.at,
    }),
  criteria_change_resolved: (state, event) =>
    resolveLatest(state, "criteria_change", event.at, event.approved),

  // ── the loop ───────────────────────────────────────────────────────
  round_started: (state, event) => {
    state.mission = { ...state.mission, round: event.round };
  },
  ledger_revised: (state, event) => {
    assertLedgerRules(state.mission, event.ledger);
    state.mission = { ...state.mission, ledger: event.ledger };
  },
  progress_ledger: (state, event) => {
    state.mission = { ...state.mission, progress: event.ledger };
    state.progressLedgers = [
      ...state.progressLedgers,
      { round: event.round, ledger: event.ledger },
    ];
  },
  stall_detected: (state, event) => {
    state.mission = { ...state.mission, stalls: event.stalls };
  },
  replan_started: (state, event) => {
    state.mission = { ...state.mission, resets: event.resets, stalls: 0 };
  },
  dead_end_added: (state, event) => {
    state.mission = {
      ...state.mission,
      ledger: {
        ...state.mission.ledger,
        deadEnds: [...state.mission.ledger.deadEnds, event.deadEnd],
      },
    };
  },

  // ── tasks ──────────────────────────────────────────────────────────
  task_planned: (state, event) => {
    if (state.tasks.some((task) => task.id === event.task.id)) {
      throw new LogCorruptionError(`Duplicate task_planned for '${event.task.id}'.`);
    }
    state.tasks = [...state.tasks, { ...event.task }];
  },
  task_status: (state, event) => {
    const taskId = requireTaskId(event);
    // The transition into `running` *is* the dispatch — there is no separate event
    // for one — so this is where an attempt is counted. Left out, `attempts` keeps
    // whatever `task_planned` carried and the §9.4 retry cap never binds.
    const previous = state.tasks.find((task) => task.id === taskId);
    const timing =
      event.to === "running"
        ? { startedAt: event.at, attempts: (previous?.attempts ?? 0) + 1 }
        : isTerminal(event.to)
          ? { endedAt: event.at }
          : {};
    patchTask(state, taskId, { status: event.to, updatedAt: event.at, ...timing });
    // A lease outlives the worker but not the task: holding it past completion
    // would reject every later task that touches the same files.
    if (isTerminal(event.to)) {
      const { [taskId]: _released, ...rest } = state.leases;
      state.leases = rest;
      const { [taskId]: _stopped, ...others } = state.workers;
      state.workers = others;
    }
  },
  lease_granted: (state, event) => {
    state.leases = { ...state.leases, [requireTaskId(event)]: [...event.owns] };
  },
  lease_rejected: noop, // the dispatch never happened; the plan is what changes
  lease_escaped: noop, // the task fails via task_status — §8 gives it no retry
  worker_started: (state, event) => {
    const taskId = requireTaskId(event);
    state.workers = {
      ...state.workers,
      [taskId]: { taskId, pid: event.pid, startedAt: event.at, lastHeartbeatAt: event.at },
    };
  },
  worker_heartbeat: (state, event) => {
    const taskId = requireTaskId(event);
    const worker = state.workers[taskId];
    if (worker) state.workers = { ...state.workers, [taskId]: { ...worker, lastHeartbeatAt: event.at } };
  },
  worker_report: (state, event) => {
    state.reports = [
      ...state.reports,
      { taskId: requireTaskId(event), round: state.mission.round, report: event.report },
    ];
  },
  artifact_written: (state, event) => {
    const taskId = requireTaskId(event);
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new LogCorruptionError(`artifact_written for unknown task '${taskId}'.`);
    patchTask(state, taskId, { artifacts: [...task.artifacts, event.artifact] });
  },
  verification_run: (state, event) => {
    state.verifications = {
      ...state.verifications,
      [requireTaskId(event)]: { passed: event.passed, output: event.output },
    };
  },
  criterion_checked: (state, event) =>
    patchCriterion(state, event.criterionId, {
      met: event.met,
      evidence: event.evidence,
      lastCheckedRound: state.mission.round,
    }),

  // ── git ────────────────────────────────────────────────────────────
  worktree_created: (state, event) => patchTask(state, requireTaskId(event), {
    worktree: event.path,
  } as Partial<Task>),
  worktree_removed: (state, event) => patchTask(state, requireTaskId(event), {
    worktree: undefined,
  } as Partial<Task>),
  merge_started: noop,
  merge_completed: noop,
  merge_conflicted: noop, // the task moves to `conflicted` via task_status

  // ── the human channel ──────────────────────────────────────────────
  note_received: (state, event) => {
    state.notes = [
      ...state.notes,
      { scope: event.scope, taskId: event.taskId, text: event.text, at: event.at },
    ];
  },
  note_delivered: (state, event) => {
    const index = state.notes.findIndex((note) => note.scope === event.scope && !note.deliveredAt);
    if (index === -1) return;
    state.notes = state.notes.map((note, i) =>
      i === index ? { ...note, deliveredAt: event.at } : note,
    );
  },
  question_asked: (state, event) =>
    openInbox(state, {
      id: event.questionId,
      kind: "question",
      taskId: event.taskId,
      summary: event.question,
      openedAt: event.at,
    }),
  question_answered: (state, event) => resolveInbox(state, event.questionId, event.at),
  gate_requested: (state, event) =>
    openInbox(state, {
      id: event.gateId,
      kind: "gate",
      taskId: event.taskId,
      summary: event.description,
      openedAt: event.at,
    }),
  gate_resolved: (state, event) => resolveInbox(state, event.gateId, event.at, event.approved),
  permission_requested: (state, event) =>
    openInbox(state, {
      id: event.requestId,
      kind: "permission",
      taskId: event.taskId,
      summary: `${event.tool}: ${event.detail}`,
      openedAt: event.at,
    }),
  permission_resolved: (state, event) =>
    resolveInbox(state, event.requestId, event.at, event.approved),
  envelope_violation: noop, // surfaces as a question; the question event carries it

  // ── runtime ────────────────────────────────────────────────────────
  spend_recorded: (state, event) => recordSpend(state, event.phase, event.spend),
  budget_exceeded: (state, event) => {
    if (event.scope !== "mission") return;
    openInbox(state, {
      id: `budget-${event.seq}`,
      kind: "budget_extension",
      summary: `Mission budget exhausted after ${event.actual.wallMs}ms`,
      openedAt: event.at,
    });
  },
  budget_extended: (state, event) => {
    resolveLatest(state, "budget_extension", event.at, true);
    state.mission = {
      ...state.mission,
      budget: addBudget(state.mission.budget, event.added),
      extensions: event.extensions,
    };
  },
  shutdown: noop,
  resumed: noop,
  panic: (state) => {
    state.panicked = true;
  },
};

function seed(event: Extract<Event, { type: "mission_created" }>): MissionState {
  return {
    mission: {
      id: event.missionId,
      goal: event.goal,
      ledger: emptyLedger(),
      capabilityEnvelope: event.envelope,
      status: "scanning",
      round: 0,
      stalls: 0,
      resets: 0,
      budget: event.budget,
      spend: zeroSpend(),
      spendByPhase: {},
      extensions: 0,
      unattended: event.unattended,
      createdAt: event.at,
      updatedAt: event.at,
    },
    tasks: [],
    reports: [],
    progressLedgers: [],
    verifications: {},
    leases: {},
    inbox: [],
    notes: [],
    workers: {},
    panicked: false,
    lastSeq: event.seq,
  };
}

/**
 * Rebuild mission state from the log. Pure: the same events always produce the same
 * state, which is what lets both projections be deleted mid-mission and rebuilt.
 */
export function fold(events: readonly Event[]): MissionState {
  const [first, ...rest] = events;
  if (!first) throw new LogCorruptionError("Empty event log: a mission always opens with mission_created.");
  if (first.type !== "mission_created") {
    throw new LogCorruptionError(
      `The log opens with '${first.type}'; a mission always opens with mission_created.`,
    );
  }

  const state = seed(first);
  for (const event of rest) {
    if (event.type === "mission_created") {
      throw new LogCorruptionError(`seq ${event.seq}: a second mission_created in one log.`);
    }
    // Safe: `handlers` is a mapped type over the union, so the handler at this key
    // accepts exactly this event. The cast only erases the per-key correlation.
    (handlers[event.type] as (s: MissionState, e: Event) => void)(state, event);
    state.mission = { ...state.mission, updatedAt: event.at };
    state.lastSeq = event.seq;
  }
  return state;
}

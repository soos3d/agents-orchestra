// Folding the log into state. Every projection on disk is built by this function
// and nothing else, which is what "the event log is the source of truth" means in
// practice: if a field can change without a corresponding event, resume loses it
// silently.
//
// The handler table below is a mapped type over the event union, so TypeScript
// fails the build when an event type is added without deciding what it does to
// state. That compile error is the real enforcement of the rule above.
import { addBudget, addSpend, zeroSpend, type Spend } from "../domain/budget.js";
import { applyCriteriaDiff } from "../domain/criteriaDiff.js";
import {
  emptyLedger,
  type Criterion,
  type CriterionDiff,
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
  /** Questions only: raised for information and never waited on, so nothing gates on
   *  it (`question_asked.advisory`). Absent is the ordinary question, which does. */
  advisory?: boolean;
}

export interface Note {
  scope: "global" | "task";
  taskId?: string;
  text: string;
  at: string;
  deliveredAt?: string;
}

export interface MissionState {
  mission: Mission;
  tasks: Task[];
  /** Reports by round — the orchestrator's entire evidence base each round (§4.1). */
  reports: { taskId: string; round: number; report: WorkerReport }[];
  /** Every progress ledger, in order. `isInLoop` is a question about the last few
   *  rounds, so keeping only the current one makes it unanswerable. */
  progressLedgers: { round: number; ledger: ProgressLedger }[];
  /** Granted leases by task id, cleared when the task reaches a terminal status (§8). */
  leases: Record<string, string[]>;
  inbox: InboxItem[];
  notes: Note[];
  /** Which question parked which task (§10). The association lives in state because
   *  the answer may arrive when no loop is running, and resume has to know what to
   *  lift. Keyed by task id; a task is parked by at most one question. */
  blockedBy: Record<string, string>;
  panicked: boolean;
  /** §10 pause: the loop drains and parks while this holds. Folded state, so a
   *  pause survives the restart it usually precedes. */
  paused: boolean;
  /**
   * The research brief and what the spec ruled out, both shown at sign-off (§13).
   *
   * Folded rather than passed along, because sign-off can happen on a different run
   * than the one that planned: a mission may sit `awaiting_signoff` overnight, and
   * the screen a human approves has to render from the log alone. Keeping them in a
   * variable would mean a resumed mission shows an empty spec and asks for approval
   * anyway.
   */
  brief: string;
  outOfScope: string[];
  /**
   * The architect's design note: where it is, and the bounded projection of it that the
   * planner sees (PLAN-NEXT 5.1, 5.2).
   *
   * Folded rather than passed along for `brief`'s reason — a mission can be planned on
   * one run and dispatched on another, and a worker whose prompt names the note has to
   * get the path from the log rather than from a variable that died with the process.
   *
   * Absent on a quick mission and on every mission planned before the architect existed,
   * which is what keeps both of those unchanged: no note, no line in anyone's prompt.
   */
  design?: { path: string; summary: string };
  /**
   * What a replan has asked to change about the frozen criteria, until a human
   * answers (§3).
   *
   * Folded rather than passed along, for the reason `brief` is: the mission returns to
   * `awaiting_signoff` and may sit there across a restart, so the screen that renders
   * the diff has to build from the log alone. The `criteria_change_requested` event
   * carries `from` as well as `to` precisely so this needs no ledger that has moved on
   * since (§4.0).
   */
  pendingCriteriaChange?: { diff: CriterionDiff[]; reasoning: string; requestedAt: string };
  /**
   * Environment variable *names* the design said the work needs and the envelope does
   * not grant (PLAN-NEXT 7.1). Never values: the log is a file a human copies into a
   * bug report.
   *
   * Folded rather than passed along for `brief`'s reason — the question raised beside
   * it may be answered when no loop is running, and whoever resumes has to be able to
   * say which credentials this mission is mocking without re-reading the design note.
   */
  secretsRequired: string[];
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

function recordSpend(state: MissionState, phase: string, spend: Spend, model?: string): void {
  const previous = state.mission.spendByPhase[phase] ?? zeroSpend();
  state.mission = {
    ...state.mission,
    spend: addSpend(state.mission.spend, spend),
    spendByPhase: { ...state.mission.spendByPhase, [phase]: addSpend(previous, spend) },
    // Last writer wins: a retried task's later attempt is what the phase now reflects,
    // and a transport that stopped reporting must not erase what an earlier one said.
    ...(model === undefined
      ? {}
      : { modelByPhase: { ...state.mission.modelByPhase, [phase]: model } }),
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
  research_completed: (state, event) => {
    state.brief = event.brief;
    recordSpend(state, "research", event.spend);
  },
  design_written: (state, event) => {
    state.design = { path: event.path, summary: event.summary };
  },

  // ── the contract ───────────────────────────────────────────────────
  outcome_spec_written: (state, event) => {
    state.outOfScope = event.outOfScope;
    state.mission = {
      ...state.mission,
      estimate: event.estimate,
      ledger: { ...state.mission.ledger, criteria: event.criteria, guesses: event.guesses },
    };
  },
  outcome_spec_rejected: noop, // the rejection drives the retry; no state to change
  // The critic's objections drive the one replan inside the call that raised them, so
  // nothing after it reads them from state. Recorded for the reader and for `metrics`,
  // which is what the event is for.
  plan_critiqued: noop,
  // Union rather than assignment (PLAN-NEXT 7.1): the architect names what it needs on
  // the first pass and the retry names it again, and a mission that asked for
  // STRIPE_KEY and later for SLACK_TOKEN needs both on the screen. Names only — the
  // event carries no value, so neither does this.
  secret_required: (state, event) => {
    state.secretsRequired = [...new Set([...state.secretsRequired, ...event.names])];
  },
  signoff_requested: noop,
  signoff_granted: (state, event) => {
    state.mission = { ...state.mission, signedOffAt: event.at, unattended: event.unattended };
  },
  signoff_revised: noop,
  criteria_change_requested: (state, event) => {
    state.pendingCriteriaChange = {
      diff: [...event.diff],
      reasoning: event.reasoning,
      requestedAt: event.at,
    };
    openInbox(state, {
      id: `criteria-${event.seq}`,
      kind: "criteria_change",
      summary: event.reasoning,
      openedAt: event.at,
    });
  },
  // The one event in the system that may move a frozen criterion (§3). Everything
  // else is refused: `revise.ts` refuses the write and `assertLedgerRules` refuses
  // the log. So the approved diff is applied *here*, rather than through a
  // `ledger_revised` the rule above would reject — and after it, the amended set is
  // what the freeze protects.
  criteria_change_resolved: (state, event) => {
    const pending = state.pendingCriteriaChange;
    if (!pending) {
      throw new LogCorruptionError(
        `seq ${event.seq}: criteria_change_resolved with no criteria change was pending. ` +
          `A resolution names no diff of its own, so there is nothing it could apply.`,
      );
    }

    if (event.approved) {
      state.mission = {
        ...state.mission,
        ledger: {
          ...state.mission.ledger,
          criteria: applyCriteriaDiff(state.mission.ledger.criteria, pending.diff),
        },
      };
    }

    state.pendingCriteriaChange = undefined;
    resolveLatest(state, "criteria_change", event.at, event.approved);
  },

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
  // Appended to both tiers, never assigned: the scan's facts may already be there,
  // and the split between them is §6's rule rather than a detail — a stale fact
  // arrives as a guess so a memory nobody re-checked cannot be trusted as ground
  // truth by every later plan. Ids are allocated by the emitter, which is the only
  // place that can see what the ledger already holds.
  memory_recalled: (state, event) => {
    const ledger = state.mission.ledger;
    state.mission = {
      ...state.mission,
      ledger: {
        ...ledger,
        factsVerified: [...ledger.factsVerified, ...event.facts],
        guesses: [...ledger.guesses, ...event.guesses],
      },
    };
  },
  memory_written: noop, // lore lives on disk, not in mission state; this is the trail
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
  // Defect 26: the event carries the redefined task whole (replay rule 2), and this
  // replaces the record — status included, which is how a failed task re-scoped by a
  // replan becomes runnable again. The emitter guarantees it never redefines work
  // that is running or done. A question that parked the old definition is moot for
  // the new one, so the association is dropped with it.
  task_replanned: (state, event) => {
    // `completedRound` is spelled out rather than left to the spread, because the
    // event's task is a plan record and never carries one — and `patchTask` merges,
    // so an omitted key would leave the old round standing on a task that has been
    // redefined. A criterion check would then read work it has never seen as landed.
    patchTask(state, event.task.id, {
      ...event.task,
      completedRound: event.task.completedRound,
      updatedAt: event.at,
    });
    const { [event.task.id]: _redefined, ...rest } = state.blockedBy;
    state.blockedBy = rest;
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
          ? // `done` is the only terminal status that records a round: `failed` and
            // `cancelled` land nothing, and a criterion asks what landed. Redone work
            // overwrites, so the round is always the current landing rather than the
            // first (P1).
            { endedAt: event.at, ...(event.to === "done" ? { completedRound: state.mission.round } : {}) }
          : {};
    patchTask(state, taskId, { status: event.to, updatedAt: event.at, ...timing });
    // A lease outlives the worker but not the task: holding it past completion
    // would reject every later task that touches the same files.
    if (isTerminal(event.to)) {
      const { [taskId]: _released, ...rest } = state.leases;
      state.leases = rest;
    }
  },
  lease_granted: (state, event) => {
    state.leases = { ...state.leases, [requireTaskId(event)]: [...event.owns] };
  },
  lease_rejected: noop, // the dispatch never happened; the plan is what changes
  lease_escaped: noop, // the task fails via task_status — §8 gives it no retry
  // Same shape: the task fails via task_status, and the record of *what* it dirtied is
  // the event's own payload. Inert in state, and deliberately so — the working tree it
  // describes is not mission state, it is a directory a human now has to look at.
  repo_escaped: noop,
  // The dispatch that started the worker already owns the handle it needs; a second copy
  // in folded state was pruned on every terminal status and read by nobody, so the event
  // stays as the audit record and the state does not carry it.
  worker_started: noop,
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
  // The audit record of a check, and nothing reads it back: a criterion's verdict lives
  // on `criterion_checked` and a task's on `task_status`. Accumulating it here kept a
  // last-writer-wins map per task that no caller ever opened.
  verification_run: noop,
  // A seat is one voice and the criterion's state is the panel's answer, so a seated
  // event is a record and not a patch (PLAN-NEXT 6.1). Applying it would leave `met`
  // reading whichever judge happened to answer last, which on a 2-1 split is the wrong
  // one a third of the time — and would set `lastCheckedRound` mid-panel, so
  // `shouldCheckCriterion` would refuse to re-convene the panel that was still voting.
  criterion_checked: (state, event) => {
    if (event.panelSeat !== undefined) return;
    patchCriterion(state, event.criterionId, {
      met: event.met,
      evidence: event.evidence,
      lastCheckedRound: state.mission.round,
    });
  },

  // ── git ────────────────────────────────────────────────────────────
  worktree_created: (state, event) => patchTask(state, requireTaskId(event), {
    worktree: event.path,
  } as Partial<Task>),
  worktree_removed: (state, event) => patchTask(state, requireTaskId(event), {
    worktree: undefined,
  } as Partial<Task>),
  merge_started: noop,
  merge_completed: noop,
  merge_empty: noop,
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
  // §10: the question blocks the *task*, never the loop. Parking happens here rather
  // than in the emitter because the answer may arrive with no loop running, and the
  // resume that follows can only lift what the fold recorded. A `running` or
  // `verifying` task is mid-flight and is left alone (the worker finishes; its
  // outcome moves it); a terminal task is never resurrected; a task a worker already
  // parked as `blocked` is adopted, so the answer has something to lift. An id
  // naming no task is ignored — the question still renders in the inbox, and a
  // question is allowed to block nothing.
  question_asked: (state, event) => {
    openInbox(state, {
      id: event.questionId,
      kind: "question",
      taskId: event.taskId,
      summary: event.question,
      openedAt: event.at,
      ...(event.advisory ? { advisory: true } : {}),
    });
    for (const id of event.blocks) {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) continue;
      if (task.status === "waiting" || task.status === "todo") {
        patchTask(state, id, { status: "blocked", updatedAt: event.at });
        state.blockedBy = { ...state.blockedBy, [id]: event.questionId };
      } else if (task.status === "blocked") {
        state.blockedBy = { ...state.blockedBy, [id]: event.questionId };
      }
    }
  },
  // Back to `waiting`, not `todo`: the scheduler owns promotion, and a parked task
  // whose dependencies regressed must not skip the check (§4).
  question_answered: (state, event) => {
    resolveInbox(state, event.questionId, event.at);
    for (const [taskId, questionId] of Object.entries(state.blockedBy)) {
      if (questionId !== event.questionId) continue;
      const { [taskId]: _lifted, ...rest } = state.blockedBy;
      state.blockedBy = rest;
      const task = state.tasks.find((t) => t.id === taskId);
      if (task?.status === "blocked") {
        patchTask(state, taskId, { status: "waiting", updatedAt: event.at });
      }
    }
  },
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
  spend_recorded: (state, event) => recordSpend(state, event.phase, event.spend, event.model),
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
  resumed: noop,
  panic: (state) => {
    state.panicked = true;
  },
  pause_requested: (state) => {
    state.paused = true;
  },
  pause_lifted: (state) => {
    state.paused = false;
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
      modelByPhase: {},
      extensions: 0,
      unattended: event.unattended,
      // Absent on any log written before the flag existed, and `false` is the honest
      // reading of that: those missions all ran the full research pass.
      quick: event.quick ?? false,
      // Absent on any log written before the choice existed, and an empty object is the
      // honest reading: those missions ran on whatever the machine offered.
      runtime: event.runtime ?? {},
      // Absent on every log written before per-decision-point staffing existed, and an
      // empty object is the honest reading: those missions ran every decision point
      // through the Agent SDK, which is exactly what an empty staffing means here.
      staffing: event.staffing ?? {},
      createdAt: event.at,
      updatedAt: event.at,
    },
    tasks: [],
    reports: [],
    progressLedgers: [],
    leases: {},
    inbox: [],
    notes: [],
    blockedBy: {},
    panicked: false,
    paused: false,
    brief: "",
    outOfScope: [],
    secretsRequired: [],
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

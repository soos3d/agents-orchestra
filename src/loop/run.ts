// The two-ledger loop (§3). A TypeScript `while`, not a conversation.
//
// The distinction decides whether any of the rest works. Inside one long-running
// model conversation there is no moment between rounds when code holds control, so
// the counters could not be enforced, resume would have to replay a transcript that
// is not in the log, and round 15 would still be paying for round 1's context.
//
// So: the model is called at five fixed decision points, each with a fresh context
// built by folding the log, and everything between those calls is code. The counters,
// the criteria freeze, the budget, the ready set, and the stall rule all live here,
// and none of them is ever a model's judgment.
import { type OfferedRole } from "../agents/offer.js";
import { budgetExceeded, type Budget } from "../domain/budget.js";
import { type Criterion } from "../domain/ledger.js";
import { LIMITS, type Limits, type MissionStatus } from "../domain/mission.js";
import { type Task, type WorkerKind } from "../domain/task.js";
import { type MissionState } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { promotable, readyTasks, standstill } from "../scheduler/ready.js";
import { validatePlan } from "../scheduler/validate.js";
import { type Calls } from "./calls.js";
import { shouldCheckCriterion } from "./criteria.js";
import { type DispatchOutcome } from "./dispatch.js";
import { type ExtendRequest } from "./human.js";
import { noteAsFact, pendingNotes } from "./notes.js";
import { buildPlanInput, buildProgressInput } from "./prompts.js";
import { DecisionPointError } from "./resilience.js";
import { isCancellation, retryPolicy } from "./retry.js";
import { reviseLedger } from "./revise.js";
import { SynthesisError, synthesizeTasks } from "./synthesize.js";
import { type CriterionChecker } from "./verify.js";

/** The log, and the state folded from it. Injected so the loop runs against a canned
 *  `events.jsonl` with no disk and no model. */
export interface MissionStore {
  emit(input: EventInput): void;
  state(): MissionState;
}

// Defined next to the port that answers it, and re-exported here because the loop is
// what raises it. One definition, so the screen and the caller cannot drift.
export type { ExtendRequest } from "./human.js";

export interface LoopDeps {
  store: MissionStore;
  calls: Calls;
  /** Injected rather than imported so the loop is testable without git, and so a
   *  retried dispatch is the same call as the first one. */
  dispatch(task: Task, state: MissionState): Promise<DispatchOutcome>;
  checkCriterion: CriterionChecker;
  /** Where a criterion's command check runs — the repo, after the work merged. */
  cwd: string;
  /** The mission's artifact root, where a criterion's full verdict is kept (P2). A
   *  criterion is about work several tasks landed, so its evidence belongs to the
   *  mission rather than to any one task's directory. */
  artifactRoot?: string;
  /** Agents a human promoted from earlier missions (§7), handed to synthesis as prior
   *  art. Loaded at the entry point rather than here, so `run` and `resume` get the
   *  same library — and validated on the way back like any other spec. */
  roles?: readonly OfferedRole[];
  /** The transports synthesis may pick on *this machine* (§7). Computed at the entry
   *  point from the discovered config, because what the build ships and what the
   *  machine can start are different lists — offering the second one is defect 21.
   *  Absent falls back to everything built, which is what a test wants. */
  transports?: readonly string[];
  /** Absent means nobody can be asked, which is what `--unattended` amounts to here. */
  requestExtension?(request: ExtendRequest): Promise<Budget | undefined>;
  limits?: Partial<Limits>;
  concurrency?: Partial<Record<WorkerKind, number>>;
  sleep?(ms: number): Promise<void>;
  onWarn?(message: string): void;
  signal?: AbortSignal;
}

export interface LoopResult {
  status: Extract<MissionStatus, "complete" | "blocked" | "abandoned" | "awaiting_signoff">;
  reason: string;
  rounds: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const limits = { ...LIMITS, ...deps.limits };
  const emit = (event: EventInput) => deps.store.emit(event);

  const missionId = deps.store.state().mission.id;
  const base = { missionId, actor: "orchestrator" as const };

  const finish = (
    status: LoopResult["status"],
    reason: string,
    round: number,
  ): LoopResult => {
    const from = deps.store.state().mission.status;
    if (from !== status) emit({ ...base, type: "mission_status", from, to: status, reason });
    return { status, reason, rounds: round };
  };

  for (;;) {
    const state = deps.store.state();
    const { mission } = state;

    // Panic is not pause (§10). Pause drains; this stops dispatching immediately and
    // leaves the mission parked, because graceful drain is the wrong answer when a
    // worker is somewhere it should not be. Worktrees and branches are untouched —
    // destroying work is a separate decision a human makes afterwards with git in
    // hand.
    if (state.panicked) {
      return finish(
        "blocked",
        "Panicked. Nothing further was dispatched; worktrees and branches are intact. " +
          "Check what the running workers did before resuming.",
        mission.round,
      );
    }

    if (deps.signal?.aborted) {
      return finish("blocked", "shutdown requested", mission.round);
    }

    // Pause is not panic (§10): whatever was in flight this round has already been
    // awaited, so parking here *is* the graceful drain. `orchestra resume` lifts it.
    if (state.paused) {
      return finish(
        "blocked",
        `Paused. In-flight workers finished; 'orchestra resume ${missionId}' lifts the ` +
          `pause and carries on.`,
        mission.round,
      );
    }

    if (mission.round >= limits.maxRounds) {
      return finish(
        "abandoned",
        `Hit the ${limits.maxRounds}-round ceiling. The artifacts are intact; start a ` +
          `narrower mission rather than raising the ceiling.`,
        mission.round,
      );
    }

    // Checked before the round opens, so an approved extension resumes at the round
    // that could not start rather than skipping it (§9.4).
    const money = await handleBudget(deps, limits, state);
    if (money) return finish(money.status, money.reason, mission.round);

    const round = mission.round + 1;
    emit({ ...base, type: "round_started", round });

    // A decision point that will not answer parks the mission rather than killing the
    // process (§9.4, defect 36). Everything this round produced — commits, worktrees,
    // the ledger, the log — is already on disk, and `orchestra resume` continues from
    // exactly here; an exception unwinding to `main` threw all of that away over a
    // throttled call. Only `DecisionPointError` is caught: a programming mistake in
    // the reducer must still raise, because a bug that silently parks is a bug nobody
    // finds.
    const outcome = await runRoundOrPark(deps, limits, state, round);
    if (outcome.kind === "parked") {
      return finish("blocked", outcome.reason, round);
    }
    if (outcome.kind === "finished") {
      return finish(outcome.status, outcome.reason, round);
    }
  }
}

type RoundOutcome =
  | { kind: "continue" }
  | { kind: "parked"; reason: string }
  | { kind: "finished"; status: LoopResult["status"]; reason: string };

async function runRoundOrPark(
  deps: LoopDeps,
  limits: Limits,
  state: MissionState,
  round: number,
): Promise<RoundOutcome> {
  try {
    return await advanceRound(deps, limits, state, round);
  } catch (error) {
    if (!(error instanceof DecisionPointError)) throw error;
    return {
      kind: "parked",
      reason:
        `${error.message} The mission is parked with its work intact — ` +
        `'orchestra resume ${state.mission.id}' picks up at round ${round}.`,
    };
  }
}

/** One iteration of the inner loop: dispatch the ready set, check what the round
 *  landed, and read the progress ledger. Split out from `runLoop` so the decision
 *  points it makes have one place to be caught (§9.4). */
async function advanceRound(
  deps: LoopDeps,
  limits: Limits,
  state: MissionState,
  round: number,
): Promise<RoundOutcome> {
  const emit = (event: EventInput) => deps.store.emit(event);
  const base = { missionId: state.mission.id, actor: "orchestrator" as const };

  await runRound(deps, state, round);

  const afterWork = deps.store.state();
  const stopped = standstill(afterWork, { concurrency: deps.concurrency });
  if (stopped.kind === "cycle") throw new Error(stopped.message);

  await checkCriteria(deps, afterWork, round);

  const withChecks = deps.store.state();
  const ledger = await deps.calls.progress(buildProgressInput(withChecks));
  emit({ ...base, type: "progress_ledger", round, ledger });

  // Marked delivered only after the call that consumed them, so a crash between
  // the two re-delivers rather than dropping — a note nobody acted on and nobody
  // can see again is the worst of the three outcomes.
  deliverNotes(deps, withChecks, round);

  // `met` is read from the criterion record and never inferred: a criterion whose
  // check has not run cannot be counted toward satisfaction (§4). This is the line
  // that stops the mission completing on a model's opinion.
  if (ledger.isRequestSatisfied && allCriteriaMet(withChecks.mission.ledger.criteria)) {
    return { kind: "finished", status: "complete", reason: "every criterion is met, with evidence" };
  }

  const stalls = ledger.isProgressBeingMade ? 0 : withChecks.mission.stalls + 1;
  if (stalls !== withChecks.mission.stalls) {
    emit({ ...base, type: "stall_detected", stalls });
  }

  // Two different failures needing two different responses: not progressing means
  // the work is hard, so keep going. In a loop means the work is *repeating*, so
  // nothing more will come of continuing — replan now, without waiting for the
  // stall counter to run out.
  if (ledger.isInLoop || stalls > limits.maxStalls) {
    const outcome = await replan(
      deps,
      limits,
      ledger.isInLoop ? "the mission is repeating itself" : `${stalls} rounds without progress`,
      round,
    );
    if (outcome) return { kind: "finished", ...outcome };
    return { kind: "continue" };
  }

  if (stopped.kind === "blocked") {
    return {
      kind: "finished",
      status: "blocked",
      reason: `Waiting on a human for ${stopped.taskIds.join(", ")}. Nothing else can run.`,
    };
  }

  return { kind: "continue" };
}

/** Promote what the dependencies unblocked, dispatch the ready set, and apply the
 *  §9.4 policy to whatever came back. */
async function runRound(deps: LoopDeps, state: MissionState, round: number): Promise<void> {
  const base = { missionId: state.mission.id, actor: "orchestrator" as const };

  for (const task of promotable(state)) {
    deps.store.emit({
      ...base,
      taskId: task.id,
      type: "task_status",
      from: task.status,
      to: "todo",
      reason: "every dependency landed",
    });
  }

  const ready = readyTasks(deps.store.state(), { concurrency: deps.concurrency });
  const results = await Promise.all(
    ready.map(async (task) => ({ task, outcome: await deps.dispatch(task, state) })),
  );

  for (const { task, outcome } of results) {
    await applyPolicy(deps, task, outcome, round);
  }
}

async function applyPolicy(
  deps: LoopDeps,
  task: Task,
  outcome: DispatchOutcome,
  round: number,
): Promise<void> {
  const base = { missionId: task.missionId, taskId: task.id, actor: "orchestrator" as const };

  // A worker that reports `blocked` is stuck on something only a person can answer
  // (§4.1), and the dispatch has already parked the task. Without an inbox item the
  // park is permanent — the mission that found this ran a correct recon task, parked
  // on its report, and sat there with an empty inbox (Phase 4's open milestone). The
  // question is what the answer resolves; the fold does the parking and the lifting.
  if (outcome.status === "blocked") {
    deps.store.emit({
      ...base,
      type: "question_asked",
      questionId: `ask-${task.id}-r${round}`,
      question: `Task ${task.id} is blocked: ${outcome.message}`,
      blocks: [task.id],
    });
    return;
  }

  if (outcome.status !== "failed" && outcome.status !== "conflicted") return;

  // The dispatch has already recorded the task's own attempt count.
  const attempts = deps.store.state().tasks.find((t) => t.id === task.id)?.attempts ?? 1;
  const action = retryPolicy(outcome.failure, attempts);

  if (action.kind === "retry") {
    await (deps.sleep ?? wait)(action.backoffMs);
    deps.store.emit({
      ...base,
      type: "task_status",
      from: "failed",
      to: "todo",
      reason: `transport failed; attempt ${action.attempt} of ${attempts + 1}`,
    });
    return;
  }

  if (isCancellation(outcome.failure)) {
    deps.store.emit({
      ...base,
      type: "task_status",
      from: "failed",
      to: "cancelled",
      reason: action.reason,
    });
  }

  // A dead end is what stops the next replan walking back into this. `fix` and `none`
  // both go to the outer loop — the scheduler never invents follow-up work, because
  // deciding what to do about a failure is a planning decision (§3).
  deps.store.emit({
    ...base,
    type: "dead_end_added",
    deadEnd: {
      id: `d-${task.id}-${round}`,
      text: `${task.goal}: ${outcome.message}`,
      addedRound: round,
      approach: task.goal,
      evidence: outcome.message,
      source: outcome.failure === "gate_denied" ? "gate_denied" : "verification",
    },
  });
}

/**
 * A criterion's check runs when the last task listing it in `satisfies` reaches
 * `done`, and again whenever one of those tasks leaves `done` — never on a clock (§4).
 *
 * Every round would re-run the whole check set: wasteful for a command check, and a
 * second model call per criterion per round for a judge, at which point the checking
 * costs more than the work.
 *
 * "The last task listing it" means the last task the *current plan* still carries,
 * which is defect 32. Read as every task the mission ever planned, a task a replan
 * abandoned — failed, or simply dropped — gates its criteria for the rest of the
 * mission, and no check ever fires again however much work lands afterwards. A real
 * mission produced zero `criterion_checked` events that way and could not have
 * completed. Work already `done` still counts as evidence even if the plan moved on:
 * it landed, and the criterion is about what landed.
 *
 * *Whether* to run a given check is `shouldCheckCriterion` (`criteria.ts`) — a pure
 * decision, separately tested, because a false verdict that can never be revisited
 * and a judge re-fired every round are opposite mistakes and both cost a mission.
 */
async function checkCriteria(deps: LoopDeps, state: MissionState, round: number): Promise<void> {
  const planned = new Set(state.mission.ledger.plan.map((task) => task.id));
  // An empty plan means nothing has re-planned yet, so every task is current.
  const current = (taskId: string) => planned.size === 0 || planned.has(taskId);

  for (const criterion of state.mission.ledger.criteria) {
    const contributors = state.tasks.filter((task) => task.satisfies.includes(criterion.id));
    if (contributors.length === 0) continue;

    const outstanding = contributors.filter(
      (task) => task.status !== "done" && current(task.id),
    );
    const landed = contributors.filter((task) => task.status === "done");
    const allDone = landed.length > 0 && outstanding.length === 0;

    if (!shouldCheckCriterion({ criterion, allDone, landed, round })) continue;

    const result = await deps.checkCriterion(criterion, {
      tasks: landed,
      cwd: deps.cwd,
      ...(deps.artifactRoot ? { evidenceDir: deps.artifactRoot } : {}),
    });
    deps.store.emit({
      missionId: state.mission.id,
      actor: "orchestrator",
      type: "criterion_checked",
      criterionId: criterion.id,
      met: result.met,
      evidence: result.evidence,
    });
  }
}

/**
 * Records that the round's notes were used, and puts them where a replan cannot
 * forget them.
 *
 * Two writes rather than one, because they answer different questions. The
 * `note_delivered` event is what makes `queued → delivered` visible on the dashboard,
 * so the lag a human notices is legible rather than mysterious (§10). The ledger
 * append is what makes the note outlive the round: `factsGiven` is append-only across
 * replans (§3), so a correction survives the reset that would otherwise walk straight
 * back into it.
 */
function deliverNotes(deps: LoopDeps, state: MissionState, round: number): void {
  const notes = pendingNotes(state.notes, "global");
  if (notes.length === 0) return;

  const base = { missionId: state.mission.id, actor: "orchestrator" as const };
  const ledger = state.mission.ledger;
  const given = [...ledger.factsGiven];

  for (const note of notes) {
    given.push(noteAsFact(note, given, round));
    deps.store.emit({ ...base, type: "note_delivered", scope: note.scope, path: "stream" });
  }

  deps.store.emit({
    ...base,
    type: "ledger_revised",
    ledger: { ...ledger, factsGiven: given },
    reason: "note",
  });
}

const allCriteriaMet = (criteria: readonly Criterion[]): boolean =>
  criteria.length > 0 && criteria.every((criterion) => criterion.met === true);

/** Returns a terminal result when the mission cannot continue, undefined to loop on. */
async function replan(
  deps: LoopDeps,
  limits: Limits,
  reason: string,
  round: number,
): Promise<{ status: LoopResult["status"]; reason: string } | undefined> {
  const state = deps.store.state();
  const resets = state.mission.resets + 1;
  const base = { missionId: state.mission.id, actor: "orchestrator" as const };

  if (resets > limits.maxResets) {
    deps.store.emit({
      ...base,
      type: "question_asked",
      questionId: `escalation-r${round}`,
      question:
        `This mission has replanned ${limits.maxResets} times without meeting its criteria ` +
        `(${reason}). It needs a different approach or a narrower goal — which?`,
      blocks: state.tasks.filter((task) => task.status !== "done").map((task) => task.id),
    });
    return {
      status: "blocked",
      reason: `Hit the ${limits.maxResets}-reset cap and escalated rather than spinning.`,
    };
  }

  deps.store.emit({ ...base, type: "replan_started", resets, reason });

  const plan = await planWithOneRetry(deps, reason);
  if ("message" in plan) {
    return { status: "abandoned", reason: `The planner could not produce a runnable plan: ${plan.message}` };
  }

  const proposed = {
    ...state.mission.ledger,
    plan: plan.tasks,
    ...(plan.criteria ? { criteria: plan.criteria } : {}),
  };
  const revision = reviseLedger(state.mission, proposed, reason);

  // The planner may ask to change the contract and may never change it. This is the
  // one thing after sign-off that blocks the mission, and it exists so the system
  // cannot move its own goalposts and then pass.
  if (revision.kind === "criteria_change") {
    deps.store.emit({
      ...base,
      type: "criteria_change_requested",
      diff: revision.diff,
      reasoning: revision.reasoning,
    });
    return state.mission.unattended
      ? {
          status: "blocked",
          reason:
            "The replan proposed changing a signed-off criterion. Under --unattended the " +
            "mission parks rather than approving its own contract change.",
        }
      : {
          status: "awaiting_signoff",
          reason: "The replan proposed changing a signed-off criterion. Sign-off reopens.",
        };
  }

  if (revision.restored.length > 0) {
    (deps.onWarn ?? (() => {}))(
      `The replan dropped append-only ledger entries (${revision.restored.join(", ")}); ` +
        `they were put back. A replan may add, it may never forget.`,
    );
  }

  deps.store.emit({ ...base, type: "ledger_revised", ledger: revision.ledger, reason: "replan" });

  // A plan the registry or the envelope will not staff (§7, §8). It ends the mission
  // rather than looping, because the replan that produced it was the response to a
  // stall and a second one would propose the same thing against the same ceiling —
  // `finish` emits the park, and the reason names what a human would have to change.
  try {
    await synthesizeTasks(deps, plan.tasks, round);
  } catch (error) {
    if (!(error instanceof SynthesisError)) throw error;
    return { status: "blocked", reason: error.message };
  }

  return undefined;
}

/** One structured-return retry, quoting the offending edge — the planner cannot use
 *  its retry for anything unless the rejection says what was wrong (§3). */
async function planWithOneRetry(
  deps: LoopDeps,
  reason: string,
): Promise<Awaited<ReturnType<Calls["plan"]>> | { message: string }> {
  // The criteria the plan is judged against, so a revision that orphans one is
  // refused here rather than discovered as a mission that never completes (defect 32).
  // A proposed criteria change is not this function's business — `reviseLedger` owns
  // the freeze — so the frozen set is what a plan has to cover.
  const criteria = () => deps.store.state().mission.ledger.criteria;

  const first = await deps.calls.plan(buildPlanInput(deps.store.state(), reason));
  const check = validatePlan(first.tasks, first.criteria ?? criteria());
  if (check.ok) return first;

  const second = await deps.calls.plan(
    buildPlanInput(deps.store.state(), `${reason}\n\nThe last plan was rejected: ${check.message}`),
  );
  const recheck = validatePlan(second.tasks, second.criteria ?? criteria());
  return recheck.ok ? second : { message: recheck.message };
}

/**
 * Running out is a question, not a failure (§9.4).
 *
 * Twenty more minutes on a mission that is most of the way there beats abandoning
 * three hours of paid work — so it parks and asks. Capped at two extensions, and
 * never granted unwatched: a flag that skips reading the plan is a reasonable trade,
 * one that lets an unattended mission raise its own spending limit is not.
 */
async function handleBudget(
  deps: LoopDeps,
  limits: Limits,
  state: MissionState,
): Promise<{ status: LoopResult["status"]; reason: string } | undefined> {
  const { mission } = state;
  if (!budgetExceeded(mission.budget, mission.spend)) return undefined;

  const base = { missionId: mission.id, actor: "orchestrator" as const };
  deps.store.emit({
    ...base,
    type: "budget_exceeded",
    scope: "mission",
    limit: mission.budget,
    actual: mission.spend,
  });

  if (mission.extensions >= limits.maxExtensions) {
    return {
      status: "abandoned",
      reason:
        `The plan overran its budget ${limits.maxExtensions} times. The artifacts are ` +
        `intact — start a new mission with what this one learned.`,
    };
  }

  const unmet = mission.ledger.criteria.filter((c) => c.met !== true).map((c) => c.id);

  if (mission.unattended || !deps.requestExtension) {
    return {
      status: "blocked",
      reason: `Mission budget exhausted with ${unmet.length} criteria outstanding. Parked to ask.`,
    };
  }

  const added = await deps.requestExtension({
    missionId: mission.id,
    spentWallMs: mission.spend.wallMs,
    budget: mission.budget,
    unmetCriteria: unmet,
    extensionsUsed: mission.extensions,
  });

  if (!added) {
    return { status: "abandoned", reason: "The extension was declined. Artifacts are intact." };
  }

  deps.store.emit({
    ...base,
    type: "budget_extended",
    added,
    extensions: mission.extensions + 1,
    by: "human",
  });
  return undefined;
}

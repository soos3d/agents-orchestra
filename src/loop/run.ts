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
import { budgetExceeded, type Budget } from "../domain/budget.js";
import { type Criterion } from "../domain/ledger.js";
import { LIMITS, type Limits, type MissionStatus } from "../domain/mission.js";
import { type Task, type WorkerKind } from "../domain/task.js";
import { type MissionState } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { promotable, readyTasks, standstill } from "../scheduler/ready.js";
import { validatePlan } from "../scheduler/validate.js";
import { type Calls } from "./calls.js";
import { type DispatchOutcome } from "./dispatch.js";
import { buildPlanInput, buildProgressInput } from "./prompts.js";
import { isCancellation, retryPolicy } from "./retry.js";
import { reviseLedger } from "./revise.js";
import { type CriterionChecker } from "./verify.js";

/** The log, and the state folded from it. Injected so the loop runs against a canned
 *  `events.jsonl` with no disk and no model. */
export interface MissionStore {
  emit(input: EventInput): void;
  state(): MissionState;
}

export interface ExtendRequest {
  missionId: string;
  spentWallMs: number;
  budget: Budget;
  unmetCriteria: string[];
  extensionsUsed: number;
}

export interface LoopDeps {
  store: MissionStore;
  calls: Calls;
  /** Injected rather than imported so the loop is testable without git, and so a
   *  retried dispatch is the same call as the first one. */
  dispatch(task: Task, state: MissionState): Promise<DispatchOutcome>;
  checkCriterion: CriterionChecker;
  /** Where a criterion's command check runs — the repo, after the work merged. */
  cwd: string;
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

    if (deps.signal?.aborted) {
      return finish("blocked", "shutdown requested", mission.round);
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

    await runRound(deps, state, round);

    const afterWork = deps.store.state();
    const stopped = standstill(afterWork, { concurrency: deps.concurrency });
    if (stopped.kind === "cycle") throw new Error(stopped.message);

    await checkCriteria(deps, afterWork, round);

    const withChecks = deps.store.state();
    const ledger = await deps.calls.progress(buildProgressInput(withChecks));
    emit({ ...base, type: "progress_ledger", round, ledger });

    // `met` is read from the criterion record and never inferred: a criterion whose
    // check has not run cannot be counted toward satisfaction (§4). This is the line
    // that stops the mission completing on a model's opinion.
    if (ledger.isRequestSatisfied && allCriteriaMet(withChecks.mission.ledger.criteria)) {
      return finish("complete", "every criterion is met, with evidence", round);
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
      if (outcome) return finish(outcome.status, outcome.reason, round);
      continue;
    }

    if (stopped.kind === "blocked") {
      return finish(
        "blocked",
        `Waiting on a human for ${stopped.taskIds.join(", ")}. Nothing else can run.`,
        round,
      );
    }
  }
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
  if (outcome.status !== "failed" && outcome.status !== "conflicted") return;

  // The dispatch has already recorded the task's own attempt count.
  const attempts = deps.store.state().tasks.find((t) => t.id === task.id)?.attempts ?? 1;
  const action = retryPolicy(outcome.failure, attempts);
  const base = { missionId: task.missionId, taskId: task.id, actor: "orchestrator" as const };

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
 */
async function checkCriteria(deps: LoopDeps, state: MissionState, round: number): Promise<void> {
  for (const criterion of state.mission.ledger.criteria) {
    const satisfying = state.tasks.filter((task) => task.satisfies.includes(criterion.id));
    if (satisfying.length === 0) continue;
    if (criterion.lastCheckedRound === round) continue;

    const allDone = satisfying.every((task) => task.status === "done");
    const firstTime = allDone && criterion.lastCheckedRound === undefined;
    // Something that was done no longer is — a revert, a re-plan that added work, a
    // task that had to be redone. Either way the basis for `met` has changed.
    const invalidated = !allDone && criterion.met === true;
    if (!firstTime && !invalidated) continue;

    const result = await deps.checkCriterion(criterion, { tasks: satisfying, cwd: deps.cwd });
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
  await synthesizeNewTasks(deps, plan.tasks, round);
  return undefined;
}

/** One structured-return retry, quoting the offending edge — the planner cannot use
 *  its retry for anything unless the rejection says what was wrong (§3). */
async function planWithOneRetry(
  deps: LoopDeps,
  reason: string,
): Promise<Awaited<ReturnType<Calls["plan"]>> | { message: string }> {
  const first = await deps.calls.plan(buildPlanInput(deps.store.state(), reason));
  const check = validatePlan(first.tasks);
  if (check.ok) return first;

  const second = await deps.calls.plan(
    buildPlanInput(deps.store.state(), `${reason}\n\nThe last plan was rejected: ${check.message}`),
  );
  const recheck = validatePlan(second.tasks);
  return recheck.ok ? second : { message: recheck.message };
}

async function synthesizeNewTasks(
  deps: LoopDeps,
  planned: Awaited<ReturnType<Calls["plan"]>>["tasks"],
  round: number,
): Promise<void> {
  const state = deps.store.state();
  const known = new Set(state.tasks.map((task) => task.id));
  const now = new Date().toISOString();

  for (const entry of planned) {
    if (known.has(entry.id)) continue;

    const agentSpec = await deps.calls.synthesize({
      task: entry,
      envelope: state.mission.capabilityEnvelope,
      toolCatalogue: state.mission.capabilityEnvelope.toolClasses,
    });

    deps.store.emit({
      missionId: state.mission.id,
      actor: "orchestrator",
      type: "task_planned",
      task: {
        id: entry.id,
        missionId: state.mission.id,
        goal: entry.goal,
        successCriteria: [],
        satisfies: entry.satisfies,
        motivatedBy: entry.motivatedBy,
        worker: entry.worker,
        agentSpec,
        dependsOn: entry.dependsOn,
        // A task with unmet dependencies starts `waiting`, and the scheduler — not a
        // human — is what ends that wait.
        status: entry.dependsOn.length > 0 ? "waiting" : "todo",
        artifacts: [],
        verify: agentSpec.verify,
        attempts: 0,
        budget: { wallMs: entry.estimatedWallMs },
        createdAt: now,
        updatedAt: now,
        ...taskShapeFor(entry.worker, entry.id, round),
      },
    } as EventInput);
  }
}

/** The fields a Task carries because of its kind. Git belongs to `code` and nowhere
 *  else (§4), so this is where a plan's worker kind becomes a task shape. */
function taskShapeFor(worker: WorkerKind, id: string, round: number): Record<string, unknown> {
  if (worker === "code") return { branch: `orchestra/${id}-r${round}`, owns: [] };
  if (worker === "computer") return { surface: "browser", allowedDomains: [] };
  return {};
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

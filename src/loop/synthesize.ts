// Turning intent into something that can run (§7).
//
// A PlannedTask is intent; a Task is intent with an agent synthesized for it. Keeping
// them apart is what lets `--plan-only` produce a full plan and an estimate with no
// AgentSpec existing anywhere — and it is why this step is separate from planning
// rather than folded into it.
//
// Fable authors the agent for each task at plan time, shaped to that task's goal. The
// envelope it draws from is declared per mission by a human and synthesis can only
// narrow it: a model that authors agents *and* grants them tools has no ceiling.
//
// This file is where that ceiling is actually applied. Three things are checked before
// a task reaches the board, each of them a failure that used to be discovered later
// and more expensively:
//
//   - the transport exists (defect 21: discovered at dispatch, one replan per task);
//   - every tool resolves to a class the envelope grants (§7's central claim, and it
//     was checked nowhere — `violations()` had no caller outside its own test);
//   - a code task declares a lease (§8, and an empty one fails *every* writing worker,
//     since `detectEscape` matches nothing against an empty glob set).
//
// Each gets one structured-return retry, the same allowance every decision point has,
// because the first answer to an unstated constraint is a misunderstanding rather than
// a failure. What happens after the retry differs: a bad transport or a missing lease
// goes back to the planner, and a capability the envelope does not grant goes to a
// human, because widening an envelope is a human action and there is no code path that
// does it.
import { describeViolations, violations, type Envelope } from "../domain/envelope.js";
import { type PlannedTask } from "../domain/ledger.js";
import { type AgentSpec, type WorkerKind } from "../domain/task.js";
import { type EventInput } from "../events/schema.js";
import { AVAILABLE_TRANSPORTS } from "../workers/transport.js";
import { classOf, resolveClasses } from "../workers/toolCatalogue.js";
import { type Calls } from "./calls.js";
import { type MissionStore } from "./run.js";

export interface SynthesizeDeps {
  store: MissionStore;
  calls: Pick<Calls, "synthesize">;
  /** Overridable so a test can assert the rejection without shipping a transport. */
  transports?: readonly string[];
  /** Roles a human promoted from earlier missions (§7), offered to the call as prior
   *  art. They change what the model is *shown* and nothing about what it is allowed
   *  to return: every check below runs on the answer either way. */
  profiles?: readonly AgentSpec[];
  now?: () => string;
}

/** Synthesis could not produce a runnable agent for a task. Every subclass names its
 *  own fix (§2a rule 5), and the callers catch the base: what they all have in common
 *  is that the mission parks rather than the process dying, which is what happened
 *  before — the throw escaped `replan`, `runLoop`, and `main` as a stack trace. */
export class SynthesisError extends Error {
  constructor(
    readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = "SynthesisError";
  }
}

/**
 * A synthesized agent asked to run on a transport that does not exist.
 *
 * §7 puts this on the registry's side of the line rather than the planner's, and the
 * cost of the other reading is concrete: against a real model, `synthesize` picked
 * `agent-sdk` for every research task — §7's table lists five transports and Phase 2
 * ships one — and every task died at dispatch, burned its typed retry, took the
 * replan with it, and the mission escalated at the reset cap having produced nothing.
 */
export class UnavailableTransportError extends SynthesisError {
  constructor(taskId: string, requested: string, available: readonly string[]) {
    super(
      taskId,
      `Task '${taskId}' was staffed with the '${requested}' transport, which is not ` +
        `built yet, and re-asking did not fix it. Available: ${available.join(", ")}. ` +
        `Narrow the mission to work a '${available[0]}' worker can do, or wait for the ` +
        `transport (ACP is Phase 7, chrome-mcp is Phase 8).`,
    );
    this.name = "UnavailableTransportError";
  }
}

/**
 * A synthesized agent asked for a capability the mission's envelope does not grant.
 *
 * This is the one synthesis failure that is not a planning problem. The plan may be
 * perfectly good and the envelope simply too narrow for it, and deciding between those
 * is exactly the judgment §7 reserves for a human: "widening the envelope is a human
 * decision, always". So it emits `envelope_violation` and a question, and the mission
 * parks rather than the loop quietly re-planning around a ceiling the human set.
 */
export class EnvelopeViolationError extends SynthesisError {
  constructor(taskId: string, requested: string) {
    super(
      taskId,
      `Task '${taskId}' was staffed with capabilities the mission envelope does not ` +
        `grant (${requested}), and re-asking did not fix it. Widening an envelope is a ` +
        `human decision, so nothing here will do it: approve the wider envelope on a ` +
        `new mission, or narrow this task to work the current one allows.`,
    );
    this.name = "EnvelopeViolationError";
  }
}

/**
 * A code agent that would not say which files it is going to write.
 *
 * Refused rather than defaulted, because the default is worse than it looks. `owns`
 * was hardcoded empty until this check existed, and an empty glob set matches nothing
 * — so `readyTasks` skipped the lease check entirely (no declaration, no conflict) and
 * then `detectEscape` counted *every* changed file as an escape. Two code tasks could
 * edit the same file unnoticed, and any code task that actually wrote something failed
 * without retry. The whole of §8 was built, tested, and inert.
 */
export class UndeclaredLeaseError extends SynthesisError {
  constructor(taskId: string) {
    super(
      taskId,
      `Task '${taskId}' is code work whose agent declared no file lease, twice. A code ` +
        `task must say which files it will write (§8) — without it two workers can edit ` +
        `the same file and the escape check fails the task anyway. Split the task until ` +
        `its file set is nameable, or plan it as 'research' if it writes nothing.`,
    );
    this.name = "UndeclaredLeaseError";
  }
}

/** Synthesizes an agent for every planned task not already on the board, and emits
 *  `task_planned` for each. Tasks that already exist are left alone: a replan revises
 *  the plan, and re-synthesizing running work would duplicate it. */
export async function synthesizeTasks(
  deps: SynthesizeDeps,
  planned: readonly PlannedTask[],
  round: number,
): Promise<number> {
  const state = deps.store.state();
  const known = new Set(state.tasks.map((task) => task.id));
  const at = (deps.now ?? (() => new Date().toISOString()))();
  let added = 0;

  const transports = deps.transports ?? AVAILABLE_TRANSPORTS;

  for (const entry of planned) {
    if (known.has(entry.id)) continue;

    const agentSpec = await staff(deps, entry, state.mission.capabilityEnvelope, transports);

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
        // human — is what ends that wait (§4).
        status: entry.dependsOn.length > 0 ? "waiting" : "todo",
        artifacts: [],
        verify: agentSpec.verify,
        attempts: 0,
        budget: { wallMs: entry.estimatedWallMs },
        createdAt: at,
        updatedAt: at,
        ...shapeFor(entry.worker, entry.id, round, agentSpec),
      },
    } as EventInput);
    added++;
  }

  return added;
}

/** What was wrong with a spec: the sentence the model gets on its retry, the string
 *  the event and the error record, and which of the three failures it was. */
interface SpecProblem {
  kind: "transport" | "capability" | "lease";
  requested: string;
  retry: string;
}

/** One structured-return retry, the same allowance every decision point gets — and
 *  for the same reason: a model that named an unbuilt transport, or reached for a tool
 *  outside the envelope, was never told which ones were available. The first answer is
 *  a misunderstanding, so it is worth quoting the constraint and asking again. */
async function staff(
  deps: SynthesizeDeps,
  task: PlannedTask,
  envelope: Envelope,
  transports: readonly string[],
): Promise<AgentSpec> {
  const catalogue = resolveClasses(envelope.toolClasses);

  const request = (rejected?: string) =>
    deps.calls.synthesize({
      task,
      envelope,
      toolCatalogue: catalogue,
      transports: [...transports],
      // Omitted rather than sent empty: a prompt carrying "profiles: []" spends
      // context telling the model about a library that does not exist.
      ...(deps.profiles && deps.profiles.length > 0 ? { profiles: [...deps.profiles] } : {}),
      ...(rejected ? { rejected } : {}),
    });

  const first = await request();
  const firstProblem = inspect(first, task, envelope, transports, catalogue);
  if (!firstProblem) return first;

  const second = await request(firstProblem.retry);
  const problem = inspect(second, task, envelope, transports, catalogue);
  if (!problem) return second;

  throw raise(deps, task, envelope, problem, transports);
}

/** Every check a spec has to pass, in the order that makes the retry most useful:
 *  the transport first because it decides whether the task can run at all, then the
 *  capabilities, then the lease. One problem is reported at a time on purpose — a
 *  retry that quotes three constraints teaches none of them well. */
function inspect(
  spec: AgentSpec,
  task: PlannedTask,
  envelope: Envelope,
  transports: readonly string[],
  catalogue: readonly string[],
): SpecProblem | undefined {
  if (!transports.includes(spec.transport.id)) {
    return {
      kind: "transport",
      requested: spec.transport.id,
      retry:
        `The '${spec.transport.id}' transport is not built. Choose one of: ` +
        `${transports.join(", ")}.`,
    };
  }

  const capability = inspectTools(spec.tools, envelope, catalogue);
  if (capability) return capability;

  if (task.worker === "code" && (spec.owns ?? []).length === 0) {
    return {
      kind: "lease",
      requested: "owns",
      retry:
        `A code agent must declare 'owns': the file globs this task will write, e.g. ` +
        `["src/routes/health.ts", "test/health.test.ts"]. It is checked before dispatch ` +
        `against other tasks' leases and again after the worker returns, so an empty ` +
        `list fails the task rather than granting it the whole tree. Be specific — a ` +
        `lease of "**" serializes the mission behind this one task.`,
    };
  }

  return undefined;
}

/**
 * The envelope check, and the reason `violations()` is called here rather than a
 * hand-rolled set difference: it is the tested containment function, and this is the
 * boundary §7 says it guards.
 *
 * Two ways to fail, reported together because they are one question to the model. A
 * tool whose class the envelope does not list is a widening request. A tool with no
 * class at all is not ours to grant, and it must not read as a near-miss — the model
 * asking for `Frobnicate` and the model asking for `Bash` under a read-only envelope
 * are different mistakes and get different sentences.
 */
function inspectTools(
  tools: readonly string[],
  envelope: Envelope,
  catalogue: readonly string[],
): SpecProblem | undefined {
  const requestedBy = new Map<string, string[]>();
  const unknown: string[] = [];

  for (const tool of tools) {
    const cls = classOf(tool);
    if (cls === undefined) {
      unknown.push(tool);
      continue;
    }
    requestedBy.set(cls, [...(requestedBy.get(cls) ?? []), tool]);
  }

  const outside = violations(envelope, { toolClasses: [...requestedBy.keys()] });
  const denied = outside.flatMap((violation) => requestedBy.get(violation.requested) ?? []);
  if (denied.length === 0 && unknown.length === 0) return undefined;

  const offer =
    catalogue.length > 0
      ? `Choose only from: ${catalogue.join(", ")}.`
      : `This envelope grants no tools at all, so this task cannot be staffed as planned.`;

  return {
    kind: "capability",
    requested: [...denied, ...unknown].join(", "),
    retry: [
      denied.length > 0
        ? `These tools need capabilities the mission envelope does not grant — ` +
          `${denied.join(", ")} (${describeViolations(outside)}).`
        : "",
      unknown.length > 0 ? `These tools are not in the catalogue: ${unknown.join(", ")}.` : "",
      offer,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Builds the error, and for a capability failure records the two events first. A
 *  transport or a lease problem goes back to the planner and needs no inbox item; a
 *  capability problem needs a human, so it surfaces as a question (§7, §9.4) with the
 *  task named in `blocks`. */
function raise(
  deps: SynthesizeDeps,
  task: PlannedTask,
  envelope: Envelope,
  problem: SpecProblem,
  transports: readonly string[],
): SynthesisError {
  if (problem.kind === "transport") {
    return new UnavailableTransportError(task.id, problem.requested, transports);
  }
  if (problem.kind === "lease") return new UndeclaredLeaseError(task.id);

  const base = {
    missionId: deps.store.state().mission.id,
    taskId: task.id,
    actor: "orchestrator" as const,
  };

  deps.store.emit({
    ...base,
    type: "envelope_violation",
    requested: problem.requested,
    envelope,
  });
  deps.store.emit({
    ...base,
    type: "question_asked",
    questionId: `envelope-${task.id}`,
    question:
      `Task '${task.id}' (${task.goal}) needs ${problem.requested}, which this ` +
      `mission's envelope does not grant. Widen the envelope on a new mission, or ` +
      `narrow the goal so this task is not needed?`,
    blocks: [task.id],
  });

  return new EnvelopeViolationError(task.id, problem.requested);
}

/** The fields a Task carries because of its kind. Git belongs to `code` and nowhere
 *  else (§4), so this is where a plan's worker kind becomes a task shape.
 *
 *  `owns` comes off the synthesized spec, which `inspect` has already refused to leave
 *  empty for code work — the `?? []` is a type narrowing, not a fallback. */
function shapeFor(
  worker: WorkerKind,
  id: string,
  round: number,
  spec: AgentSpec,
): Record<string, unknown> {
  if (worker === "code") return { branch: `orchestra/${id}-r${round}`, owns: spec.owns ?? [] };
  if (worker === "computer") return { surface: "browser", allowedDomains: [] };
  return {};
}

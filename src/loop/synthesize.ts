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
import {
  composeSystemPrompt,
  resolveRole,
  rosterIndex,
  type OfferedRole,
} from "../agents/offer.js";
import { describeViolations, violations, type Envelope } from "../domain/envelope.js";
import { type PlannedTask } from "../domain/ledger.js";
import { type AgentSpec, type WorkerKind } from "../domain/task.js";
import { type EventInput } from "../events/schema.js";
import { type ModelCard, modelCardIndex } from "../providers/modelCard.js";
import { allowedTargets, builtHarnesses } from "../workers/harness.js";
import { AVAILABLE_TRANSPORTS } from "../workers/transport.js";
import { classOf, resolveClasses } from "../workers/toolCatalogue.js";
import { declaresLegalOutput } from "./artifactPath.js";
import { type Calls } from "./calls.js";
import { type MissionStore } from "./run.js";

export interface SynthesizeDeps {
  store: MissionStore;
  calls: Pick<Calls, "synthesize">;
  /** Overridable so a test can assert the rejection without shipping a transport. */
  transports?: readonly string[];
  /** The agent CLIs a spec may target — what this machine can start, narrowed by the
   *  harness the human pinned. Absent falls back to every target the build knows, which
   *  is the behaviour every mission had before a harness could be chosen. */
  targets?: readonly string[];
  /** The model names a spec may name, or empty for unconstrained (`workers/harness.ts`).
   *  Absent is the same as empty: a `Deps` that leaves it off checks nothing, which is
   *  the optional-dependency footgun and the reason the composition roots are tested. */
  models?: readonly string[];
  /** The verified model cards this machine can reach (PLAN-NEXT 2.1), carried in the
   *  same object `transports`, `targets` and `models` arrive in (`staffingOffer`).
   *  They change what the model is *shown* — id, tier, context, rates — and nothing
   *  about what it may return: `models` is still the allowlist, and a card id is a name
   *  at a provider's API rather than a name this harness is known to accept. Absent is a
   *  machine with no probed provider, which is every machine until one is configured. */
  modelCards?: readonly ModelCard[];
  /** The container backends this machine answered for (PLAN-NEXT 3.3), arriving in the
   *  same `staffingOffer` object as the four above. Read only when the envelope demands
   *  containment: an empty list then is a mission that cannot be staffed at all, and it
   *  says so here rather than at dispatch, where every task would spawn a backend that
   *  is not running and burn a retry and a replan learning it (defect 21's shape). */
  containment?: readonly string[];
  /** The roles this mission may staff from (§7, amended): the documented roster plus
   *  anything a human promoted, already merged by `agents/offer.ts`. They change what
   *  the model is *shown* and nothing about what it is allowed to return — every check
   *  below runs on the answer either way. Absent is a mission that staffs from scratch,
   *  which is the behaviour every mission had before the roster existed. */
  roles?: readonly OfferedRole[];
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
 * A judge-verified agent whose toolset cannot produce the artifact its own rubric
 * grades (defect 27).
 *
 * The judge reads files on disk and nothing else (§3), so a `judge` check obliges the
 * work to leave a file behind — defect 25 taught the rubric that, and the first real
 * serve-driven mission showed the other half: synthesis granted least-privilege
 * `Read/Glob/Grep`, the worker was denied the write, the judge got an empty artifact
 * list, and a correctly-done task failed. The two halves of one contract are checked
 * in one place: a rubric about files and a toolset that can make one.
 */
export class ArtifactToolError extends SynthesisError {
  constructor(taskId: string) {
    super(
      taskId,
      `Task '${taskId}' is judge-verified, and twice its agent held no tool that can ` +
        `write the artifact the judge will read. Grant a writing tool (class fs.write), ` +
        `verify by command instead, or — if the envelope withholds fs.write — plan the ` +
        `task so its output is checkable without a file.`,
    );
    this.name = "ArtifactToolError";
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
/**
 * An agent that would write outside the one directory the task was given (P2).
 *
 * The 41-vs-27 collision resolved: a judge rubric may oblige an artifact, and a
 * worker with no worktree may not write into the checkout — so it has exactly one
 * legal location, and a spec that names another has broken the contract before the
 * task has started. A planning-level failure like the lease, not a human decision:
 * the directory is not negotiable and no code path widens it.
 */
export class ArtifactEscapeError extends SynthesisError {
  constructor(taskId: string, declared: string) {
    super(
      taskId,
      `Task '${taskId}' declared an output path of '${declared}', twice, which is not ` +
        `inside the artifact directory it is given at dispatch. A spec names only what ` +
        `goes inside that directory — a relative path like "report.md" — and the ` +
        `runtime supplies the directory itself. Omit 'outputPath' to write to the ` +
        `directory directly, or plan the task as 'code' if it needs to change the repo.`,
    );
    this.name = "ArtifactEscapeError";
  }
}

/**
 * A synthesized agent that started from a role the roster does not have.
 *
 * A planning-level failure like the lease, and refused rather than degraded for a
 * reason specific to how `basedOn` works: the model writes only the task-specific
 * addendum when it names a role, so accepting an unresolvable name would hand a worker
 * a paragraph where a system prompt should be — and it would run, badly, with nothing
 * failing. That is worse than parking, because the mission would spend a dispatch and a
 * verification to find out.
 */
export class UnknownRoleError extends SynthesisError {
  constructor(taskId: string, requested: string) {
    super(
      taskId,
      `Task '${taskId}' was staffed from a role called '${requested}', twice, which is ` +
        `not in the roster. Add it as a file under the roster directory, or let the ` +
        `task be staffed from scratch — a spec with no 'basedOn' and a full system ` +
        `prompt is always allowed.`,
    );
    this.name = "UnknownRoleError";
  }
}

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

/**
 * A synthesized agent aimed at an agent CLI this machine cannot start.
 *
 * Defect 21 one field along from the transport that already had a door. `transports`
 * has been checked since Phase 2, but the target was named in prose in the prompt —
 * "claude or codex" — so a machine holding only one of them still invited a spec for
 * the other, and it was discovered at dispatch with the task planned and staffed.
 *
 * A planning problem rather than a human decision: the mission can be staffed against
 * the CLI that is installed, and no code path installs the other one.
 */
export class UnavailableTargetError extends SynthesisError {
  constructor(taskId: string, requested: string, available: readonly string[]) {
    super(
      taskId,
      `Task '${taskId}' was staffed against the '${requested}' agent, twice, which this ` +
        `machine cannot start. ` +
        (available.length > 0
          ? `Available: ${available.join(", ")}. Staff the task against one of those`
          : `No agent CLI was found on PATH at all — run 'orchestra doctor', install one, ` +
            `and log in`) +
        `, or widen the harness this mission was composed with.`,
    );
    this.name = "UnavailableTargetError";
  }
}

/**
 * A synthesized agent asked to run on a model that is not on offer.
 *
 * The hole this closes had been open since Phase 1: `AgentSpec.model` is a required
 * non-empty string that goes straight to `--model` on a real CLI, and nothing checked
 * it — `inspect` covered the transport, the tools, the lease, the artifact and the
 * role, and walked past the one field that decides what the work actually costs. An
 * invented name passed validation, reached the log, and failed at dispatch.
 *
 * It is also how a human's choice is enforced. `allowedModels` collapses a pinned model
 * to a one-entry list, so "run this mission on haiku" is a ceiling checked in code
 * rather than a preference a model is invited to agree with (§7's ceiling argument,
 * applied to spend instead of to capability).
 */
export class UnavailableModelError extends SynthesisError {
  constructor(taskId: string, requested: string, available: readonly string[]) {
    super(
      taskId,
      `Task '${taskId}' was staffed to run on '${requested}', twice, which is not a ` +
        `model this mission may use. Allowed: ${available.join(", ")}. Staff the task ` +
        `with one of those, or compose the mission with a different model if this work ` +
        `genuinely needs one.`,
    );
    this.name = "UnavailableModelError";
  }
}

/**
 * A mission whose envelope demands a container on a machine that cannot start one
 * (PLAN-NEXT 3.3).
 *
 * Checked once, before the first task is staffed, rather than per spec — because no
 * answer a model gives fixes it. The model cannot install Docker, start a daemon, or
 * pull an image, so quoting the constraint back and re-asking would spend a call to
 * arrive at the same place. It is the `UnavailableTargetError` argument taken to its
 * end: a planning problem the *planner* cannot solve either, which makes it the human's.
 *
 * The alternative is what this exists to prevent: every task staffs cleanly, every
 * dispatch spawns a backend that is not there, each one burns its typed retry, takes a
 * replan with it, and the mission escalates at the reset cap having produced nothing —
 * defect 21, rebuilt one layer down.
 */
export class UnavailableContainmentError extends SynthesisError {
  constructor(missionId: string) {
    super(
      missionId,
      `Mission '${missionId}' has a capability envelope that requires every worker to ` +
        `run inside a container, and this machine has no container backend answering. ` +
        `Start one (\`docker desktop start\`, \`podman machine start\`) and set ` +
        `ORCHESTRA_CONTAINER_IMAGE to an image that has the agent CLI installed, then ` +
        `\`orchestra resume\` — or compose the mission again with containment 'none'. ` +
        `Run 'orchestra doctor' to see which half is missing.`,
    );
    this.name = "UnavailableContainmentError";
  }
}

/** A task in one of these states is history or in flight, and a replan may not
 *  redefine it: running work would be duplicated, and `done` work is evidence. */
const REDEFINABLE = new Set(["waiting", "todo", "blocked", "failed", "cancelled", "conflicted"]);

/**
 * What a spec may run on, resolved once per call to `synthesizeTasks` rather than read
 * off `deps` at each check.
 *
 * Three lists that are read together everywhere and that fall back differently, which is
 * exactly the shape that goes wrong when each is defaulted at its use site: `transports`
 * falls back to the whole registry, `targets` to every target the build knows, and
 * `models` to empty — and empty means *unconstrained*, not *forbidden*, because no menu
 * of `codex` models has been verified (`workers/harness.ts`).
 */
interface RuntimeOffer {
  readonly transports: readonly string[];
  readonly targets: readonly string[];
  readonly models: readonly string[];
  /** Container backends this machine answered for. Empty is *none available*, not
   *  unconstrained — the opposite of `models`, because a backend is a binary that is
   *  either running or is not, and there is nothing unknown about it (PLAN-NEXT 3.3). */
  readonly containment: readonly string[];
}

function runtimeOffer(deps: SynthesizeDeps): RuntimeOffer {
  return {
    transports: deps.transports ?? AVAILABLE_TRANSPORTS,
    targets: deps.targets ?? allowedTargets(builtHarnesses()),
    models: deps.models ?? [],
    containment: deps.containment ?? [],
  };
}

/**
 * Synthesizes an agent for every planned task not already on the board, and emits
 * `task_planned` for each.
 *
 * A planned task whose id already exists is not skipped outright — that was defect
 * 26, and it cost a real mission its whole back half: the replan correctly dropped a
 * failed recon task from `write-summary`'s dependencies, the revision lived only in
 * the ledger, and the scheduler — which reads task records — left the dependents
 * waiting on the failed task through seven empty rounds. So a reused id whose
 * definition changed is *redefined*, via `task_replanned`: edges-only changes keep
 * the already-synthesized agent, a changed goal or worker is re-staffed, and work
 * that is running or done is never touched.
 */
export async function synthesizeTasks(
  deps: SynthesizeDeps,
  planned: readonly PlannedTask[],
  round: number,
): Promise<number> {
  const state = deps.store.state();
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const at = new Date().toISOString();
  let added = 0;

  const runtime = runtimeOffer(deps);

  // Before the first staffing call, because no spec can answer it and every one of them
  // would otherwise be written against a runtime that cannot start (PLAN-NEXT 3.3).
  if (
    state.mission.capabilityEnvelope.containment === "container" &&
    runtime.containment.length === 0
  ) {
    throw new UnavailableContainmentError(state.mission.id);
  }

  for (const entry of planned) {
    const existing = byId.get(entry.id);

    if (existing) {
      if (!REDEFINABLE.has(existing.status)) continue;

      const edgesChanged =
        JSON.stringify([existing.dependsOn, existing.satisfies, existing.motivatedBy]) !==
        JSON.stringify([entry.dependsOn, entry.satisfies, entry.motivatedBy]);
      const coreChanged = existing.goal !== entry.goal || existing.worker !== entry.worker;
      if (!edgesChanged && !coreChanged) continue;

      // Re-staffing is a model call, so an edges-only change keeps the agent it has:
      // the same work with different prerequisites needs no new role.
      const agentSpec = coreChanged
        ? await staff(deps, entry, state.mission.capabilityEnvelope, runtime)
        : existing.agentSpec;

      deps.store.emit({
        missionId: state.mission.id,
        actor: "orchestrator",
        type: "task_replanned",
        taskId: entry.id,
        task: {
          ...existing,
          goal: entry.goal,
          worker: entry.worker,
          satisfies: entry.satisfies,
          motivatedBy: entry.motivatedBy,
          dependsOn: entry.dependsOn,
          agentSpec,
          verify: agentSpec.verify,
          status: entry.dependsOn.length > 0 ? "waiting" : "todo",
          budget: { wallMs: entry.estimatedWallMs },
          updatedAt: at,
          // Artifacts and attempts ride along from `existing` via the spread: the
          // history is the task's, not the definition's.
          ...(coreChanged ? shapeFor(entry.worker, entry.id, round, agentSpec) : {}),
        },
      } as EventInput);
      added++;
      continue;
    }

    const agentSpec = await staff(deps, entry, state.mission.capabilityEnvelope, runtime);

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
  kind:
    | "transport"
    | "target"
    | "model"
    | "capability"
    | "lease"
    | "artifact"
    | "outputPath"
    | "basedOn";
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
  runtime: RuntimeOffer,
): Promise<AgentSpec> {
  const catalogue = resolveClasses(envelope.toolClasses);
  const roles = deps.roles ?? [];
  const index = rosterIndex(roles);
  const cards = modelCardIndex(deps.modelCards ?? []);

  const request = (rejected?: string) =>
    deps.calls.synthesize({
      task,
      envelope,
      toolCatalogue: catalogue,
      transports: [...runtime.transports],
      targets: [...runtime.targets],
      models: [...runtime.models],
      // Omitted rather than sent empty: a prompt carrying "roster: []" spends context
      // telling the model about a library that does not exist.
      ...(index === "" ? {} : { roster: index }),
      ...(cards === "" ? {} : { modelCards: cards }),
      ...(rejected ? { rejected } : {}),
    });

  const first = await request();
  const firstProblem = inspect(first, task, envelope, runtime, catalogue, roles);
  if (!firstProblem) return attach(first, roles);

  const second = await request(firstProblem.retry);
  const problem = inspect(second, task, envelope, runtime, catalogue, roles);
  if (!problem) return attach(second, roles);

  throw raise(deps, task, envelope, problem, runtime);
}

/**
 * Replaces a `basedOn` spec's addendum with the composed prompt, once it has passed
 * every check.
 *
 * This is where the roster stops being a reference and becomes text, and it happens
 * *here* — before `task_planned` is emitted — rather than at dispatch, so the event log
 * carries a complete system prompt exactly as it did when every prompt was authored
 * from scratch. Nothing downstream resolves a role: `workers/prompt.ts`, `fold`, replay
 * and the committed receipt are all untouched by the roster's existence, and a mission
 * is still entirely readable from its own log.
 *
 * `inspect` has already refused an unresolvable name, so a miss here is impossible
 * rather than tolerated — but returning the spec unchanged would ship a one-paragraph
 * addendum as an entire worker prompt, which is the one outcome worth being loud about.
 */
function attach(spec: AgentSpec, roles: readonly OfferedRole[]): AgentSpec {
  if (spec.basedOn === undefined) return spec;

  const role = resolveRole(roles, spec.basedOn);
  if (!role) {
    throw new Error(
      `Role '${spec.basedOn}' passed validation and then did not resolve. This is a ` +
        `bug in synthesize.ts, not in the roster: inspect() and attach() are reading ` +
        `different role lists.`,
    );
  }

  return { ...spec, systemPrompt: composeSystemPrompt(role.body, spec.systemPrompt) };
}

/** Every check a spec has to pass, in the order that makes the retry most useful:
 *  the transport first because it decides whether the task can run at all, then the
 *  capabilities, then the lease. One problem is reported at a time on purpose — a
 *  retry that quotes three constraints teaches none of them well. */
function inspect(
  spec: AgentSpec,
  task: PlannedTask,
  envelope: Envelope,
  runtime: RuntimeOffer,
  catalogue: readonly string[],
  roles: readonly OfferedRole[],
): SpecProblem | undefined {
  if (!runtime.transports.includes(spec.transport.id)) {
    return {
      kind: "transport",
      requested: spec.transport.id,
      retry:
        `The '${spec.transport.id}' transport is not built. Choose one of: ` +
        `${runtime.transports.join(", ")}.`,
    };
  }

  // The target, checked right after the transport because the pair is one decision: a
  // transport that can start and an agent that is not installed fails at exactly the
  // same moment, for exactly the same reason, and used to fail with a spawn error
  // instead of a sentence.
  const target = spec.transport.target;
  if (target === undefined || !runtime.targets.includes(target)) {
    return {
      kind: "target",
      requested: target ?? "(none)",
      retry:
        (target === undefined
          ? `A '${spec.transport.id}' spec must set 'transport.target' to the agent it runs. `
          : `'${target}' is not an agent this mission can run. `) +
        (runtime.targets.length > 0
          ? `Choose one of: ${runtime.targets.join(", ")}.`
          : `No agent is available at all, so this task cannot be staffed as planned.`),
    };
  }

  // The model, and this is the field that had no door at all: a required string that
  // becomes `--model` on a real CLI, written by a model, checked by nothing. An empty
  // allowlist means nothing is *known* rather than nothing is allowed — see
  // `workers/harness.ts` — so an unconstrained mission skips this rather than failing
  // every task.
  if (runtime.models.length > 0 && !runtime.models.includes(spec.model)) {
    return {
      kind: "model",
      requested: spec.model,
      retry:
        `'${spec.model}' is not a model this mission may use. Choose one of: ` +
        `${runtime.models.join(", ")}.` +
        (runtime.models.length === 1
          ? ` The person who composed this mission chose it, so it is not a default to ` +
            `improve on — set 'model' to exactly that.`
          : ``),
    };
  }

  // A `basedOn` naming nothing is the one failure where the *rest* of the spec can be
  // perfect and the worker still gets a prompt nobody wrote: the model has written a
  // short addendum on the assumption that a role's body is coming, and no body is. So
  // it is refused rather than passed through, and the retry quotes the list — a
  // near-miss on a name is the likely mistake and it is cheap to correct.
  if (spec.basedOn !== undefined && !resolveRole(roles, spec.basedOn)) {
    return {
      kind: "basedOn",
      requested: spec.basedOn,
      retry:
        `'${spec.basedOn}' is not a role in the roster, so there is no system prompt to ` +
        `attach to it and what you wrote would be the worker's entire instructions. ` +
        (roles.length > 0
          ? `Use one of these exact names: ${roles.map((role) => role.name).join(", ")}. `
          : `No roster is available on this mission. `) +
        `Or leave 'basedOn' out and write a complete 'systemPrompt' from scratch.`,
    };
  }

  const capability = inspectTools(spec.tools, envelope, catalogue);
  if (capability) return capability;

  const environment = inspectEnv(spec.env ?? [], envelope);
  if (environment) return environment;

  const contained = inspectContainment(spec.containment, envelope);
  if (contained) return contained;

  // Defect 27: the judge reads files on disk (§3), so a judge-verified agent must be
  // able to leave one behind. A rubric about files and a toolset that cannot make one
  // is a task that fails however well the work is done — and it was found exactly that
  // way, on a correctly-answered recon task.
  if (spec.verify.kind === "judge") {
    const writers = new Set(resolveClasses(["fs.write"]));
    if (!spec.tools.some((tool) => writers.has(tool))) {
      return {
        kind: "artifact",
        requested: "a tool that can write the judged artifact",
        retry:
          `This spec verifies by judge, and the judge grades files on disk — but none ` +
          `of the granted tools can write one. Grant a writing tool ` +
          `(${[...writers].join(", ") || "none available under this envelope"}), or ` +
          `verify by 'command', or 'none' with a reason, if the work truly leaves no file.`,
      };
    }
  }

  // P2. A worker with no worktree has exactly one legal place to write — the artifact
  // directory the runtime hands it — because writing into the shared checkout is
  // refused (defect 41) and a rubric may still oblige a file (defect 27). A spec that
  // names somewhere else is that contract broken before the task has started.
  if (spec.outputPath !== undefined && !declaresLegalOutput(spec.outputPath)) {
    return {
      kind: "outputPath",
      requested: spec.outputPath,
      retry:
        `'outputPath' must be relative to the artifact directory this task is given at ` +
        `dispatch — e.g. "report.md" or "findings/summary.md". '${spec.outputPath}' is ` +
        `absolute or leaves that directory. The runtime supplies the directory; the ` +
        `spec names only what goes inside it. Omit the field to write to the directory ` +
        `itself.`,
    };
  }

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

/**
 * The environment half of the same ceiling (defect 42).
 *
 * A separate check from `inspectTools` rather than one more field folded into it,
 * because the sentence a model needs back is different: a denied tool is answered by
 * choosing another tool from the catalogue, and a denied variable cannot be answered by
 * choosing another variable — the work either can be done without it or the envelope is
 * too narrow, which is the human decision `raise` parks on. It reports as `capability`
 * for exactly that reason: same door, same event, same question.
 */
function inspectEnv(requested: readonly string[], envelope: Envelope): SpecProblem | undefined {
  const outside = violations(envelope, { env: [...requested] });
  if (outside.length === 0) return undefined;

  const denied = outside.map((violation) => violation.requested);
  const granted =
    envelope.env.length > 0
      ? `This envelope grants: ${envelope.env.join(", ")}.`
      : `This envelope grants no environment variables at all.`;

  return {
    kind: "capability",
    requested: denied.join(", "),
    retry:
      `These environment variables are not granted by the mission envelope — ` +
      `${denied.join(", ")}. ${granted} A worker is given the variables its transport ` +
      `needs to start and nothing else, so naming one here that the envelope does not ` +
      `list fails validation. Ask for none unless the task genuinely cannot be done ` +
      `without the value, and never put a value in the spec — only names.`,
  };
}

/**
 * The sandbox half of the same ceiling (PLAN-NEXT 3.2), and the only check here that
 * catches a request for *less* rather than more.
 *
 * A spec that sets `containment: "none"` under a mission composed with `"container"` is
 * asking to be let out onto the machine — the same widening as an out-of-envelope tool,
 * arrived at from the other direction, so it goes through the same door and parks on the
 * same human. Reported as `capability` for exactly that reason: same event, same
 * question, same person.
 *
 * Absent is not a request. Almost every spec omits the field, and omitting it means the
 * task runs however the envelope says, which is what makes containment invisible to
 * synthesis on the missions that do not use it.
 */
function inspectContainment(
  requested: AgentSpec["containment"],
  envelope: Envelope,
): SpecProblem | undefined {
  if (requested === undefined) return undefined;
  if (violations(envelope, { containment: requested }).length === 0) return undefined;

  return {
    kind: "capability",
    requested: `containment: ${requested}`,
    retry:
      `This mission runs every worker inside a container, and this spec asked to run ` +
      `outside one. Leave 'containment' out — the mission decides it, and a task cannot ` +
      `opt out of it any more than it can grant itself a tool the envelope withheld. ` +
      `Plan the work to be doable inside the container: the worktree and the artifact ` +
      `directory are mounted at the same paths, and there is no network.`,
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
  runtime: RuntimeOffer,
): SynthesisError {
  if (problem.kind === "transport") {
    return new UnavailableTransportError(task.id, problem.requested, runtime.transports);
  }
  // Both are planning problems, like the lease: the mission can be staffed against what
  // is installed and within what the human chose, and no code path installs a CLI or
  // widens a model choice somebody made on purpose.
  if (problem.kind === "target") {
    return new UnavailableTargetError(task.id, problem.requested, runtime.targets);
  }
  if (problem.kind === "model") {
    return new UnavailableModelError(task.id, problem.requested, runtime.models);
  }
  if (problem.kind === "lease") return new UndeclaredLeaseError(task.id);
  if (problem.kind === "basedOn") return new UnknownRoleError(task.id, problem.requested);
  if (problem.kind === "outputPath") {
    return new ArtifactEscapeError(task.id, problem.requested);
  }
  // A planning problem like the lease: the plan can re-scope the task or change how
  // it is verified, and no human decision is being requested.
  if (problem.kind === "artifact") return new ArtifactToolError(task.id);

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
  return {};
}

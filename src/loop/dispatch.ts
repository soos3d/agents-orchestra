// Turning a Task into events. The gap the roadmap folds silently into "the loop".
//
// Every ingredient already existed as a tested function — createWorktree,
// requestLease, parseWorkerReport, detectEscape, createMergeQueue, run — and nothing
// joined them up. This is the join, and the order matters more than any single step:
//
//   lease → worktree pinned to a base sha → worker → report → commit → escape check →
//   verification → the project's own check → merge → worktree removal → spend
//
// Two of those check the worker rather than the work. The escape check runs *before*
// verification because a worker that wrote outside its lease has already invalidated
// the diff being verified, and the merge runs last because no branch reaches the
// integration branch without passing (§16, "merge only after green").
//
// The commit is defect 30, and it sits where it does for two reasons. It is ahead of
// the escape check so an escaping worker's files are on the branch when the task is
// failed — the comment below promising that "the branch keeps the commits" was not
// true of anything until this existed — and §8 still sees them, because the escape
// check diffs the worktree against its base rather than reading the index. And it is
// ahead of verification so a merge of a green worktree is a merge of green commits;
// verifying committed state is also the only way the thing verified and the thing
// merged are the same thing.
//
// The project's own check (P5) is last before the merge and for the same reason the
// merge is last: a task's `VerifySpec` grades the task, and a task that satisfies its
// own rubric can still break the repository it is about to merge into. Run in the
// worktree, where the commits are and the integration branch is not.
import { taskArtifactDir } from "../config/discover.js";
import { ensurePrivateDir } from "../config/hygiene.js";
import { type Artifact, type VerifySpec } from "../domain/artifacts.js";
import { tokensFrom, type Spend, type TokenUsage } from "../domain/budget.js";
import { isCodeTask, type Task, type TaskStatus } from "../domain/task.js";
import { type Event, type EventInput } from "../events/schema.js";
import { commitWorktree } from "../git/commit.js";
import { changedFiles, readWorkingTree, repoRoot, resolveSha, type WorkingTree } from "../git/repo.js";
import { createWorktree, removeWorktree } from "../git/worktree.js";
import { type MergeQueue } from "../git/mergeQueue.js";
import { detectEscape, requestLease, type Lease } from "../scheduler/leases.js";
import { detectRepoEscape } from "../scheduler/repoEscape.js";
import { redact, type Secret } from "../workers/redact.js";
import { parseWorkerReport, type Reformatter } from "../workers/report.js";
import { type FailureKind } from "./retry.js";
import { type Verifier } from "./verify.js";

export interface WorkerRun {
  /** The worker's final message, unparsed. */
  raw: string;
  elapsedMs: number;
  /** Present only for transports that report usage (§9.5). Its absence is the whole
   *  reason `Spend.tokens.unmeasured` exists. Four numbers rather than one, because
   *  input, output and cached input are priced differently and a total cannot be
   *  taken apart afterwards. */
  usage?: TokenUsage;
  /** Set when the usage came from a source that knows its output figure is a floor —
   *  a session log read after the turn (§9.5). It moves the output count into
   *  `estimated`, so a number is never trusted further than its source. */
  outputIsFloor?: boolean;
  /** The model the transport reports actually having run, when it says. `AgentSpec`
   *  records what was *asked for*, and on ACP the two can differ — the adapter picks
   *  its own model and the log would otherwise name one that never ran. */
  ranOn?: string;
}

export type WorkerTransport = (input: {
  task: Task;
  cwd: string;
  /** The one directory this task may write outputs to, absolute and already created
   *  (P2). Absent when the dispatch was built without an artifact root. */
  artifactDir?: string;
  /** The architect's design note, absolute (PLAN-NEXT 5.2). Absent on a quick mission,
   *  on a mission planned before the architect existed, and when the note could not be
   *  written — `workerPrompt` names it only for a `code` task. */
  designNote?: string;
  signal?: AbortSignal;
}) => Promise<WorkerRun>;

/** Git context. Absent for a mission with no repo, which is a research or computer
 *  mission and a first-class case rather than an error. */
export interface CodeContext {
  repo: string;
  worktreeRoot: string;
  /** The branch task branches merge into. Named explicitly, never "whatever the repo
   *  happens to be on" — that was defect 5. */
  into: string;
  mergeQueue: MergeQueue;
}

export interface DispatchDeps {
  emit(input: EventInput): void;
  transport: WorkerTransport;
  verify: Verifier;
  /** Leases already held, so a dispatch can refuse one that overlaps. */
  held?: readonly Lease[];
  code?: CodeContext;
  /** Where non-code work runs. */
  cwd?: string;
  /**
   * The mission's artifact root — `<stateDir>/missions/<missionId>/artifacts` (P2).
   *
   * A worker with no worktree may not write into the checkout (defect 41) and may
   * still be obliged to leave a file behind (defect 27), so this is the one place it
   * legally can. Created per task, at `0700`, before the worker runs. Absent means the
   * worker is told nothing about a directory and behaves as it did before.
   */
  artifactRoot?: string;
  /**
   * The architect's design note, absolute (PLAN-NEXT 5.2).
   *
   * Read off the folded log by the composition root rather than passed down from prepare,
   * for `artifactRoot`'s reason: a mission planned last night and dispatched this morning
   * has to give its workers the same path, and only the log survives that gap. Absent is a
   * mission with no note, which is every quick one.
   */
  designNote?: string;
  /**
   * The project's own check — `npm test`, `make check` — as a merge gate (P5).
   *
   * `discoverVerifyCommand` has found it since Phase 1 and `doctor` has reported it,
   * and nothing ever ran it: a task's own `VerifySpec` grades the task, and a task
   * that passes its own check can still break the repository it is merging into.
   * Optional because it is discovered rather than configured — absent means no
   * command was found, and inventing `npm test` would fail every mission in a
   * project that does not have one.
   */
  repoVerify?: { command: string; source: string };
  reformat?: Reformatter;
  /**
   * The values of the variables this mission granted, scrubbed out of everything the
   * worker says before any of it is written down (PLAN-NEXT 7.3).
   *
   * Applied to the raw message rather than to the parsed report, and that is the point:
   * the summary, every claim, every artifact path and the text handed to the reformatter
   * are all derived from this one string, so one substitution covers all of them and
   * there is no field somebody forgets to add later. Absent is a mission that granted no
   * variable, which is every mission before `--env`.
   */
  secrets?: readonly Secret[];
  signal?: AbortSignal;
}

export type DispatchOutcome =
  | { status: "done" }
  | { status: "blocked"; message: string }
  | { status: "conflicted"; failure: FailureKind; message: string }
  | { status: "failed"; failure: FailureKind; message: string }
  /** The dispatch never happened, so nothing about the task changed. */
  | { status: "not_dispatched"; message: string };

export async function dispatch(task: Task, deps: DispatchDeps): Promise<DispatchOutcome> {
  const session = createSession(task, deps);

  const refused = await session.prepare();
  if (refused) return refused;

  try {
    return await session.work();
  } catch (error) {
    // A throw anywhere between `running` and the report means the worker delivered
    // nothing usable: spawn failure, disconnect, timeout, or a return value that was
    // still not a WorkerReport after its one reformat. All transport (§9.4).
    await session.cleanup();
    return session.fail("transport", (error as Error).message);
  }
}

interface Session {
  /** Lease and worktree. Runs before the task is marked `running`, because a dispatch
   *  that cannot get its isolation must leave the task exactly as it found it. */
  prepare(): Promise<DispatchOutcome | undefined>;
  work(): Promise<DispatchOutcome>;
  cleanup(): Promise<void>;
  fail(failure: FailureKind, message: string): DispatchOutcome;
}

/**
 * The spec as it goes on the log (PLAN-NEXT 7.3).
 *
 * `runCommand` already scrubs the message it builds when it *refuses* a command, for a
 * stated reason: a criterion whose command was written with a value in it would put that
 * value on the log through the one path that never runs anything. The identical string
 * reached `events.jsonl` on the ordinary path through `verification_run.spec`, every
 * check, run or refused — the scrub was on the output and not on what produced it.
 * Only `command` carries free text a model wrote; the other variants are ids and rubrics.
 */
function loggedSpec(spec: VerifySpec, secrets: readonly Secret[]): VerifySpec {
  if (spec.kind !== "command") return spec;
  return { ...spec, command: redact(spec.command, secrets) };
}

function createSession(task: Task, deps: DispatchDeps): Session {
  let status: TaskStatus = task.status;
  let worktree: string | undefined;
  let baseSha: string | undefined;
  /** The checkout as it was before a worker that has no worktree ran in it. Absent
   *  when the work is isolated, or when the directory is not a repository at all. */
  let shared: { repo: string; before: WorkingTree } | undefined;

  const emit = (event: TaskScopedEvent): void => {
    deps.emit({
      ...event,
      missionId: task.missionId,
      taskId: task.id,
      actor: ACTORS[event.type] ?? "orchestrator",
    } as EventInput);
  };

  const move = (to: TaskStatus, reason: string): void => {
    emit({ type: "task_status", from: status, to, reason });
    status = to;
  };

  const cleanup = async (): Promise<void> => {
    if (!worktree || !deps.code) return;
    const path = worktree;
    worktree = undefined;
    await removeWorktree(deps.code.repo, path);
    emit({ type: "worktree_removed", path });
  };

  // Every failure message goes through one scrub (PLAN-NEXT 7.3). The mainline report is
  // redacted at `run.raw`, and the *exception* path around it was not: a transport error
  // is built from the agent's stderr tail (`acp/transport.ts`), a credentialed CLI that
  // crashes prints what it was holding — a `curl -v` 401 dump quotes the Authorization
  // header — and that message becomes a `task_status`, a `question_asked` and progress
  // evidence. Here rather than at each `fail()` call site, because the next caller added
  // would be the one that forgets.
  const fail = (failure: FailureKind, message: string): DispatchOutcome => {
    const clean = redact(message, deps.secrets ?? []);
    move("failed", clean);
    return { status: "failed", failure, message: clean };
  };

  // The two outcomes that do not go through `fail()`. A merge queue's message is git's
  // own stderr about a tree a credentialed worker just wrote, and it reaches
  // `merge_empty.reason`, a `task_status`, and from `run.ts` a `question_asked` and the
  // progress evidence — every one of them a file a human pastes into a bug report.
  const clean = (message: string): string => redact(message, deps.secrets ?? []);

  const prepare = async (): Promise<DispatchOutcome | undefined> => {
    const owns = isCodeTask(task) ? task.owns : [];

    if (owns.length > 0) {
      const decision = requestLease(deps.held ?? [], task.id, owns);
      if (!decision.granted) {
        emit({ type: "lease_rejected", owns, conflictsWith: decision.conflictsWith });
        return { status: "not_dispatched", message: decision.message };
      }
      emit({ type: "lease_granted", owns });
    }

    if (isCodeTask(task) && deps.code) {
      const { repo, worktreeRoot, into } = deps.code;
      // Pinned here and asserted at merge. Reading HEAD at merge time instead is how
      // two tasks dispatched minutes apart silently get different bases (defect 10).
      baseSha = await resolveSha(repo, into);
      const tree = await createWorktree(repo, worktreeRoot, task.branch, baseSha);
      worktree = tree.path;
      emit({ type: "worktree_created", path: tree.path, branch: tree.branch, baseSha: tree.baseSha });
    }

    return undefined;
  };

  /**
   * Commit what the worker wrote (defect 30).
   *
   * By the runtime rather than by an instruction in the worker's prompt, because a
   * prompt-level rule that the merge silently depends on is not a rule. A worker that
   * committed its own work leaves nothing staged and this is a no-op; a worker that
   * committed nothing gets one commit naming the task.
   *
   * `empty` is not failed here — the branch may still hold the worker's own commits,
   * and whether anything is actually there to merge is the merge's question (defect
   * 31), asked once and in one place.
   */
  const commit = async (): Promise<DispatchOutcome | undefined> => {
    if (!isCodeTask(task) || !worktree) return undefined;

    const outcome = await commitWorktree(worktree, `${task.id}: ${task.goal}`);
    if (outcome.status !== "failed") return undefined;

    // The worktree stays: its contents are the only copy of the work, and a commit
    // that git refused is a machine problem a human fixes rather than a replan.
    return fail("transport", outcome.message);
  };

  /** The second lease check (§8): a declaration is a promise, not a guarantee. */
  const checkLease = async (): Promise<DispatchOutcome | undefined> => {
    if (!isCodeTask(task) || !worktree || !baseSha) return undefined;

    const escape = detectEscape(task.owns, await changedFiles(worktree, baseSha));
    if (!escape.escaped) return undefined;

    emit({ type: "lease_escaped", declared: task.owns, touched: escape.touched });
    await cleanup();
    return fail("lease_escape", escape.message);
  };

  /**
   * The lease check's counterpart for a worker that was never given one (defect 41).
   *
   * It runs in the same slot for the same reason: a worker that edited the shared
   * checkout has invalidated whatever is about to be verified there, since the check
   * would grade uncommitted changes as though they had landed.
   */
  const checkRepo = async (): Promise<DispatchOutcome | undefined> => {
    if (!shared) return undefined;

    const escape = detectRepoEscape(shared.before, await readWorkingTree(shared.repo));
    if (!escape.escaped) return undefined;

    emit({ type: "repo_escaped", worker: task.worker, touched: escape.touched });
    // Nothing is reverted and nothing is cleaned up: the worker's edits are the only
    // record of what it did, and they are sitting in a directory a human owns.
    return fail("repo_escape", escape.message);
  };

  const verify = async (
    cwd: string,
    artifacts: readonly Artifact[],
    evidenceDir?: string,
  ): Promise<DispatchOutcome | undefined> => {
    move("verifying", "worker finished");
    const spec = task.verify;
    const where =
      spec.kind === "command" && spec.cwd === "repo" ? (deps.code?.repo ?? cwd) : cwd;

    const result = await deps.verify(spec, {
      task,
      cwd: where,
      artifacts,
      ...(evidenceDir ? { evidenceDir } : {}),
    });
    emit({
      type: "verification_run",
      spec: loggedSpec(spec, deps.secrets ?? []),
      passed: result.passed,
      output: result.output,
    });
    if (result.passed) return undefined;

    // The worktree goes and the branch stays: a fix task needs those commits, and
    // nothing reaches the integration branch until a check says yes.
    await cleanup();
    return fail("verification", result.output);
  };

  /**
   * The repository's own check, between the task's verification and the merge (P5).
   *
   * A task's `VerifySpec` grades the task. It says nothing about whether the rest of
   * the project still works, and a worker that satisfies its own rubric while breaking
   * a neighbouring test merges anyway — the failure then belongs to whoever comes
   * next. Running it in the *worktree* is what makes it a gate rather than a report:
   * the commits are all there, and nothing has reached the integration branch yet.
   *
   * Code tasks only. A worker with no worktree has nowhere isolated to run it and
   * nothing to merge, so a red repository would fail work that never touched it.
   *
   * Fails as `verification`, which `retryPolicy` already routes to a fix task rather
   * than a blind retry — running the same worker against the same red suite twice
   * teaches nothing.
   */
  const janitor = async (): Promise<DispatchOutcome | undefined> => {
    if (!deps.repoVerify || !isCodeTask(task) || !worktree) return undefined;

    const spec = { kind: "command" as const, command: deps.repoVerify.command };
    const result = await deps.verify(spec, { task, cwd: worktree, artifacts: [] });
    emit({ type: "verification_run", spec, passed: result.passed, output: result.output });
    if (result.passed) return undefined;

    // The branch stays, exactly as it does for the task's own check: a fix task needs
    // those commits, and nothing has reached the integration branch.
    await cleanup();
    return fail(
      "verification",
      `The task's own check passed, but the project's check (${deps.repoVerify.command}, ` +
        `from ${deps.repoVerify.source}) failed in the worktree:\n${result.output}`,
    );
  };

  const merge = async (): Promise<DispatchOutcome | undefined> => {
    if (!isCodeTask(task) || !deps.code || !baseSha) return undefined;
    const { into, mergeQueue } = deps.code;

    emit({ type: "merge_started", branch: task.branch, intoSha: baseSha });
    const outcome = await mergeQueue.merge({
      branch: task.branch,
      into,
      expectedBaseSha: baseSha,
    });

    if (outcome.status === "merged") {
      emit({ type: "merge_completed", branch: outcome.branch, resultSha: outcome.resultSha });
      return undefined;
    }

    // An empty merge is a failure, not a success (defect 31). Nothing landed, so the
    // task did not do its job however green its verification was — and the worktree
    // is deliberately *not* removed, because whatever the worker left there is now
    // the only record of what it did.
    if (outcome.status === "empty") {
      emit({ type: "merge_empty", branch: outcome.branch, reason: clean(outcome.message) });
      return fail("empty_merge", outcome.message);
    }

    // `base_moved` is resolved exactly the way a conflict is — rebase, re-verify,
    // re-queue — so it reports as one, with the difference in the message rather than
    // in a second event type.
    emit({
      type: "merge_conflicted",
      branch: outcome.branch,
      files: outcome.status === "conflicted" ? outcome.files : [],
    });
    await cleanup();
    move("conflicted", clean(outcome.message));
    return { status: "conflicted", failure: "merge_conflict", message: clean(outcome.message) };
  };

  const work = async (): Promise<DispatchOutcome> => {
    const cwd = worktree ?? deps.cwd ?? deps.code?.repo ?? process.cwd();

    // Any worker without a worktree runs in a checkout it shares with the mission, so
    // what it leaves there has to be attributable to it rather than to whatever the
    // human already had uncommitted. Keyed on the absence of a worktree rather than on
    // `worker !== "code"`: a code task that reached dispatch with no code context is in
    // the shared checkout too, and is no more entitled to edit it.
    if (!worktree) {
      const root = await repoRoot(cwd);
      if (root) shared = { repo: root, before: await readWorkingTree(root) };
    }

    // The one directory this task may write outputs to (P2). Under `.orchestra/`,
    // which is gitignored and re-asserted every run, so these writes are invisible to
    // the escape check above by construction.
    //
    // Created eagerly only for a worker that has no worktree, because that worker is
    // *told* about it and a worker told to write somewhere that does not exist writes
    // somewhere else. A code task writes into its worktree and merges; its directory
    // is only where a check's evidence lands, and `keepEvidence` creates it if a check
    // actually produces any.
    const artifactDir = deps.artifactRoot ? taskArtifactDir(deps.artifactRoot, task.id) : undefined;
    if (artifactDir && !worktree) ensurePrivateDir(artifactDir);

    move("running", "dispatched");
    // Emitted before the run rather than after it, so a crash mid-worker still leaves
    // a record that one started. The pid belongs here and arrives when the transport
    // becomes ACP (Phase 7); a subprocess we only see on completion has none to give.
    emit({
      type: "worker_started",
      agentSpec: task.agentSpec,
      transport: task.agentSpec.transport,
    });

    const run = await deps.transport({
      task,
      cwd,
      ...(artifactDir ? { artifactDir } : {}),
      ...(deps.designNote ? { designNote: deps.designNote } : {}),
      signal: deps.signal,
    });
    // Before the parse, before the reformatter, before the event: a granted value in a
    // worker's own message is one `echo` away and this is the last point at which the
    // string is only in memory.
    const report = await parseWorkerReport(redact(run.raw, deps.secrets ?? []), {
      ...(deps.reformat ? { reformat: deps.reformat } : {}),
    });

    emit({ type: "worker_report", report });
    for (const artifact of report.artifacts) emit({ type: "artifact_written", artifact });
    // What it cost, and what produced the cost. The model is recorded rather than
    // assumed from the spec because the two differ on ACP — the adapter picks its own
    // and a mission priced against the spec's would be priced against a model that
    // never ran (a task specced `sonnet` was observed running on `opus`, a 5x error).
    emit({
      type: "spend_recorded",
      phase: task.id,
      spend: spendOf(run),
      ...(run.ranOn === undefined ? {} : { model: run.ranOn }),
    });

    if (report.outcome === "blocked") {
      await cleanup();
      move("blocked", report.summary);
      return { status: "blocked", message: report.summary };
    }

    return (
      (await commit()) ??
      (await checkLease()) ??
      (await checkRepo()) ??
      (await verify(cwd, report.artifacts, artifactDir)) ??
      (report.outcome === "failed"
        ? await cleanup().then(() => fail("worker_failed", report.summary))
        : undefined) ??
      (await janitor()) ??
      (await merge()) ??
      (await cleanup().then(() => {
        move("done", "verified");
        return { status: "done" as const };
      }))
    );
  };

  return { prepare, work, cleanup, fail };
}

/**
 * Everything a dispatch does is scoped to one task, so the mission id, task id, and
 * actor are filled in once rather than at every call site.
 *
 * Distributive, and taken from `Event` rather than from `EventInput`: stripping the
 * fields off an alias that is itself a conditional type collapses the union into one
 * intersected shape, and then no event's own fields typecheck.
 */
type StripScope<T> = T extends unknown
  ? Omit<T, "v" | "seq" | "at" | "missionId" | "taskId" | "actor">
  : never;
type TaskScopedEvent = StripScope<Event>;

/** Who the event is attributable to. Everything else in a dispatch is the
 *  orchestrator acting; these are not. */
const ACTORS: Partial<Record<EventInput["type"], EventInput["actor"]>> = {
  worker_report: "worker",
  artifact_written: "worker",
  worker_heartbeat: "worker",
};

function spendOf(run: WorkerRun): Spend {
  return {
    tokens:
      run.usage === undefined
        ? {
            measured: 0,
            estimated: 0,
            // A transport that reports nothing counts as one unmeasured dispatch,
            // which is what stops a CLI-only mission from reading as ~0 tokens (§9.5).
            unmeasured: 1,
          }
        : tokensFrom(run.usage, { estimatedOutput: run.outputIsFloor === true }),
    wallMs: run.elapsedMs,
    dispatches: 1,
  };
}

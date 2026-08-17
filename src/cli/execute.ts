// What to do with a mission that already exists — the half of `resume` that was
// missing.
//
// `orchestra resume` replayed the log, reconciled orphans, rebuilt the projections,
// and then printed that continuing the loop landed in a phase that had already
// landed. `--plan-only` ends by telling the human to resume, so the command that
// made the promise and the command that broke it shipped together.
//
// The decision is a pure function of folded state, which is what keeps it assertable
// without a model, a worker, or a git repo. Four outcomes, and two of them are
// judgment calls worth naming:
//
//   A plan with no sign-off is the `--plan-only` handoff. Typing `resume` is the
//   human saying go, so that is the sign-off and it is recorded as one (§13).
//
//   `blocked` means two different things. A mission killed by SIGINT parks there
//   with an empty inbox and is exactly what resume exists for; a mission that
//   escalated at the reset cap parks there with an open question and nothing can
//   answer it until Phase 3. The inbox is what tells them apart, so reading the
//   status alone would either strand the first or spin the second.
import { type MissionState } from "../events/fold.js";
import { createMergeQueue } from "../git/mergeQueue.js";
import { currentBranch } from "../git/repo.js";
import { type Calls } from "../loop/calls.js";
import { dispatch, type DispatchDeps, type DispatchOutcome } from "../loop/dispatch.js";
import { resolveCriteriaChange } from "../loop/criteriaChange.js";
import { unattendedHuman, type HumanPort } from "../loop/human.js";
import { presentAndSignOff } from "../loop/prepare.js";
import { runLoop, type LoopDeps, type LoopResult, type MissionStore } from "../loop/run.js";
import { createCriterionChecker, createVerifier } from "../loop/verify.js";
import { grantedSecrets, type Secret } from "../workers/redact.js";
import { type Lease } from "../scheduler/leases.js";
import { type Task } from "../domain/task.js";
import { routeTransport } from "../workers/router.js";
import { createAcpTransport } from "../workers/acp/transport.js";
import { createPermissionPort, type PermissionPort } from "../workers/acp/permissionPort.js";
import { containmentFor } from "../workers/availability.js";
import { staffingOffer } from "../workers/harness.js";
import { createCliReformatter, createCliTransport } from "../workers/transport.js";
import { artifactRoot, loreDir, type DiscoveredConfig } from "../config/discover.js";
import { loadProfiles } from "../memory/profiles.js";
import { staffableCards } from "../providers/modelCard.js";
import { offeredRoles, type OfferedRole } from "../agents/offer.js";
import { loadRoster, localRosterDir, rosterDir } from "../agents/roster.js";
import { recordLearnings } from "../memory/writeBack.js";
import { type Io } from "./main.js";

export type Continuation =
  | { kind: "loop" }
  | { kind: "signoff" }
  // What the change *is* comes from `pendingCriteriaChange` on the fold, which carries
  // the diff whole (§4.0) — the inbox item only carries the reasoning as a summary, and
  // a screen built from it could not render what would change.
  | { kind: "criteriaChange" }
  | { kind: "halted"; message: string; code: number }
  | { kind: "unplanned"; message: string };

export function continuationFor(state: MissionState): Continuation {
  const { mission } = state;

  if (mission.status === "complete") {
    return { kind: "halted", code: 0, message: "already complete — nothing left to run." };
  }

  if (mission.status === "abandoned") {
    return {
      kind: "halted",
      code: 1,
      message:
        "abandoned. The artifacts are intact; start a narrower mission rather than " +
        "resuming this one.",
    };
  }

  // `awaiting_signoff` means two different things, and `signedOffAt` separates them.
  //
  // Criteria freeze at sign-off (§3), so a mission that is *waiting* for sign-off and
  // has already *had* one can only be the mid-mission return: a replan asking to edit
  // a frozen criterion. A mission with no `signedOffAt` has never been approved, so
  // it is the initial screen. Reading the status alone sends both to one place, and
  // the diff screen has nothing to render for a mission that was never signed off.
  //
  // Keyed on the mission rather than on an open inbox item, because the item is how
  // the request is *surfaced* and this is a question about what the mission is. What
  // the change proposes is read from `pendingCriteriaChange` when it is answered.
  // Two questions differ in kind, not in status (PLAN-NEXT 7.2). An escalation demands
  // an answer before the mission may continue; an **advisory** question — what
  // `secret_required` raises — says in its own text that the mission finishes either
  // way, and nothing ever answers it. This gate first read *any* open item as "something
  // is waiting", which stopped a mission told to plan against mocks with its plan already
  // paid for; relaxing it to "a question parks nothing" was not enough either, because
  // `mission.status === "blocked"` is what an API 529, a budget stop and a shutdown also
  // leave behind, so one advisory question held such a mission hostage forever.
  //
  // So `advisory` is read off the question itself, and the other two conditions stay
  // exactly as they were: a question a task is parked on halts, and so does any
  // non-advisory question on a mission that is already `blocked`. That last one is
  // load-bearing rather than redundant — the reset-cap escalation (`loop/run.ts`) blocks
  // every task that is not `done`, which is `[]` when they all are, so `blockedBy` is
  // empty and the status is the only thing that catches it. Gates and permissions are
  // outside the relaxation entirely — a worker is awaiting those.
  const blocking = new Set(Object.values(state.blockedBy));
  const openItem = state.inbox.find(
    (item) =>
      !item.resolvedAt &&
      (item.kind !== "question" ||
        (!item.advisory && (blocking.has(item.id) || mission.status === "blocked"))),
  );

  if (mission.status === "awaiting_signoff") {
    return mission.signedOffAt ? { kind: "criteriaChange" } : { kind: "signoff" };
  }

  // A mission killed mid-intake left its questions open. They are re-asked rather
  // than resumed: the answers were never recorded, and there is nothing to carry on
  // from.
  if (openItem?.kind === "intake") {
    return {
      kind: "unplanned",
      message:
        'intake never finished. Start it again with `orchestra run "<goal>"` — the ' +
        "questions were asked but nothing was answered.",
    };
  }

  if (openItem) {
    return {
      kind: "halted",
      code: 1,
      message: `waiting on a ${openItem.kind}: ${openItem.summary}`,
    };
  }

  // Research is not checkpointed mid-flight, so there is no partial preparation to
  // pick up. Saying so beats silently paying for a second research call.
  if (mission.ledger.plan.length === 0) {
    return {
      kind: "unplanned",
      message:
        'nothing was planned. Start it with `orchestra run "<goal>"` — resume ' +
        "continues a mission that has a plan.",
    };
  }

  return mission.signedOffAt ? { kind: "loop" } : { kind: "signoff" };
}

export interface ExecuteDeps {
  store: MissionStore;
  /** A factory rather than a value: a mission that is already complete, or that never
   *  got a plan, has no decision left to make, and building a model client for it is
   *  work nobody asked for. */
  calls: () => Calls;
  config: DiscoveredConfig;
  io: Io;
  /** Injected so a mission runs against a stub dispatch in tests, and so `run` and
   *  `resume` build identical wiring rather than two that drift. */
  buildLoop?: (
    store: MissionStore,
    calls: Calls,
    config: DiscoveredConfig,
    onWarn?: (message: string) => void,
    /** The human the ACP permission port asks (§12). Passed through rather than read
     *  from a singleton, and passed *here* because a build that gets no human denies
     *  every mid-run request — which is a feature switched off at the composition
     *  root, the shape defects 12b, 23 and 24 all had. */
    human?: HumanPort,
  ) => Promise<LoopDeps>;
  /** Absent means nobody is there, which is what `--unattended` amounts to. */
  human?: HumanPort;
  signal?: AbortSignal;
  /** Only the promotion clock: what a mission writes back to memory is stamped with
   *  it, and a staling policy is not testable against a real one (§6). */
  now?: () => Date;
}

export interface ExecuteResult {
  code: number;
  result?: LoopResult;
}

/** Drives an existing mission to a terminal state, whatever state it is currently in.
 *  Both `run` and `resume` end here, which is what makes them the same mission. */
export async function executeMission(deps: ExecuteDeps): Promise<ExecuteResult> {
  const state = deps.store.state();
  const missionId = state.mission.id;
  const next = continuationFor(state);

  if (next.kind === "halted" || next.kind === "unplanned") {
    deps.io.out(`${missionId}: ${next.message}`);
    return { code: next.kind === "halted" ? next.code : 0 };
  }

  if (next.kind === "criteriaChange") {
    // The mid-mission return (§3), answered rather than announced. This branch used
    // to print that resolving it needed a screen that did not exist and exit 1 —
    // defect 29, a mission parked at a door with nothing behind it, on `run` and
    // `resume` alike. It now falls through to the loop once a human has decided.
    const parked = await settleCriteriaChange(deps, missionId);
    if (parked) return parked;
  }

  const calls = deps.calls();

  if (next.kind === "signoff") {
    // A mission that has a plan and no sign-off: either `--plan-only` handed it over,
    // or the process died while it was waiting. Either way the plan is on disk and
    // the decision has not been made, so it goes back to the human — through the same
    // loop `run` uses, so a mission left overnight is approved by the code path that
    // gets exercised on every attended run.
    const human = deps.human ?? unattendedHuman();
    const outcome = await presentAndSignOff({
      store: deps.store,
      calls,
      human,
      // Sign-off is where the approved plan is staffed, so the profiles have to be
      // here as well as in the loop's replan — wiring only one of the two call sites
      // is how a feature ends up switched off on the path most missions take.
      roles: staffableRoles(deps.config, (message: string) => deps.io.err(message)),
      // And the machine's transports, for the same reason (§7, defect 21): this is
      // where a resumed `--plan-only` mission is staffed, so a mission approved here
      // against the built list would be staffed with a transport nothing can start.
      ...staffingOffer(deps.config, state.mission.runtime, staffableCards(deps.config.stateDir, (message) =>
        deps.io.err(message),
      )),
      unattended: state.mission.unattended,
    });

    if (!outcome.ok) {
      deps.io.err(`${missionId}: ${outcome.reason}`);
      return { code: 1 };
    }
  }

  const build = deps.buildLoop ?? buildLoopDeps;
  const loop = await build(
    deps.store,
    calls,
    deps.config,
    (message) => deps.io.err(message),
    deps.human,
  );

  // The half of §9.4 that was built and unreachable: `runLoop` has always taken a
  // `requestExtension`, and nothing ever supplied one — so every real mission took
  // the "nobody can be asked" branch and parked as though it were unattended. It is
  // wired here rather than in `buildLoopDeps` because the human is an entry-point
  // concern and the loop's runtime is not.
  const asker = deps.human?.requestExtension?.bind(deps.human);
  const runOnce = () =>
    runLoop({
      ...loop,
      ...(asker ? { requestExtension: asker } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });

  let result = await runOnce();

  // The other half of defect 29: `run` never comes back through `continuationFor`, so
  // a reopen raised *mid-loop* has to be settled here or an attended run exits on the
  // park exactly as `resume` did. Not capped separately — every reopen costs a reset,
  // and `maxResets` is what ends a mission that keeps asking (§3).
  while (result.status === "awaiting_signoff") {
    const parked = await settleCriteriaChange(deps, missionId);
    if (parked) return { ...parked, result };
    result = await runOnce();
  }

  // The mission's contribution back to semantic memory (§6), and it happens here
  // because this is the one place `run` and `resume` both end — wired at the entry
  // point rather than left as an optional dep nothing passes, which is how three
  // finished features shipped switched off (defects 12b, 23, 24).
  //
  // Only on `complete`: an abandoned or blocked mission's facts were never carried
  // through to a verified outcome, and §6's cost of a wrong memory is that it biases
  // every future plan without failing loudly.
  if (result.status === "complete") {
    recordLearnings({
      state: deps.store.state(),
      dir: loreDir(deps.config.stateDir),
      now: (deps.now ?? (() => new Date()))(),
      emit: deps.store.emit,
      onWarn: (message) => deps.io.err(message),
    });
  }

  deps.io.out("");
  deps.io.out(`${missionId}: ${result.status} after ${result.rounds} rounds — ${result.reason}`);
  return { code: result.status === "complete" ? 0 : 1, result };
}

/**
 * The mid-mission return to sign-off (§3), settled where both entry points meet it.
 *
 * Returns a result when the mission has to park, and `undefined` when the change was
 * decided and the loop may carry on. Two ways to park, and neither may be softened:
 *
 *   `--unattended` parks rather than approving. A flag that skips reading the plan is
 *   a reasonable trade; one that lets an unwatched mission rewrite the contract it is
 *   judged against is the thing sign-off exists to prevent.
 *
 *   No human at all parks too, and that is why `unattendedHuman()` is deliberately not
 *   the fallback here as it is for sign-off. It approves, which is right for a plan
 *   nobody is there to read and catastrophic for a criteria change: the system would
 *   be approving its own goalposts.
 */
async function settleCriteriaChange(
  deps: ExecuteDeps,
  missionId: string,
): Promise<ExecuteResult | undefined> {
  const state = deps.store.state();
  const pending = state.pendingCriteriaChange;

  deps.io.out(`${missionId}: a replan wants to change a signed-off criterion.`);
  if (pending) deps.io.out(`  ${pending.reasoning}`);

  if (state.mission.unattended || !deps.human) {
    deps.io.out(
      state.mission.unattended
        ? "  Parked: --unattended never approves a change to the contract it skipped " +
            `reading. Answer it with 'orchestra resume ${missionId}' attached to a terminal.`
        : "  Parked: nobody is here to decide. Answer it with " +
            `'orchestra resume ${missionId}' attached to a terminal, or from the dashboard.`,
    );
    return { code: 1 };
  }

  const outcome = await resolveCriteriaChange({ store: deps.store, human: deps.human });
  if (!outcome.ok) {
    deps.io.err(outcome.reason);
    return { code: 1 };
  }

  deps.io.out(
    outcome.approved
      ? "  Approved: the criteria are updated and the mission carries on."
      : "  Rejected: the signed-off criteria stand, recorded as a dead end.",
  );
  return undefined;
}

/**
 * Every role synthesis may staff a task from (§6, §7): the roster that ships with the
 * package, the machine's own additions, and the agents a human promoted from earlier
 * missions — merged, and last source winning on a name collision.
 *
 * Exported because a mission is staffed in two places — at sign-off, and again on
 * every replan — and both entry points have to load them or the feature is finished
 * and switched off on whichever path was missed. That is the shape of defects 12b, 23,
 * and 24, three times over, and it is why `execute.test.ts` and `main.test.ts` each
 * assert the roles reach the call rather than only asserting this function works.
 *
 * An entry nobody can parse is skipped with a warning rather than raising: losing one
 * role must never cost a mission that would otherwise run, and the bundled roster is
 * asserted non-empty by its own test rather than at runtime here.
 */
export function staffableRoles(
  config: Pick<DiscoveredConfig, "stateDir">,
  onWarn?: (message: string) => void,
): OfferedRole[] {
  return offeredRoles(
    loadRoster([rosterDir(), localRosterDir(config.stateDir)], onWarn),
    loadProfiles(config.stateDir, onWarn),
  );
}

/** The runtime a mission needs to actually do work: worktrees, a merge queue, a
 *  worker transport, and the two verifiers. Built once per entry point. */
/**
 * The port a live ACP worker asks through (§12), bound to this mission's log and to
 * whichever surfaces the human has.
 *
 * Exported and built here rather than inside the transport for the reason the header
 * of `permissionPort.ts` gives: there is one writer of `permission_resolved`, and the
 * transport is a consumer of the decision rather than the owner of it. An absent human
 * is not an omission — it is `--unattended`, and the port denies rather than parking a
 * worker on nobody.
 */
export function permissionPortFor(
  store: MissionStore,
  human?: HumanPort,
  onWarn?: (message: string) => void,
  /** The granted values, scrubbed out of the tool call a request quotes (PLAN-NEXT 7.3).
   *  Derived by the caller, which is the one place `process.env` is read for this. */
  secrets: readonly Secret[] = [],
): PermissionPort {
  return createPermissionPort({
    emit: store.emit,
    missionId: store.state().mission.id,
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(human?.askPermission ? { ask: (request) => human.askPermission!(request) } : {}),
    ...(onWarn ? { onWarn } : {}),
  });
}

export async function buildLoopDeps(
  store: MissionStore,
  calls: Calls,
  config: DiscoveredConfig,
  onWarn?: (message: string) => void,
  human?: HumanPort,
): Promise<LoopDeps> {
  const repo = config.repoRoot;
  const code = repo
    ? {
        repo,
        worktreeRoot: config.worktreeRoot,
        into: await currentBranch(repo),
        mergeQueue: createMergeQueue(repo),
      }
    : undefined;

  // Routed rather than wired straight through, so a spec naming a transport this build
  // does not ship gets one message that names the built ids and the fix — instead of
  // the `cli` transport answering for an id it is not (§7, defect 21). One entry today;
  // the ACP transport (Phase 7) is one key.
  // The mid-run half of the human channel (§10, §12): an ACP agent's tool call that its
  // grant does not cover reaches a person through this, and nothing else writes the
  // answer down. Built unconditionally — a port nobody passes is a feature finished and
  // switched off at the same time.
  // The one place a granted value is read (PLAN-NEXT 7.3). `Envelope.env` is names, and
  // the values live in this process's own environment because that is where
  // `buildWorkerEnv` gets them from — so the scrubber's list is derived here, at the
  // composition root that already holds both halves, and handed to every path that
  // writes a worker's words down. Empty on every mission that granted nothing, which
  // makes `redact` an identity.
  const secrets = grantedSecrets(process.env, store.state().mission.capabilityEnvelope.env);

  const permissions = permissionPortFor(store, human, onWarn, secrets);

  // Containment is the mission's, decided from the folded envelope once and handed to
  // both runtimes (PLAN-NEXT 3.2). Both, and not only `cli`: wiring one of them is a
  // sandbox with a door in it, and which door depends on how a model chose to staff a
  // task. `undefined` is a mission composed without containment, which is every mission
  // today; a mission that needs one and cannot have it throws here rather than running.
  const contained = containmentFor(store.state().mission.capabilityEnvelope, config);

  const transport = routeTransport({
    cli: createCliTransport(contained ? { contained } : {}),
    // Phase 7's second key. `requestPermission` is what closes defect 14: ACP's
    // permission channel replaces the blanket `--dangerously-skip-permissions`, and it
    // is only a replacement if the answer comes from a human rather than from a
    // default.
    acp: createAcpTransport({
      requestPermission: (taskId, request) => permissions.requestPermission(taskId, request),
      ...(onWarn ? { onWarn } : {}),
      ...(contained ? { contained } : {}),
    }),
  });
  const verify = createVerifier({ calls, ...(secrets.length > 0 ? { secrets } : {}) });
  // §4.1's one reformat attempt. `dispatch` has always accepted a reformatter and no
  // entry point supplied one, so a worker that answered in prose failed outright
  // instead of being asked once to restate — same shape as the `requestExtension`
  // above, and found the same way, on a mission that actually ran.
  const reformat = createCliReformatter({ cwd: repo ?? config.cwd });

  const roles = staffableRoles(config, onWarn);

  // Where every task's outputs and every criterion's verdict land (P2). Derived from
  // the mission on the log rather than passed in, so `run` and `resume` cannot disagree
  // about where a mission's artifacts live.
  const root = artifactRoot(config.stateDir, store.state().mission.id);

  return {
    store,
    calls,
    cwd: repo ?? config.cwd,
    artifactRoot: root,
    ...(roles.length > 0 ? { roles } : {}),
    // The replan's half of the honest offer (§7). Passed always, including empty: an
    // omitted list would fall back to everything the build ships, which is the exact
    // claim this is here to stop making.
    ...staffingOffer(config, store.state().mission.runtime, staffableCards(config.stateDir, onWarn)),
    checkCriterion: createCriterionChecker({ calls, ...(secrets.length > 0 ? { secrets } : {}) }),
    dispatch: (task: Task, state: MissionState): Promise<DispatchOutcome> =>
      dispatch(
        task,
        dispatchOptionsFor({
          emit: store.emit,
          transport,
          verify,
          reformat,
          held: heldLeases(state),
          ...(secrets.length > 0 ? { secrets } : {}),
          ...(code ? { code } : {}),
          artifactRoot: root,
          cwd: repo ?? config.cwd,
        }, config, state.design),
      ),
  };
}

/**
 * The options a real dispatch runs under, as a function rather than an inline literal.
 *
 * Every optional field on `DispatchDeps` is a place a feature can be finished and
 * switched off at once — `reformat` and `owns` both were, and both surfaced on a
 * mission rather than in the suite (defects 23, 24). This is where the conditional
 * ones are decided, so a test can assert the decision without spawning a worker.
 */
export function dispatchOptionsFor(
  base: DispatchDeps,
  config: Pick<DiscoveredConfig, "verify">,
  /** The architect's design note as the log records it (PLAN-NEXT 5.2), read off the
   *  state the round was folded from rather than remembered from the run that planned —
   *  a mission planned last night and dispatched this morning has to give its workers
   *  the same path. */
  design?: { path: string },
): DispatchDeps {
  return {
    ...base,
    // Conditional for `repoVerify`'s reason, one field along: absent means this mission
    // has no design note — every quick one, and every mission planned before the
    // architect existed — and a worker is then told nothing about one.
    ...(design ? { designNote: design.path } : {}),
    // The project's own check as a merge gate (P5). Spread conditionally rather than
    // passed as `undefined`, and only when one was discovered — `dispatch` skips the
    // gate entirely without it, which is the honest behaviour in a project that has no
    // check to run. Inventing `npm test` would fail every mission in one.
    ...(config.verify ? { repoVerify: config.verify } : {}),
  };
}

const heldLeases = (state: MissionState): Lease[] =>
  Object.entries(state.leases).map(([taskId, owns]) => ({ taskId, owns }));

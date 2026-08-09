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
import { type InboxItem, type MissionState } from "../events/fold.js";
import { createMergeQueue } from "../git/mergeQueue.js";
import { currentBranch } from "../git/repo.js";
import { type Calls } from "../loop/calls.js";
import { dispatch, type DispatchOutcome } from "../loop/dispatch.js";
import { unattendedHuman, type HumanPort } from "../loop/human.js";
import { presentAndSignOff } from "../loop/prepare.js";
import { runLoop, type LoopDeps, type LoopResult, type MissionStore } from "../loop/run.js";
import { createCriterionChecker, createVerifier } from "../loop/verify.js";
import { type Lease } from "../scheduler/leases.js";
import { type AgentSpec, type Task } from "../domain/task.js";
import { createCliReformatter, createCliTransport } from "../workers/transport.js";
import { loreDir, type DiscoveredConfig } from "../config/discover.js";
import { loadProfiles } from "../memory/profiles.js";
import { recordLearnings } from "../memory/writeBack.js";
import { type Io } from "./main.js";

export type Continuation =
  | { kind: "loop" }
  | { kind: "signoff" }
  | { kind: "criteriaChange"; item?: InboxItem }
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
  // the request is *surfaced* and this is a question about what the mission is. The
  // item comes along for the message it carries.
  const openItem = state.inbox.find((item) => !item.resolvedAt);

  if (mission.status === "awaiting_signoff") {
    if (!mission.signedOffAt) return { kind: "signoff" };
    return openItem?.kind === "criteria_change"
      ? { kind: "criteriaChange", item: openItem }
      : { kind: "criteriaChange" };
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
    // The mid-mission return (§3). Rendering the diff and taking the answer is the
    // sign-off screen's job and lands with the shell; until then the mission parks
    // rather than deciding for the human, which is the one thing that must not
    // happen — a system that approves its own criteria change has moved its
    // goalposts and can then legitimately report success.
    deps.io.out(`${missionId}: a replan wants to change a signed-off criterion.`);
    if (next.item) deps.io.out(`  ${next.item.summary}`);
    deps.io.out("  Approving or rejecting it needs the sign-off screen (Phase 3b).");
    return { code: 1 };
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
      profiles: promotedAgents(deps.config, (message) => deps.io.err(message)),
      unattended: state.mission.unattended,
    });

    if (!outcome.ok) {
      deps.io.err(`${missionId}: ${outcome.reason}`);
      return { code: 1 };
    }
  }

  const build = deps.buildLoop ?? buildLoopDeps;
  const loop = await build(deps.store, calls, deps.config, (message) => deps.io.err(message));

  // The half of §9.4 that was built and unreachable: `runLoop` has always taken a
  // `requestExtension`, and nothing ever supplied one — so every real mission took
  // the "nobody can be asked" branch and parked as though it were unattended. It is
  // wired here rather than in `buildLoopDeps` because the human is an entry-point
  // concern and the loop's runtime is not.
  const asker = deps.human?.requestExtension?.bind(deps.human);
  const result = await runLoop({
    ...loop,
    ...(asker ? { requestExtension: asker } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

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
 * Procedural memory as synthesis sees it (§6, §7): the agents a human promoted from
 * earlier missions, as specs.
 *
 * Exported because a mission is staffed in two places — at sign-off, and again on
 * every replan — and both entry points have to load them or the feature is finished
 * and switched off on whichever path was missed. That is the shape of defects 12b, 23,
 * and 24, three times over.
 *
 * A profile nobody can parse is skipped with a warning rather than raising: these are
 * hints, and losing one must never cost a mission that would otherwise run.
 */
export function promotedAgents(
  config: Pick<DiscoveredConfig, "stateDir">,
  onWarn?: (message: string) => void,
): AgentSpec[] {
  return loadProfiles(config.stateDir, onWarn).map((profile) => profile.spec);
}

/** The runtime a mission needs to actually do work: worktrees, a merge queue, a
 *  worker transport, and the two verifiers. Built once per entry point. */
export async function buildLoopDeps(
  store: MissionStore,
  calls: Calls,
  config: DiscoveredConfig,
  onWarn?: (message: string) => void,
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

  const transport = createCliTransport();
  const verify = createVerifier({ calls });
  // §4.1's one reformat attempt. `dispatch` has always accepted a reformatter and no
  // entry point supplied one, so a worker that answered in prose failed outright
  // instead of being asked once to restate — same shape as the `requestExtension`
  // above, and found the same way, on a mission that actually ran.
  const reformat = createCliReformatter({ cwd: repo ?? config.cwd });

  const profiles = promotedAgents(config, onWarn);

  return {
    store,
    calls,
    cwd: repo ?? config.cwd,
    ...(profiles.length > 0 ? { profiles } : {}),
    checkCriterion: createCriterionChecker({ calls }),
    dispatch: (task: Task, state: MissionState): Promise<DispatchOutcome> =>
      dispatch(task, {
        emit: store.emit,
        transport,
        verify,
        reformat,
        held: heldLeases(state),
        ...(code ? { code } : {}),
        cwd: repo ?? config.cwd,
      }),
  };
}

const heldLeases = (state: MissionState): Lease[] =>
  Object.entries(state.leases).map(([taskId, owns]) => ({ taskId, owns }));

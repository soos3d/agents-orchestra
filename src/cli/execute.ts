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
import { dispatch, type DispatchOutcome } from "../loop/dispatch.js";
import { grantSignoff } from "../loop/prepare.js";
import { runLoop, type LoopDeps, type LoopResult, type MissionStore } from "../loop/run.js";
import { createCriterionChecker, createVerifier } from "../loop/verify.js";
import { type Lease } from "../scheduler/leases.js";
import { type Task } from "../domain/task.js";
import { createCliTransport } from "../workers/transport.js";
import { type DiscoveredConfig } from "../config/discover.js";
import { type Io } from "./main.js";

export type Continuation =
  | { kind: "loop" }
  | { kind: "signoff" }
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

  // The only thing after sign-off that blocks the mission (§3), and it blocks on a
  // screen that does not exist yet.
  if (mission.status === "awaiting_signoff") {
    return {
      kind: "halted",
      code: 1,
      message:
        "waiting on a criteria change. Approving one reopens sign-off, which lands " +
        "with the app in Phase 3.",
    };
  }

  const open = state.inbox.find((item) => !item.resolvedAt);
  if (open) {
    return {
      kind: "halted",
      code: 1,
      message: `waiting on a ${open.kind}: ${open.summary}`,
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
  buildLoop?: (store: MissionStore, calls: Calls, config: DiscoveredConfig) => Promise<LoopDeps>;
  signal?: AbortSignal;
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

  const calls = deps.calls();

  if (next.kind === "signoff") {
    // Resuming a `--plan-only` mission is the approval. Recorded as `signoff_granted`
    // like any other, which is why the criteria freeze already applies from here.
    deps.io.out(`${missionId}: signing off on the existing plan and starting work.`);
    await grantSignoff(
      { store: deps.store, calls, unattended: state.mission.unattended },
      state.mission.ledger.plan,
    );
  }

  const build = deps.buildLoop ?? buildLoopDeps;
  const loop = await build(deps.store, calls, deps.config);
  const result = await runLoop({ ...loop, ...(deps.signal ? { signal: deps.signal } : {}) });

  deps.io.out("");
  deps.io.out(`${missionId}: ${result.status} after ${result.rounds} rounds — ${result.reason}`);
  return { code: result.status === "complete" ? 0 : 1, result };
}

/** The runtime a mission needs to actually do work: worktrees, a merge queue, a
 *  worker transport, and the two verifiers. Built once per entry point. */
export async function buildLoopDeps(
  store: MissionStore,
  calls: Calls,
  config: DiscoveredConfig,
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

  return {
    store,
    calls,
    cwd: repo ?? config.cwd,
    checkCriterion: createCriterionChecker({ calls }),
    dispatch: (task: Task, state: MissionState): Promise<DispatchOutcome> =>
      dispatch(task, {
        emit: store.emit,
        transport,
        verify,
        held: heldLeases(state),
        ...(code ? { code } : {}),
        cwd: repo ?? config.cwd,
      }),
  };
}

const heldLeases = (state: MissionState): Lease[] =>
  Object.entries(state.leases).map(([taskId, owns]) => ({ taskId, owns }));

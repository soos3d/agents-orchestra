// `orchestra resume <missionId>` — and the same thing from the browser (UI plan U6).
//
// This used to be a private function inside `main.ts`, which was fine while the only
// way to carry a mission on was to type it. U6's goal is that `orchestra serve` is the
// only command a person runs, and a mission that parks — on a decision point that
// would not answer, on a question asked with nobody watching, on a pause — is exactly
// the case where "no terminal needed" was previously a lie.
//
// So the reconciliation and the continuation live here, and the *surface* is what the
// two entry points differ by: the terminal passes a `HumanPort` and no surface, and
// `serve` passes the lent server it publishes through. That is the same seam
// `runMission` already has, deliberately — a resumed mission and a composed one reach
// the dashboard by one code path, so a fix to one is a fix to both.
//
// The reconciliation half stays separate from the continuation: what to do next is a
// pure function of the state it rebuilds (`continuationFor`), and rebuilding is worth
// reporting even when nothing can be continued.
import { missionDir, type DiscoveredConfig } from "../config/discover.js";
import { fold } from "../events/fold.js";
import { createEventLog } from "../events/log.js";
import { writeProjections } from "../events/projections.js";
import { pruneOrphanWorktrees } from "../git/worktree.js";
import { hasCommitsSince } from "../git/repo.js";
import { isCodeTask, type Task } from "../domain/task.js";
import { spendPhase } from "../domain/budget.js";
import { anyOf, type HumanPort } from "../loop/human.js";
import { createFileStore } from "../loop/store.js";
import { type MissionStore } from "../loop/run.js";
import { liveWorktrees, reconcileOrphans } from "../runtime/resume.js";
import { createWebHuman } from "../web/webHuman.js";
import { executeMission } from "./execute.js";
import { type RunDeps, type RunSurface } from "./runCommand.js";
import { type Io } from "./main.js";

export interface ResumeDeps {
  createCalls: RunDeps["createCalls"];
  /** The terminal's port, when a person is at one. Absent under `serve`, where the
   *  browser is the only surface — and absent on both is a mission that reconciles
   *  and then parks again at whatever it was waiting for, which is honest. */
  human?: HumanPort;
  /** Present when `orchestra serve` resumed this mission: the mission publishes
   *  through the lent server and registers so dashboard messages route to it. */
  surface?: RunSurface;
}

export async function resumeMission(
  missionId: string,
  config: DiscoveredConfig,
  io: Io,
  deps: ResumeDeps,
): Promise<number> {
  const dir = missionDir(config.stateDir, missionId);
  const log = createEventLog(dir);
  const events = log.read();

  if (events.length === 0) {
    io.err(`No mission '${missionId}' under ${config.stateDir}.`);
    return 1;
  }

  const state = fold(events);
  const repo = config.repoRoot;

  const { decisions, events: recorded } = await reconcileOrphans(state, {
    hasCommits: async (task: Task) => {
      if (!repo || !isCodeTask(task) || !task.worktree) return false;
      return hasCommitsSince(task.worktree, task.branch).catch(() => false);
    },
  });

  log.appendAll(recorded);

  // Typing `resume` — or clicking it — is the act that lifts a pause: the flag exists
  // so the *loop* does not carry on, and a human explicitly asking it to carry on is
  // the answer the flag was waiting for. Without this, a paused mission resumes
  // straight back into the park it was just resumed from.
  if (fold(log.read()).paused) {
    log.append({ type: "pause_lifted", missionId, actor: "human", by: "resume" });
  }

  const resumed = fold(log.read());
  writeProjections(dir, resumed);

  if (repo) {
    const pruned = await pruneOrphanWorktrees(repo, config.worktreeRoot, liveWorktrees(resumed));
    for (const removed of pruned.removed) io.out(`pruned orphan worktree ${removed}`);
  }

  io.out(`${missionId}: ${resumed.mission.status}, round ${resumed.mission.round}`);
  for (const decision of decisions) {
    io.out(`  ${decision.taskId}: ${decision.from} → ${decision.to} — ${decision.action}`);
  }
  if (decisions.length === 0) io.out("  no orphaned tasks");
  io.out("");

  // The store re-reads the log it was just written to, so the loop runs against the
  // reconciled state rather than the one this function folded a moment ago.
  const store = createFileStore(dir);

  // Two mechanisms, as in `runMission`: the signal kills what is already running and
  // the `panicked` flag the event sets stops anything else being dispatched.
  const panic = new AbortController();
  const surface = deps.surface;
  const web = surface ? createWebHuman() : undefined;

  const wired: MissionStore = surface
    ? {
        state: store.state,
        emit: (input) => {
          store.emit(input);
          surface.server.publish();
        },
      }
    : store;

  // Either surface may answer; §10's one-inbox rule, one level down — and the reason a
  // mission resumed from the browser is still approvable from the terminal it was
  // resumed alongside.
  const surfaces = [...(deps.human ? [deps.human] : []), ...(web ? [web] : [])];
  const human = surfaces.length > 0 ? anyOf(surfaces) : undefined;

  if (surface && web) {
    surface.register(missionId, { human: web, store: wired, onPanic: () => panic.abort() });
    io.out(`dashboard: ${surface.server.url}`);
    // Carries everything the reconciliation just appended to whatever tabs are open:
    // the registration happened after those emits, so nothing else would push them.
    surface.server.publish();
  }

  try {
    const { code } = await executeMission({
      store: wired,
      config,
      io,
      signal: panic.signal,
      // A resumed mission may be sitting at its own sign-off, so resume needs the same
      // port `run` has — that is the whole reason a mission left overnight is still
      // approvable rather than merely still on disk.
      ...(human ? { human } : {}),
      calls: () =>
        deps.createCalls(config, (call, spend) =>
          wired.emit({
            type: "spend_recorded",
            missionId,
            actor: "orchestrator",
            phase: spendPhase(call),
            spend,
          }),
        ),
    });
    return code;
  } finally {
    // Released, never closed: the server belongs to the serve process and closing it
    // here would take every other mission's dashboard down with this one's exit.
    surface?.release(missionId);
  }
}

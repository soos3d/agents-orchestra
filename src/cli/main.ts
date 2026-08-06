// The command surface. `run` opens the app (§2b) once the loop lands in Phase 2;
// everything here is what works without it.
import path from "node:path";
import { discoverConfig, missionDir, type DiscoveredConfig } from "../config/discover.js";
import { doctor, formatReport } from "../config/doctor.js";
import { ensureGitignored, ensurePrivateDir, forgetMission } from "../config/hygiene.js";
import { createEventLog } from "../events/log.js";
import { fold } from "../events/fold.js";
import { writeProjections } from "../events/projections.js";
import { pruneOrphanWorktrees } from "../git/worktree.js";
import { hasCommitsSince } from "../git/repo.js";
import { liveWorktrees, reconcileOrphans } from "../runtime/resume.js";
import { isCodeTask, type Task } from "../domain/task.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const stdio: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `orchestra — a looping orchestrator for any kind of task

  orchestra doctor                 what is installed, authed, and missing
  orchestra resume <missionId>     replay the log, reconcile orphans, rebuild state
  orchestra forget <missionId>     delete everything a mission wrote
  orchestra run "<goal>"           start a mission`;

/** Applied on every run, never once at init: the line somebody deleted is the case
 *  this exists for (§17). */
function assertHygiene(config: DiscoveredConfig, io: Io): void {
  ensurePrivateDir(config.stateDir);
  if (!config.repoRoot) return;

  const result = ensureGitignored(config.repoRoot, config.stateDir);
  if (result.added) {
    io.err(`Added ${result.entry} to ${path.relative(config.repoRoot, result.file)}.`);
  }
}

async function resume(missionId: string, config: DiscoveredConfig, io: Io): Promise<number> {
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
  io.out("State rebuilt. Continuing the loop lands in Phase 2.");
  return 0;
}

export async function main(argv: readonly string[], io: Io = stdio): Promise<number> {
  const [command, ...rest] = argv;
  const config = await discoverConfig();

  switch (command) {
    case "doctor": {
      const report = doctor(config);
      io.out(formatReport(report));
      return report.ready ? 0 : 1;
    }

    case "forget": {
      const [missionId] = rest;
      if (!missionId) {
        io.err("Usage: orchestra forget <missionId>");
        return 1;
      }
      const result = forgetMission(config.stateDir, missionId);
      io.out(result.removed ? `Deleted ${result.path}` : `Nothing stored for '${missionId}'.`);
      return 0;
    }

    case "resume": {
      const [missionId] = rest;
      if (!missionId) {
        io.err("Usage: orchestra resume <missionId>");
        return 1;
      }
      assertHygiene(config, io);
      return resume(missionId, config, io);
    }

    case "run": {
      assertHygiene(config, io);
      io.err(
        "The mission loop lands in Phase 2. `orchestra doctor` reports readiness today, and\n" +
          "`orchestra resume <missionId>` replays and reconciles an existing mission.",
      );
      return 1;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;

    default:
      io.err(`Unknown command '${command}'.\n\n${USAGE}`);
      return 1;
  }
}

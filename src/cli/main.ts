// The command surface. The app is the primary interface (§2b) and lands in Phase 3;
// everything here is what the terminal does, which stays a supported mode forever
// rather than scaffolding — `--plan-only` is the CI gate and `--unattended` is how a
// trusted recurring mission runs.
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
import { createAgentCalls } from "../loop/agentCalls.js";
import { type HumanPort } from "../loop/human.js";
import { createFileStore } from "../loop/store.js";
import { saveProfile } from "../memory/profiles.js";
import { saveMission } from "../memory/savedMission.js";
import { executeMission } from "./execute.js";
import { parseRunArgs, runMission, type RunDeps } from "./runCommand.js";
import { parseServeArgs, serve } from "./serveCommand.js";
import { createStdinPrompter, createTerminalHuman } from "./terminal.js";

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
  orchestra resume <missionId>     reconcile orphans, then carry the mission on
  orchestra forget <missionId>     delete everything a mission wrote
  orchestra save <missionId> --as <name>
                                   keep the goal, envelope, criteria skeleton, and
                                   intake answers for a recurring job
  orchestra promote <missionId> <taskId> --as <name>
                                   keep a task's synthesized agent as a profile later
                                   missions are offered as prior art
  orchestra run "<goal>"           start a mission
  orchestra serve [--port <n>]     a dashboard that outlives missions: list, watch,
                                   answer, and compose them from the page

  run flags
    --plan-only        research, spec, plan, estimate — then stop. Nothing dispatched.
    --budget <minutes> wall-clock ceiling for the mission (default 240)
    --saved <name>     replay a saved mission. Scan and research run again.
    --unattended       skip sign-off. Requires --saved or --force.`;

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

/** Replay, reconcile, then carry on. The reconciliation half is deliberately kept
 *  separate from the continuation: what to do next is a pure function of the state it
 *  rebuilds (`continuationFor`), and rebuilding is worth reporting even when nothing
 *  can be continued. */
async function resume(
  missionId: string,
  config: DiscoveredConfig,
  io: Io,
  createCalls: RunDeps["createCalls"],
  human?: HumanPort,
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

  // Typing `resume` is the act that lifts a pause: the flag exists so the *loop*
  // does not carry on, and a human explicitly asking it to carry on is the answer
  // the flag was waiting for. Without this, a paused mission resumes straight back
  // into the park it was just resumed from.
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
  const { code } = await executeMission({
    store,
    config,
    io,
    // A resumed mission may be sitting at its own sign-off, so resume needs the same
    // port `run` has — that is the whole reason a mission left overnight is still
    // approvable rather than merely still on disk.
    ...(human ? { human } : {}),
    calls: () =>
      createCalls(config, (spend) =>
        store.emit({
          type: "spend_recorded",
          missionId,
          actor: "orchestrator",
          phase: "orchestration",
          spend,
        }),
      ),
  });
  return code;
}

/**
 * Promote a finished mission to procedural memory (§6, §7).
 *
 * Folds the log rather than reading `mission.json`, for the reason the projections
 * exist at all: they are derived and safe to delete, so a saved mission built off one
 * would be a saved mission a `rm` could silently empty. Every refusal `saveMission`
 * makes is a message rather than a stack trace, because both of them — a name that is
 * a path, a mission nobody signed off — are things a human typed.
 */
function save(missionId: string, name: string, config: DiscoveredConfig, io: Io): number {
  const events = createEventLog(missionDir(config.stateDir, missionId)).read();
  if (events.length === 0) {
    io.err(`No mission '${missionId}' under ${config.stateDir}.`);
    return 1;
  }

  try {
    const file = saveMission(config.stateDir, name, fold(events), new Date().toISOString());
    io.out(`Saved ${file}`);
    io.out(`Replay it with 'orchestra run --saved ${name}'.`);
    return 0;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}

/**
 * Promote one task's synthesized agent to procedural memory (§6, §7).
 *
 * Explicit and human-initiated, and that is the design rather than an unfinished
 * feature: §6 rules out automatic learning, so nothing in the loop calls this. A role
 * worth keeping is one a human watched do the work, and the saved file is markdown they
 * can then edit.
 *
 * Folds the log rather than reading `tasks.json`, for the reason `save` does: a
 * projection is derived and safe to delete, so a profile built off one is a profile a
 * `rm` could silently empty.
 */
function promote(
  missionId: string,
  taskId: string,
  name: string,
  config: DiscoveredConfig,
  io: Io,
): number {
  const events = createEventLog(missionDir(config.stateDir, missionId)).read();
  if (events.length === 0) {
    io.err(`No mission '${missionId}' under ${config.stateDir}.`);
    return 1;
  }

  const state = fold(events);
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    const known = state.tasks.map((candidate) => candidate.id);
    io.err(
      `Mission '${missionId}' has no task '${taskId}'. ` +
        (known.length === 0
          ? "It planned no tasks, so there is no agent to promote."
          : `Promote one of: ${known.join(", ")}.`),
    );
    return 1;
  }

  try {
    const file = saveProfile(config.stateDir, {
      name,
      spec: task.agentSpec,
      promotedFrom: { missionId, taskId },
      promotedAt: new Date().toISOString(),
    });
    io.out(`Promoted ${task.agentSpec.role} to ${file}`);
    io.out("Later missions are offered it as prior art; the envelope still bounds it.");
    return 0;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}

export interface MainDeps {
  /** Injected so the CLI is testable without a model or an API key. */
  createCalls?: RunDeps["createCalls"];
  /** Injected so the CLI is testable without a tty. */
  human?: HumanPort;
}

export async function main(
  argv: readonly string[],
  io: Io = stdio,
  deps: MainDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  const config = await discoverConfig();

  // Resolved once so `run` and `resume` reach the model the same way, and so a test
  // can substitute both with one injection.
  const createCalls: RunDeps["createCalls"] =
    deps.createCalls ??
    ((discovered, onSpend) =>
      createAgentCalls({ config: discovered, onSpend: (_call, spend) => onSpend(spend) }));

  // Built for both `run` and `resume`, because a resumed mission may be sitting at
  // its own sign-off. The prompter opens stdin only if something actually asks, so
  // this costs nothing on `doctor` or an unattended run — but it still gets closed,
  // or a mission that did ask leaves the process holding the terminal.
  const prompter = createStdinPrompter();
  const human = deps.human ?? createTerminalHuman(io, prompter);
  const finish = (code: number): number => {
    prompter.close();
    return code;
  };

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

    case "save": {
      const [missionId] = rest;
      const at = rest.indexOf("--as");
      const name = at === -1 ? undefined : rest[at + 1];
      if (!missionId || missionId.startsWith("--") || !name) {
        io.err("Usage: orchestra save <missionId> --as <name>");
        return 1;
      }
      return save(missionId, name, config, io);
    }

    case "promote": {
      const [missionId, taskId] = rest;
      const at = rest.indexOf("--as");
      const name = at === -1 ? undefined : rest[at + 1];
      if (!missionId || !taskId || missionId.startsWith("--") || taskId.startsWith("--") || !name) {
        io.err("Usage: orchestra promote <missionId> <taskId> --as <name>");
        return 1;
      }
      return promote(missionId, taskId, name, config, io);
    }

    case "resume": {
      const [missionId] = rest;
      if (!missionId) {
        io.err("Usage: orchestra resume <missionId>");
        return 1;
      }
      assertHygiene(config, io);
      return finish(await resume(missionId, config, io, createCalls, human));
    }

    case "run": {
      const parsed = parseRunArgs(rest);
      if (!parsed.ok) {
        io.err(parsed.message);
        return 1;
      }
      assertHygiene(config, io);
      return finish(await runMission(parsed.options, config, io, { createCalls, human }));
    }

    case "serve": {
      const parsed = parseServeArgs(rest);
      if (!parsed.ok) {
        io.err(parsed.message);
        return 1;
      }
      assertHygiene(config, io);
      // Serve runs until Ctrl-C. First SIGINT stops composing and closes the port;
      // a live mission's own drain (§9.6) is downstream of the same signal.
      const stop = new AbortController();
      process.once("SIGINT", () => stop.abort());
      return finish(
        await serve(parsed.options, config, io, { createCalls, signal: stop.signal }),
      );
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

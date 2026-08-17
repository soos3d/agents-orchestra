// The command surface. The app is the primary interface (§2b) and lands in Phase 3;
// everything here is what the terminal does, which stays a supported mode forever
// rather than scaffolding — `--plan-only` is the CI gate and `--unattended` is how a
// trusted recurring mission runs.
import path from "node:path";
import { discoverConfig, missionDir, type DiscoveredConfig } from "../config/discover.js";
import { doctor, formatReport } from "../config/doctor.js";
import { ensureGitignored, ensurePrivateDir, forgetMission } from "../config/hygiene.js";
import { ensureRepoKb } from "../config/kb.js";
import { createEventLog } from "../events/log.js";
import { fold } from "../events/fold.js";
import { missionMetrics, staffingMetrics } from "../events/metrics.js";
import { renderMetrics, renderStaffing } from "./render.js";
import { createAgentCalls } from "../loop/agentCalls.js";
import { createProviderCalls, resolveStaffing, staffedCalls } from "../loop/providerCalls.js";
import { type HumanPort } from "../loop/human.js";
import { resilientCalls, type ResilientCallsDeps } from "../loop/resilience.js";
import { saveProfile } from "../memory/profiles.js";
import {
  loadModelCards,
  localProvidersDir,
  providersDir,
  staffableCards,
} from "../providers/modelCard.js";
import { probeProviders } from "../providers/probe.js";
import { saveMission } from "../memory/savedMission.js";
import { resumeMission } from "./resumeCommand.js";
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
  orchestra metrics <missionId>    what it cost: per decision point, per task
  orchestra run "<goal>"           start a mission
  orchestra serve [--port <n>]     a dashboard that outlives missions: list, watch,
                                   answer, and compose them from the page

  run flags
    --plan-only        research, spec, plan, estimate — then stop. Nothing dispatched.
    --quick            a small job: one light research pass, planned as one task
    --moonshot         the opposite: a second critic round, and the critic reads the
                       design note. Not with --quick.
    --budget <minutes> wall-clock ceiling for the mission (default 240)
    --saved <name>     replay a saved mission. Scan and research run again.
    --unattended       skip sign-off. Requires --saved or --force.
    --harness <id>     how the workers run: <transport>/<agent>, e.g. acp/claude.
                       Defaults to whatever this machine offers — see 'doctor'.
    --worker-model <m> the model workers run on. acp/claude and acp/codex pick their
                       own and ignore this; acp/opencode honours it.
    --orchestrator-model <m>
                       the model the decision points run on, for this mission only
    --staff <pairs>    run named decision points on a verified model card, e.g.
                       --staff research=<card>,plan=<card>. 'orchestra doctor' is what
                       makes a card offerable; judge is not staffable.
    --scan <name>      let this mission's outcome spec gate on a security scanner
                       (deepsec). Off by default: a scan runs an AI agent over the
                       changed files and costs real money per file.
    --env <NAME>       let this mission's workers read one environment variable, by
                       name (repeatable). Without it a mission plans against mocks and
                       asks. The value is read from your shell, never typed here and
                       never written to the log.

  metrics flags
    --json             the same figures as JSON, for diffing two runs
    --staffing         per decision point: the card it ran on, tokens, cost, wall time,
                       and how often its answer was sent back`;

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

/**
 * Promote a finished mission to procedural memory (§6, §7).
 *
 * Folds the log rather than reading `mission.json`, for the reason the projections
 * exist at all: they are derived and safe to delete, so a saved mission built off one
 * would be a saved mission a `rm` could silently empty. Every refusal `saveMission`
 * makes is a message rather than a stack trace, because both of them — a name that is
 * a path, a mission nobody signed off — are things a human typed.
 */
/**
 * What a finished mission cost (§9.5), folded on demand.
 *
 * Read from the log rather than from a projection file, deliberately: a third atomic
 * write on every event would pay, all mission long, for a question nobody asks until
 * the mission is over. `--json` is the form that matters while developing — the point
 * of collecting any of this is diffing two runs of the same goal.
 */
function metrics(
  missionId: string,
  options: { json: boolean; staffing: boolean },
  config: DiscoveredConfig,
  io: Io,
): number {
  const events = createEventLog(missionDir(config.stateDir, missionId)).read();
  if (events.length === 0) {
    io.err(`No mission '${missionId}' under ${config.stateDir}.`);
    return 1;
  }

  const state = fold(events);
  // Priced against the cards this machine has verified: a task that ran on a carded
  // model gets a dollar figure, everything else stays unpriced rather than zero (§9.5).
  const cards = staffableCards(config.stateDir);

  // The evidence half of PLAN-NEXT 4: which decision point ran on which card, what it
  // cost, and how often its answer came back. A separate report rather than four columns
  // added to the mission summary, because it is read while tuning and the summary is read
  // once at the end.
  if (options.staffing) {
    const figures = staffingMetrics(state, events, cards);
    io.out(
      options.json
        ? JSON.stringify(figures, null, 2)
        : renderStaffing(missionId, figures).join("\n"),
    );
    return 0;
  }

  const figures = missionMetrics(state, cards);
  io.out(options.json ? JSON.stringify(figures, null, 2) : renderMetrics(figures).join("\n"));
  return 0;
}

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
  /** §9.4's retry around the decision points, overridable so a test asserting the
   *  wiring does not sit through a real backoff. The defaults are what a run uses. */
  resilience?: ResilientCallsDeps;
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
  //
  // Wrapped in `resilientCalls` here and not inside `createAgentCalls`, because the
  // retry and the typed park are about the *loop's* tolerance for a call that will not
  // answer rather than about how a call is made (§9.4, defect 36) — and keeping them
  // above the seam is what lets a test script a throwing decision point and assert the
  // mission parks. An injected `createCalls` is wrapped too: a test that substitutes
  // the model should still exercise the wiring a real run has.
  //
  // Staffing is resolved here rather than inside either implementation, because this is
  // the one place that holds both halves: the cards this machine probed and the keys
  // `discoverConfig` read. An unresolvable card cannot reach here — `runMission` refuses
  // it before the log opens — so a failure at this point means the two disagree, and
  // falling back to the default model silently is exactly the "finished and switched off
  // at once" shape the optional-`Deps` trap describes. It warns and runs unstaffed
  // instead, which is visible.
  const createCalls: RunDeps["createCalls"] = (discovered, onSpend, staffing, signal) => {
    const base = deps.createCalls
      ? deps.createCalls(discovered, onSpend, staffing, signal)
      : createAgentCalls({ config: discovered, onSpend, ...(signal ? { signal } : {}) });

    const resolved = resolveStaffing(
      staffing ?? {},
      staffableCards(config.stateDir, (message) => io.err(message)),
      config.providerKeys ?? {},
    );
    if (!resolved.ok) io.err(`${resolved.problem} Running every decision point on the orchestrator model.`);

    return resilientCalls(
      resolved.ok
        ? staffedCalls(base, resolved.byCall, (card) =>
            createProviderCalls({
              card,
              apiKey: config.providerKeys?.[card.provider] ?? "",
              config: discovered,
              onSpend,
              ...(signal ? { signal } : {}),
            }),
          )
        : base,
      { onWarn: (message) => io.err(message), ...deps.resilience },
    );
  };

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
      // The probe runs *before* the report, and only here: it is the one command whose
      // job is finding out what works on this machine, and it is the only place a model
      // card becomes offerable (PLAN-NEXT 2.3). A provider with no key is skipped, so on
      // a machine with none this call reaches no network and costs nothing.
      const probed = await probeProviders(
        { stateDir: config.stateDir, keys: config.providerKeys ?? {} },
        loadModelCards([providersDir(), localProvidersDir(config.stateDir)], (message) =>
          io.err(message),
        ),
      );
      for (const outcome of probed) {
        if (!outcome.ok) io.err(`  ${outcome.card.id}: ${outcome.problem}`);
      }

      // And the repository map, for the same reason one line up (PLAN-NEXT 8.1): this is
      // the command whose job is finding out what this machine has, and building the map
      // here is what makes the first mission's research call cheap rather than the one
      // that pays for the walk. `run` builds it too — same function, same HEAD key — so a
      // machine that never runs `doctor` is not a machine without a map.
      await ensureRepoKb(config.stateDir, config.repoRoot, (message) => io.err(message));

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

    case "metrics": {
      const [missionId] = rest;
      if (!missionId || missionId.startsWith("--")) {
        io.err("Usage: orchestra metrics <missionId> [--json]");
        return 1;
      }
      return metrics(
        missionId,
        { json: rest.includes("--json"), staffing: rest.includes("--staffing") },
        config,
        io,
      );
    }

    case "resume": {
      const [missionId] = rest;
      if (!missionId) {
        io.err("Usage: orchestra resume <missionId>");
        return 1;
      }
      assertHygiene(config, io);
      return finish(await resumeMission(missionId, config, io, { createCalls, human }));
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

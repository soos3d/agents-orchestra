// `orchestra serve` — the server that outlives missions (§13).
//
// The per-run server belongs to one mission and dies with it, which is why Phase 3
// could not build the compose screen: composing needs a port that exists *before*
// the mission does. This command owns that port. It serves the registry's listing,
// starts a mission when the page composes one, routes dashboard decisions to the
// live mission's session, and appends answers to parked missions directly — the
// mission a question parked has no loop running to route through.
//
// One composed mission at a time **per workspace** (UI plan U4), stated rather than
// discovered: two live missions in one directory would share a repo checkout and a
// merge queue, and refusing the second compose with a reason is honest where
// interleaving them is a corruption. Two *workspaces* share neither, so the cap is
// per directory — which is the honest generalisation of a limit this file used to
// document as "this command's, not the architecture's". The identity that makes it
// hold is `workspaceId`'s: one real path, one workspace, whatever it was typed as.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { missionDir, type DiscoveredConfig } from "../config/discover.js";
import { doctor, type Check } from "../config/doctor.js";
import { forgetMission } from "../config/hygiene.js";
import {
  configForWorkspace,
  probeWorkspace,
  readWorkspaces,
  resolveWorkspacePath,
  withWorkspace,
  workspaceForRoots,
  workspaceId,
  writeWorkspaces,
  type Workspace,
  type WorkspaceProbe,
} from "../config/workspaces.js";
import { fold } from "../events/fold.js";
import { type MissionStore } from "../loop/run.js";
import { createFileStore } from "../loop/store.js";
import { saveProfile } from "../memory/profiles.js";
import { saveMission } from "../memory/savedMission.js";
import { createMissionRegistry } from "../web/registry.js";
import { staffableCards } from "../providers/modelCard.js";
import { PROGRESS_MODEL } from "../loop/agentCalls.js";
import { availableTransports } from "../workers/availability.js";
import { MODELS_BY_VENDOR, offeredHarnesses, offeredModels } from "../workers/harness.js";
import { REFORMAT_MODEL } from "../workers/transport.js";
import { isOfferedRuntime, isOfferedStaffing, type ClientMessage, type HealthFrame } from "../web/protocol.js";
import { startWebServer, type Handled, type RunningServer } from "../web/server.js";
import { showWork, type ShowRequest, type ShowResult } from "../web/showWork.js";
import { createWebHuman, type WebHuman } from "../web/webHuman.js";
import { resumeMission } from "./resumeCommand.js";
import { handleFromDashboard, runMission, type RunDeps, type RunOptions } from "./runCommand.js";
import { type Io } from "./main.js";

const DEFAULT_BUDGET_MINUTES = 240;

const SERVE_FLAGS = {
  port: { type: "string" },
} as const;

const ORCHESTRATOR_MODELS = MODELS_BY_VENDOR.anthropic;

function healthFrame(
  config: DiscoveredConfig,
  report: { checks: readonly Check[]; ready: boolean },
  cards: readonly { id: string; tier: string; provider: string }[],
): HealthFrame {
  return {
    checks: report.checks,
    ready: report.ready,
    transports: availableTransports(config),
    harnesses: offeredHarnesses(config).map((harness) => ({
      id: harness.id,
      models: offeredModels(harness.id),
      honoursModel: harness.honoursModel,
    })),
    orchestratorModels: ORCHESTRATOR_MODELS,
    orchestratorModel: config.orchestratorModel,
    modelCards: cards.map((card) => ({ id: card.id, tier: card.tier, provider: card.provider })),
    fixedModels: [
      { name: "progress", model: PROGRESS_MODEL },
      { name: "reformat", model: REFORMAT_MODEL },
    ],
  };
}

export interface ServeOptions {
  port?: number;
}

export type ParsedServe = { ok: true; options: ServeOptions } | { ok: false; message: string };

export function parseServeArgs(argv: readonly string[]): ParsedServe {
  let values: { port?: string };
  try {
    ({ values } = parseArgs({ args: [...argv], options: SERVE_FLAGS, allowPositionals: false }));
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    const flag = /'(--?[^'\s]*)/.exec(message ?? "")?.[1] ?? "";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      return { ok: false, message: `Unknown flag '${flag}'. Usage: orchestra serve [--port <n>]` };
    }
    return { ok: false, message: "--port takes a port number, e.g. --port 4600." };
  }
  if (values.port === undefined) return { ok: true, options: {} };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, message: "--port takes a port number, e.g. --port 4600." };
  }
  return { ok: true, options: { port } };
}

interface LiveSession {
  missionId: string;
  human: WebHuman;
  store: MissionStore;
  onPanic: () => void;
}

export interface ServeDeps {
  createCalls: RunDeps["createCalls"];
  /** The mission runner, injectable so the composition root is testable without a
   *  model, a repo, or a worker CLI. Defaults to the real one. */
  run?: typeof runMission;
  /** The resumer, injectable for the same reason (UI plan U6). A resumed mission is
   *  the same wiring as a composed one and differs only in where the plan came from,
   *  so the two are substituted together. */
  resume?: typeof resumeMission;
  /** Resolves the command: serve runs until this aborts (SIGINT in `main`). */
  signal?: AbortSignal;
}

export async function serve(
  options: ServeOptions,
  config: DiscoveredConfig,
  io: Io,
  deps: ServeDeps,
): Promise<number> {
  const registry = createMissionRegistry(config.stateDir, (message) => io.err(message));
  const run = deps.run ?? runMission;
  const resume = deps.resume ?? resumeMission;
  const now = (): Date => new Date();

  // Probed once, at boot: `doctor` reads PATH and the filesystem, and these are facts
  // about the installation rather than about a mission. Re-running it on every publish
  // would spend a syscall storm to report a version number that cannot change while
  // the process is up.
  // The cards this machine has probed ride in the same frame, for the harness menu's
  // reason: the page renders what the server offered and the server refuses what it did
  // not offer (`isOfferedStaffing`).
  const health = healthFrame(
    config,
    doctor(config),
    staffableCards(config.stateDir, (message) => io.err(message)),
  );

  /** One live mission per workspace, keyed by workspace id. */
  const sessions = new Map<string, LiveSession>();
  let server: RunningServer;

  // ── workspaces (UI plan U4) ──
  //
  // The directory serve was launched in is a workspace without being registered:
  // it is what `orchestra serve` has always meant, and persisting it on boot would
  // write to disk on every start to record a fact the cwd already carries.
  const defaultPath = resolveWorkspacePath(config.cwd, config.cwd);
  const defaultWorkspace: Workspace = {
    id: workspaceId(defaultPath),
    path: defaultPath,
    addedAt: now().toISOString(),
  };
  let workspaces = withWorkspace(readWorkspaces(config.stateDir, (m) => io.err(m)), defaultWorkspace);

  // The last probe, and the only path an `workspace_add` may name. Holding it here
  // rather than trusting the page is what makes "you cannot add a workspace you have
  // not been shown" a property of the server instead of a habit of the UI.
  let pending: WorkspaceProbe | null = null;

  // Discovery per workspace, done once. `discoverConfig` was once-per-process; this
  // is the whole of U4 in one map.
  const configs = new Map<string, DiscoveredConfig>([[defaultWorkspace.id, config]]);

  const configFor = async (workspace: Workspace): Promise<DiscoveredConfig> => {
    const hit = configs.get(workspace.id);
    if (hit) return hit;
    const discovered = await configForWorkspace(config, workspace.path);
    configs.set(workspace.id, discovered);
    return discovered;
  };

  const sessionOf = (missionId: string): LiveSession | undefined =>
    [...sessions.values()].find((session) => session.missionId === missionId);

  const workspacesFrame = () => ({
    workspaces,
    pending,
    live: Object.fromEntries([...sessions].map(([id, session]) => [id, session.missionId])),
    defaultId: defaultWorkspace.id,
  });

  /**
   * Which workspace a mission's own envelope scopes it to, or nothing.
   *
   * The `resume` rule, factored because reading a mission's diff needs the same answer:
   * a mission records no workspace, so `fsRoots` is what says where it ran, and matching
   * it against the directories *this* server was shown is how a browser is kept out of
   * choosing a checkout. Two copies of this would be two rules the day one is corrected.
   */
  const workspaceOf = async (fsRoots: readonly string[]): Promise<string | undefined> => {
    const roots = await Promise.all(
      workspaces.map(async (workspace) => {
        const discovered = await configFor(workspace);
        return {
          id: workspace.id,
          roots: [workspace.path, ...(discovered.repoRoot ? [discovered.repoRoot] : [])],
        };
      }),
    );
    return workspaceForRoots(fsRoots, roots);
  };

  /**
   * Reading one thing a mission produced (PLAN-NEXT 9.3).
   *
   * The mission is the socket's, the ids are checked against the log by `showWork`, and
   * the checkout is `workspaceOf`'s — so nothing a browser typed reaches a path, which
   * is the whole of this feature's security argument. A mission scoped to a directory
   * that is not a workspace here gets no repo and `showWork` says so; the evidence files
   * still open, because those live under the state dir this process owns.
   */
  const show = async (
    request: ShowRequest,
    missionId: string | undefined,
  ): Promise<ShowResult> => {
    if (!missionId) return { ok: false, problem: "watch a mission before opening its work." };
    const events = registry.eventsFor(missionId);
    if (events.length === 0) return { ok: false, problem: `no mission '${missionId}'.` };

    const { mission } = fold(events);
    const targetId = await workspaceOf(mission.capabilityEnvelope.fsRoots);
    const workspace = workspaces.find((each) => each.id === targetId);
    const repoRoot = workspace ? (await configFor(workspace)).repoRoot : undefined;
    return showWork(request, { events, ...(repoRoot ? { repoRoot } : {}) });
  };

  const route = async (message: ClientMessage): Promise<Handled> => {
    if (message.kind === "workspace_probe") {
      pending = await probeWorkspace(message.path, config.cwd, config.stateDir, workspaces);
      server.publish();
      return { ok: true };
    }

    if (message.kind === "workspace_add") {
      const resolved = resolveWorkspacePath(message.path, config.cwd);
      // The structural half of "the step with consequences is the step you read":
      // an add may only confirm the resolution the server itself last reported.
      if (!pending || pending.path !== resolved) {
        return {
          ok: false,
          problem: "check the directory first — a workspace is added from a resolution you were shown.",
        };
      }
      if (pending.exists && !pending.isDirectory) {
        return { ok: false, problem: pending.problem ?? `${resolved} is not a directory.` };
      }
      if (!pending.exists) {
        if (!message.create) {
          return { ok: false, problem: `${resolved} does not exist — confirm creating it, or give a directory that does.` };
        }
        try {
          fs.mkdirSync(resolved, { recursive: true });
          io.out(`Created ${resolved}`);
        } catch (error) {
          return { ok: false, problem: `Cannot create ${resolved}: ${(error as Error).message}` };
        }
      }

      workspaces = withWorkspace(workspaces, {
        id: pending.id,
        path: resolved,
        addedAt: now().toISOString(),
      });
      // The default workspace is never persisted (it is the cwd), so it is filtered
      // back out rather than written into a registry that would outlive this process.
      writeWorkspaces(config.stateDir, workspaces.filter((each) => each.id !== defaultWorkspace.id));
      pending = null;
      server.publish();
      return { ok: true };
    }

    if (message.kind === "workspace_forget") {
      if (message.workspaceId === defaultWorkspace.id) {
        return { ok: false, problem: "that is the directory serve was started in — it cannot be removed." };
      }
      const held = sessions.get(message.workspaceId);
      if (held) {
        return { ok: false, problem: `mission ${held.missionId} is running there — panic or let it finish first.` };
      }
      workspaces = workspaces.filter((each) => each.id !== message.workspaceId);
      configs.delete(message.workspaceId);
      writeWorkspaces(config.stateDir, workspaces.filter((each) => each.id !== defaultWorkspace.id));
      server.publish();
      return { ok: true };
    }

    if (message.kind === "compose") {
      const targetId = message.workspaceId ?? defaultWorkspace.id;
      const workspace = workspaces.find((each) => each.id === targetId);
      if (!workspace) {
        return { ok: false, problem: `no workspace '${targetId}' — add the directory first.` };
      }
      const held = sessions.get(targetId);
      if (held) {
        return {
          ok: false,
          problem: `mission ${held.missionId} is already running in ${workspace.path} — one at a time per directory.`,
        };
      }
      // The two boxes are opposite judgments about the same job (PLAN-NEXT 8.2), and
      // the same pair `--quick --moonshot` is refused at parse. Refused here rather
      // than in the schema because a discriminated-union member cannot carry the rule,
      // and refused rather than resolved because whichever one this file picked, half
      // the people ticking both would get the other mission.
      if (message.quick && message.moonshot) {
        return {
          ok: false,
          problem: "quick and moonshot are opposite judgments about the same job — untick one.",
        };
      }

      // You cannot choose a harness you have not been shown — `workspace_add`'s rule,
      // applied to the two strings that decide which binary gets spawned and what
      // `--model` it is handed. Checked against the frame this process computed, so a
      // page that made one up is refused with the offer named rather than obeyed.
      const chosen = {
        ...(message.harness === undefined ? {} : { harness: message.harness }),
        ...(message.workerModel === undefined ? {} : { workerModel: message.workerModel }),
        ...(message.orchestratorModel === undefined
          ? {}
          : { orchestratorModel: message.orchestratorModel }),
      };
      const offered = isOfferedRuntime(health, chosen);
      if (!offered.ok) return offered;

      // The same rule for the card menu (PLAN-NEXT 4.3). A card id decides which provider
      // this process posts a prompt and an API key to, so a browser may only name one the
      // server itself probed and sent.
      const staffed = isOfferedStaffing(health, message.staffing);
      if (!staffed.ok) return staffed;

      const runOptions: RunOptions = {
        goal: message.goal,
        planOnly: message.planOnly,
        quick: message.quick,
        moonshot: message.moonshot,
        unattended: false,
        force: false,
        web: true,
        budgetMinutes: message.budgetMinutes ?? DEFAULT_BUDGET_MINUTES,
        runtime: chosen,
        staffing: message.staffing,
        // No compose control for a specialist gate yet (PLAN-NEXT 6.3): the grant costs
        // real money per file, and a checkbox for it belongs with the compose card's own
        // plan rather than smuggled in behind the harness rows. A browser-composed
        // mission grants none, which is what every mission granted before the flag.
        scanners: [],
        // And no compose control for a credential grant, for the same reason one field
        // along (PLAN-NEXT 7.1): granting a variable hands a live key to a subprocess, a
        // browser is the wrong place to decide that, and a mission that needs one plans
        // against mocks and says so in the inbox. `--env` at the terminal is the door.
        env: [],
        // And no compose control for read-only egress (PLAN-NEXT 11.3), for the reason
        // the two above have none: a browser-composed mission gets the closed research
        // call every mission had before the grant existed, and `--research-web
        // --domain <host>` at the terminal is the door.
        research: "closed",
        domains: [],
      };
      const workspaceConfig = await configFor(workspace);
      // Detached deliberately: compose returns while the mission runs for hours. A
      // rejection here must reach the terminal, not vanish — an unhandled one would
      // kill the serve process and every dashboard with it.
      void run(runOptions, workspaceConfig, io, {
        createCalls: deps.createCalls,
        surface: surfaceFor(targetId),
      })
        .then((code) => io.out(`mission finished (exit ${code})`))
        .catch((error: unknown) => io.err(`mission failed: ${(error as Error).message}`))
        .finally(() => server.publish());
      return { ok: true };
    }

    // Carry a parked mission on (UI plan U6) — the one capability that made "no
    // terminal needed" nearly true rather than true. Which directory it runs in is
    // decided from the mission's own envelope rather than from the message, because a
    // browser choosing a checkout for work already scoped to one is how a mission gets
    // resumed in the wrong repo.
    if (message.kind === "resume") {
      if (sessionOf(message.missionId)) {
        return { ok: false, problem: "that mission is already running." };
      }
      const events = registry.eventsFor(message.missionId);
      if (events.length === 0) return { ok: false, problem: `no mission '${message.missionId}'.` };

      const { mission } = fold(events);
      const targetId = await workspaceOf(mission.capabilityEnvelope.fsRoots);
      if (!targetId) {
        const scope = mission.capabilityEnvelope.fsRoots.join(", ") || "nowhere on this machine";
        return {
          ok: false,
          problem:
            `mission ${message.missionId} is scoped to ${scope}, which is not a workspace here — ` +
            `add that directory, or run 'orchestra resume ${message.missionId}' from inside it.`,
        };
      }
      const held = sessions.get(targetId);
      if (held) {
        return {
          ok: false,
          problem: `mission ${held.missionId} is already running in that directory — one at a time per directory.`,
        };
      }

      const workspace = workspaces.find((each) => each.id === targetId)!;
      const workspaceConfig = await configFor(workspace);
      // Detached for the same reason a compose is: this returns while the mission runs
      // for hours, and an unhandled rejection would take the serve process down.
      void resume(message.missionId, workspaceConfig, io, {
        createCalls: deps.createCalls,
        surface: surfaceFor(targetId),
      })
        .then((code) => io.out(`mission finished (exit ${code})`))
        .catch((error: unknown) => io.err(`resume failed: ${(error as Error).message}`))
        .finally(() => server.publish());
      return { ok: true, note: `Resuming ${message.missionId} in ${workspace.path}.` };
    }

    // Procedural memory from the page (§6, §7). Both fold the log rather than reading a
    // projection, for the reason the CLI does: a projection is derived and safe to
    // delete, so a profile built off one is a profile a `rm` could silently empty.
    if (message.kind === "save" || message.kind === "promote") {
      const events = registry.eventsFor(message.missionId);
      if (events.length === 0) return { ok: false, problem: `no mission '${message.missionId}'.` };
      const state = fold(events);

      try {
        if (message.kind === "save") {
          const file = saveMission(config.stateDir, message.name, state, now().toISOString());
          io.out(`Saved ${file}`);
          return {
            ok: true,
            note: `Saved '${message.name}'. Replay it with 'orchestra run --saved ${message.name}'.`,
          };
        }
        const task = state.tasks.find((candidate) => candidate.id === message.taskId);
        if (!task) {
          const known = state.tasks.map((candidate) => candidate.id);
          return {
            ok: false,
            problem:
              known.length === 0
                ? `mission ${message.missionId} planned no tasks, so there is no agent to promote.`
                : `no task '${message.taskId}' — promote one of: ${known.join(", ")}.`,
          };
        }
        const file = saveProfile(config.stateDir, {
          name: message.name,
          spec: task.agentSpec,
          promotedFrom: { missionId: message.missionId, taskId: message.taskId },
          promotedAt: now().toISOString(),
        });
        io.out(`Promoted ${task.agentSpec.role} to ${file}`);
        return {
          ok: true,
          note: `Promoted ${task.agentSpec.role} as '${message.name}'. Later missions are offered it as prior art; the envelope still bounds it.`,
        };
      } catch (error) {
        // Every refusal both of these make — a name that is really a path, a mission
        // nobody signed off — is something a human typed, so it comes back as a
        // message rather than as a stack trace on the terminal.
        return { ok: false, problem: (error as Error).message };
      }
    }

    if (message.kind === "forget") {
      if (sessionOf(message.missionId)) {
        return { ok: false, problem: "that mission is running — panic or let it finish first." };
      }
      try {
        const result = forgetMission(config.stateDir, message.missionId);
        io.out(result.removed ? `Deleted ${result.path}` : `Nothing stored for '${message.missionId}'.`);
        server.publish();
        return { ok: true };
      } catch (error) {
        return { ok: false, problem: (error as Error).message };
      }
    }

    // A message aimed at a mission that is not live: open its log and append. Safe
    // precisely because it is not live — nothing else holds the writer, and this is
    // how a parked mission's question gets answered (§10).
    const target = "missionId" in message ? message.missionId : undefined;
    const targeted = target === undefined ? undefined : sessionOf(target);
    if (target !== undefined && !targeted) {
      if (registry.eventsFor(target).length === 0) {
        return { ok: false, problem: `no mission '${target}'.` };
      }
      const store = createFileStore(missionDir(config.stateDir, target));
      const result = handleFromDashboard(message, createWebHuman(), store, target, io, () => {});
      server.publish();
      return result;
    }

    // No mission named, so it is aimed at the one running — which is unambiguous
    // only while there is exactly one. Two live workspaces and an unaddressed
    // `panic` is the ambiguity that must be refused rather than guessed at.
    const session = targeted ?? (sessions.size === 1 ? [...sessions.values()][0] : undefined);
    if (!session) {
      return {
        ok: false,
        problem: sessions.size === 0
          ? "no mission is running."
          : "more than one mission is running — say which one.",
      };
    }
    return handleFromDashboard(message, session.human, session.store, session.missionId, io, session.onPanic);
  };

  /** The surface one composed mission publishes through. Built per compose so the
   *  workspace it holds is closed over rather than correlated after the fact: `run`
   *  registers from inside itself, and a second compose must not be able to claim
   *  the first one's registration. */
  const surfaceFor = (workspace: string): RunDeps["surface"] => ({
    // `server` is assigned before any client can compose: startWebServer resolves
    // below, and `register` only ever runs inside a message handler.
    get server() {
      return server;
    },
    register: (missionId, session) => {
      sessions.set(workspace, { missionId, ...session });
      server.publish();
    },
    release: (missionId) => {
      if (sessions.get(workspace)?.missionId === missionId) sessions.delete(workspace);
      server.publish();
    },
  });

  server = await startWebServer({
    registry,
    workspaces: workspacesFrame,
    health: () => health,
    show,
    onMessage: route,
    onWarn: (message) => io.err(message),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });

  io.out(`dashboard: ${server.url}`);
  io.out("serving — compose a mission from the page, Ctrl-C to stop.");

  await new Promise<void>((resolve) => {
    if (deps.signal?.aborted) return resolve();
    deps.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  await server.close();
  return 0;
}

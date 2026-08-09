// `orchestra serve` — the server that outlives missions (§13).
//
// The per-run server belongs to one mission and dies with it, which is why Phase 3
// could not build the compose screen: composing needs a port that exists *before*
// the mission does. This command owns that port. It serves the registry's listing,
// starts a mission when the page composes one, routes dashboard decisions to the
// live mission's session, and appends answers to parked missions directly — the
// mission a question parked has no loop running to route through.
//
// One composed mission at a time, stated rather than discovered: two live missions
// would share one repo checkout and one merge queue, and refusing the second
// compose with a reason is honest where interleaving them is a corruption. The cap
// is this command's, not the architecture's.
import { buildCard } from "../channel/cards.js";
import { type Carrier } from "../channel/carrier.js";
import { createTrust, type BoundIdentity } from "../channel/trust.js";
import { missionDir, type DiscoveredConfig } from "../config/discover.js";
import { forgetMission } from "../config/hygiene.js";
import { type MissionStore } from "../loop/run.js";
import { createFileStore } from "../loop/store.js";
import { createMissionRegistry } from "../web/registry.js";
import { type ClientMessage } from "../web/protocol.js";
import { startWebServer, type RunningServer } from "../web/server.js";
import { createWebHuman, type WebHuman } from "../web/webHuman.js";
import { handleFromDashboard, runMission, type RunDeps, type RunOptions } from "./runCommand.js";
import { type Io } from "./main.js";

const DEFAULT_BUDGET_MINUTES = 240;

export interface ServeOptions {
  port?: number;
}

export type ParsedServe = { ok: true; options: ServeOptions } | { ok: false; message: string };

export function parseServeArgs(argv: readonly string[]): ParsedServe {
  const options: ServeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port") {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { ok: false, message: "--port takes a port number, e.g. --port 4600." };
      }
      options.port = port;
      continue;
    }
    return { ok: false, message: `Unknown flag '${arg}'. Usage: orchestra serve [--port <n>]` };
  }
  return { ok: true, options };
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
  /** The phone mirror, when one is configured (§2, §10). Optional in exactly the
   *  defect-12b sense, which is why the wiring below has its own test: the carrier
   *  delivers, `trust` decides, and no mirror at all is the default. */
  channel?: { carrier: Carrier; identity: BoundIdentity };
  now?: () => Date;
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
  const now = deps.now ?? (() => new Date());

  let live: LiveSession | undefined;
  let server: RunningServer;

  // ── the mirror (§10, §17): the carrier moves cards, the trust store decides ──
  const trust = deps.channel ? createTrust(deps.channel.identity) : undefined;
  const carded = new Set<string>();

  // Open questions on the live mission, carded once each. Questions only until
  // Phase 8 gives gates something to show; the card builder already refuses what
  // may never be mirrored, whatever this loop learns to send.
  const mirror = (): void => {
    if (!deps.channel || !trust || !live) return;
    const { missionId, store } = live;
    for (const item of store.state().inbox) {
      if (item.kind !== "question" || item.resolvedAt || carded.has(item.id)) continue;
      const event = registry
        .eventsFor(missionId)
        .find((e) => e.type === "question_asked" && e.questionId === item.id);
      if (!event) continue;
      carded.add(item.id);
      const built = buildCard(event, trust.issue(item.id, now()).nonce);
      if (!built.ok) {
        io.err(`not mirrored: ${built.reason}`);
        continue;
      }
      deps.channel.carrier
        .publish(built.card)
        .catch((error: unknown) => io.err(`mirror publish failed: ${(error as Error).message}`));
    }
  };

  deps.channel?.carrier.onReply((reply) => {
    const verdict = trust!.validate({ nonce: reply.nonce, senderId: reply.senderId }, now());

    if (verdict.kind === "wrong_sender") {
      // Refused, recorded, and the bound user is told it happened — being told is
      // part of the mitigation (§17), not a courtesy.
      io.err(`refused a carrier reply from unbound sender '${reply.senderId}'.`);
      if (live) {
        live.store.emit({
          type: "envelope_violation",
          missionId: live.missionId,
          actor: "runtime",
          requested: `carrier reply from unbound sender '${reply.senderId}'`,
          envelope: live.store.state().mission.capabilityEnvelope,
        });
      }
      deps.channel!.carrier
        .publish({
          itemId: "violation",
          kind: "notice",
          caption: "A reply from another account was refused. Nothing was approved.",
          nonce: "",
          missionId: live?.missionId ?? "",
        })
        .catch(() => {});
      return;
    }

    if (verdict.kind !== "approved") {
      io.err(`carrier reply ignored: ${verdict.kind}.`);
      return;
    }

    const answer = reply.text?.trim();
    if (!answer || !live) {
      io.err("carrier reply validated but carried no answer text, or nothing is live.");
      return;
    }
    const result = handleFromDashboard(
      { kind: "answer", questionId: verdict.itemId, answer },
      live.human,
      live.store,
      live.missionId,
      io,
      live.onPanic,
    );
    if (!result.ok) io.err(`carrier answer not applied: ${result.problem}`);
    server.publish();
  });

  const route = (message: ClientMessage): { ok: true } | { ok: false; problem: string } => {
    if (message.kind === "compose") {
      if (live) {
        return { ok: false, problem: `mission ${live.missionId} is running — one at a time for now.` };
      }
      const runOptions: RunOptions = {
        goal: message.goal,
        planOnly: false,
        unattended: false,
        force: false,
        web: true,
        budgetMinutes: message.budgetMinutes ?? DEFAULT_BUDGET_MINUTES,
      };
      // Detached deliberately: compose returns while the mission runs for hours. A
      // rejection here must reach the terminal, not vanish — an unhandled one would
      // kill the serve process and every dashboard with it.
      void run(runOptions, config, io, { createCalls: deps.createCalls, surface })
        .then((code) => io.out(`mission finished (exit ${code})`))
        .catch((error: unknown) => io.err(`mission failed: ${(error as Error).message}`))
        .finally(() => server.publish());
      return { ok: true };
    }

    if (message.kind === "forget") {
      if (live?.missionId === message.missionId) {
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

    // A message aimed at a mission that is not the live one: open its log and
    // append. Safe precisely because it is not live — nothing else holds the
    // writer, and this is how a parked mission's question gets answered (§10).
    const target = "missionId" in message ? message.missionId : undefined;
    if (target !== undefined && target !== live?.missionId) {
      if (registry.eventsFor(target).length === 0) {
        return { ok: false, problem: `no mission '${target}'.` };
      }
      const store = createFileStore(missionDir(config.stateDir, target));
      const result = handleFromDashboard(message, createWebHuman(), store, target, io, () => {});
      server.publish();
      return result;
    }

    if (!live) return { ok: false, problem: "no mission is running." };
    return handleFromDashboard(message, live.human, live.store, live.missionId, io, live.onPanic);
  };

  const surface: RunDeps["surface"] = {
    // `server` is assigned before any client can compose: startWebServer resolves
    // below, and `register` only ever runs inside a message handler. The mirror
    // rides every publish, so a question reaches the phone the same moment it
    // reaches the tabs.
    get server() {
      return {
        publish: () => {
          server.publish();
          mirror();
        },
        url: server.url,
      };
    },
    register: (missionId, session) => {
      live = { missionId, ...session };
      server.publish();
      mirror();
    },
    release: (missionId) => {
      if (live?.missionId === missionId) live = undefined;
      server.publish();
    },
  };

  server = await startWebServer({
    registry,
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

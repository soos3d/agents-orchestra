// `orchestra run "<goal>"` — the mission, from the terminal.
//
// The app is the primary interface (§2b) and lands in Phase 3. The terminal is not
// scaffolding to throw away though: `--unattended` keeps it a supported mode forever,
// and `--plan-only` is the CI gate.
//
// Two rules are enforced here rather than left to habit. `--unattended` needs an
// explicit `--force` (§17: it must never become the habitual default), and a rejected
// criterion exits non-zero so a pipeline notices.
import path from "node:path";
import { spendPhase, type Budget, type Spend } from "../domain/budget.js";
import { type Envelope } from "../domain/envelope.js";
import { type Criterion, type PlannedTask } from "../domain/ledger.js";
import { type Estimate, type MissionRuntime } from "../domain/mission.js";
import { type Calls } from "../loop/calls.js";
import { anyOf, type HumanPort } from "../loop/human.js";
import { prepareMission, type PrepareResult } from "../loop/prepare.js";
import { DecisionPointError } from "../loop/resilience.js";
import { createFileStore } from "../loop/store.js";
import { type MissionStore } from "../loop/run.js";
import {
  loreDir,
  missionDir,
  withOrchestratorModel,
  type DiscoveredConfig,
} from "../config/discover.js";
import { readLore } from "../memory/lore.js";
import { loadSavedMission, seedFromSaved, type SavedMission } from "../memory/savedMission.js";
import { staffableCards } from "../providers/modelCard.js";
import { staffingOffer } from "../workers/harness.js";
import { DEFAULT_TOOL_CLASSES } from "../workers/toolCatalogue.js";
import { type ClientMessage } from "../web/protocol.js";
import { startWebServer, type RunningServer } from "../web/server.js";
import { createWebHuman, type WebHuman } from "../web/webHuman.js";
import { executeMission, staffableRoles } from "./execute.js";
import { renderCriteria, renderEstimate, renderPlan } from "./render.js";
import { type Io } from "./main.js";

const DEFAULT_BUDGET_MINUTES = 240;

export interface RunOptions {
  /** Empty is legal only alongside `saved`, whose goal is then the goal. An explicit
   *  one wins, because "same job, different month" is what a replay usually is. */
  goal: string;
  planOnly: boolean;
  /** The human's own judgment that this job is small (UI plan: the compose checkbox,
   *  `--quick` from a terminal). Skips the deep research call and asks the planner for
   *  one task. A hint, never a permission: the outcome-spec gate is unchanged, and a
   *  spec it rejects escalates to the research call that was skipped. */
  quick: boolean;
  unattended: boolean;
  force: boolean;
  /** The saved mission to replay (§7). Scan and research run again regardless. */
  saved?: string;
  /** The dashboard is the primary interface (§2b), so it is on unless asked otherwise.
   *  `--no-web` exists for CI, where binding a port is a nuisance rather than a
   *  feature and nobody is going to open it. */
  web: boolean;
  budgetMinutes: number;
  /** How this mission runs, as chosen by whoever started it (`domain/mission.ts`
   *  `missionRuntimeSchema`). Every field optional: absent is "whatever this machine
   *  offers", which is what every mission did before the choice existed. */
  runtime: MissionRuntime;
}

/** The three flags that take a value and mean one thing each, parsed in one place so
 *  the terminal and the browser reach the same validation. Kept beside the parser
 *  rather than inline, because each needs the same "a flag takes a value" refusal. */
type RuntimeField = "harness" | "workerModel" | "orchestratorModel";

const RUNTIME_FLAGS: Readonly<Record<string, { field: RuntimeField; example: string }>> = {
  "--harness": { field: "harness", example: "--harness acp/claude" },
  "--worker-model": { field: "workerModel", example: "--worker-model haiku" },
  "--orchestrator-model": { field: "orchestratorModel", example: "--orchestrator-model sonnet" },
};

export type ParsedRun = { ok: true; options: RunOptions } | { ok: false; message: string };

export function parseRunArgs(argv: readonly string[]): ParsedRun {
  const goals: string[] = [];
  const flags = new Set<string>();
  let budgetMinutes = DEFAULT_BUDGET_MINUTES;
  let saved: string | undefined;
  const runtime: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const runtimeFlag = RUNTIME_FLAGS[arg];
    if (runtimeFlag) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        return { ok: false, message: `${arg} takes a value, e.g. ${runtimeFlag.example}.` };
      }
      runtime[runtimeFlag.field] = value;
      continue;
    }
    if (arg === "--saved") {
      const name = argv[++i];
      if (!name || name.startsWith("--")) {
        return { ok: false, message: "--saved takes a name, e.g. --saved monthly-reconcile." };
      }
      saved = name;
      continue;
    }
    if (arg === "--budget") {
      const minutes = Number(argv[++i]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { ok: false, message: "--budget takes a number of minutes, e.g. --budget 90." };
      }
      budgetMinutes = minutes;
      continue;
    }
    if (arg.startsWith("--")) {
      flags.add(arg);
      continue;
    }
    goals.push(arg);
  }

  const goal = goals.join(" ").trim();
  // A saved mission carries its own goal, so the positional one becomes an override
  // rather than a requirement.
  if (!goal && saved === undefined) {
    return {
      ok: false,
      message:
        'Usage: orchestra run "<goal>" [--plan-only] [--budget <minutes>] [--saved <name>]',
    };
  }

  const unknown = [...flags].find(
    (flag) => !["--plan-only", "--quick", "--unattended", "--force", "--no-web"].includes(flag),
  );
  if (unknown) return { ok: false, message: `Unknown flag '${unknown}'.` };

  const unattended = flags.has("--unattended");
  // §7 couples the two deliberately: the easy path to skipping sign-off is a mission
  // whose criteria a human already approved and has not edited since. `--force` is
  // still offered, because a first run of something you trust is a real case — it is
  // just the one you have to type out.
  if (unattended && saved === undefined && !flags.has("--force")) {
    return {
      ok: false,
      message:
        "--unattended skips sign-off, so it needs --saved <name> or an explicit --force.\n" +
        "A first run of anything deserves a look at the plan.",
    };
  }

  return {
    ok: true,
    options: {
      goal,
      planOnly: flags.has("--plan-only"),
      quick: flags.has("--quick"),
      unattended,
      force: flags.has("--force"),
      web: !flags.has("--no-web"),
      budgetMinutes,
      runtime,
      ...(saved === undefined ? {} : { saved }),
    },
  };
}

/** Readable, sortable, and unique enough for one machine: the timestamp orders them
 *  and the slug is what a human recognises in `.orchestra/missions/`. */
export function newMissionId(goal: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "mission";
  return `${stamp}-${slug}`;
}

/** The envelope a terminal run declares. The compose screen (§13) is where a human
 *  sets this in Phase 3; until then it is the narrowest thing that can still do code
 *  work — the repo, no network, and no browser. */
export function defaultEnvelope(config: DiscoveredConfig, budget: Budget): Envelope {
  return {
    // From the catalogue rather than written out here, because these classes have to
    // resolve to tools synthesis can actually offer — a class this file invents grants
    // nothing and every task fails validation on a spelling.
    toolClasses: [...DEFAULT_TOOL_CLASSES],
    domains: [],
    fsRoots: [config.repoRoot ?? config.cwd],
    // No mission variables (defect 42). A worker gets the vars its transport needs to
    // start — those live beside the launch in `workers/` — and nothing else until a
    // human names one here, which is the same act as widening any other capability.
    env: [],
    network: "none",
    maxSpend: budget,
    approval: "local",
  };
}

/**
 * A server the mission publishes through but does not own — how `orchestra serve`
 * lends its one port to the missions it composes (§13). `register` is what routes
 * dashboard messages to this mission while it runs; `release` unroutes it. A
 * mission given a surface starts no server of its own and never closes the one it
 * was lent.
 */
export interface RunSurface {
  server: Pick<RunningServer, "publish" | "url">;
  register(
    missionId: string,
    session: { human: WebHuman; store: MissionStore; onPanic: () => void },
  ): void;
  release(missionId: string): void;
}

export interface RunDeps {
  /** `onSpend` is where the measured portion of a mission's cost enters the log.
   *  The loop's own calls are the part actually billed, so they are recorded under
   *  their own phase rather than folded into task spend (§9.5) — and under *which*
   *  call, since `createAgentCalls` knows and a single `"orchestration"` bucket made
   *  the only question worth asking of the number unanswerable. */
  createCalls(config: DiscoveredConfig, onSpend: (call: keyof Calls, spend: Spend) => void): Calls;
  /** Injected so a run is testable without a tty. Absent under `--unattended`, and
   *  absent means nobody is there. */
  human?: HumanPort;
  /** Present when `orchestra serve` composed this mission. */
  surface?: RunSurface;
  now?: () => Date;
}

export async function runMission(
  options: RunOptions,
  config: DiscoveredConfig,
  io: Io,
  deps: RunDeps,
): Promise<number> {
  const now = deps.now ?? (() => new Date());

  // Loaded before anything is written, so a name nobody saved costs a message rather
  // than a mission directory holding one event (§7).
  let saved: SavedMission | undefined;
  if (options.saved !== undefined) {
    try {
      saved = loadSavedMission(config.stateDir, options.saved);
    } catch (error) {
      io.err((error as Error).message);
      return 1;
    }
  }

  const goal = options.goal || saved?.goal || "";
  const missionId = newMissionId(goal, now());
  const dir = missionDir(config.stateDir, missionId);
  const budget: Budget = { wallMs: options.budgetMinutes * 60_000 };

  const store = createFileStore(dir);

  // Every emit pushes to whatever tabs are open. Wrapped rather than built into the
  // store because the store's job is the log, and a store that knew about sockets
  // would be a store that could not be tested without one. `publish` rather than the
  // server itself, because under a surface the server is borrowed: this mission may
  // push through it and must not close it.
  let publish: (() => void) | undefined;
  let ownedServer: RunningServer | undefined;

  // Panic reaches the workers through this, and the loop through the `panicked` flag
  // the event sets. Two mechanisms because they stop different things: the signal
  // kills what is already running, the flag stops anything else being dispatched.
  const panic = new AbortController();

  const wired: MissionStore = {
    state: store.state,
    emit: (input) => {
      store.emit(input);
      publish?.();
    },
  };

  // The mission's own model, not the process's: composed missions in one serve
  // process may each have chosen differently, and `config` is shared between them.
  const calls = deps.createCalls(withOrchestratorModel(config, options.runtime.orchestratorModel), (call, spend) =>
    wired.emit({
      type: "spend_recorded",
      missionId,
      actor: "orchestrator",
      phase: spendPhase(call),
      spend,
    }),
  );

  wired.emit({
    type: "mission_created",
    missionId,
    actor: "human",
    goal,
    // A saved mission's envelope is the one a human already scoped (§7), which is what
    // makes `--unattended --saved` a defensible trade. Its spend ceiling is this run's
    // though: `--budget` is per run, and silently replaying last month's would make
    // the flag a no-op on exactly the missions that use it most.
    envelope: saved
      ? { ...saved.envelope, maxSpend: budget }
      : defaultEnvelope(config, budget),
    budget,
    unattended: options.unattended,
    quick: options.quick,
    // Omitted when nothing was chosen rather than sent empty, so a log reads as "no
    // choice was made" and not as "a choice was made and it was nothing" — the same
    // distinction `roster` draws when it is absent instead of `[]`.
    ...(Object.keys(options.runtime).length > 0 ? { runtime: options.runtime } : {}),
  });

  if (saved) {
    // Answers and criteria enter the ledger before the scan, so intake reads the
    // answers as `known` and research is handed the skeleton to converge on. Both are
    // ordinary mutable ledger state at this point — sign-off has not happened, which
    // is the only reason writing criteria here is legal (§3).
    wired.emit({
      type: "ledger_revised",
      missionId,
      actor: "human",
      ledger: seedFromSaved(wired.state().mission.ledger, saved),
      reason: "saved",
    });
    io.out(`replaying saved mission '${saved.name}' (saved ${saved.savedAt})`);
  }

  io.out(`${missionId}: ${goal}`);

  // `--unattended` is the one flag that removes the human, and it is read per run and
  // never written anywhere (§13, §17): the easy path stays the one where somebody
  // looked at the plan.
  const attended = !options.unattended;

  // No dashboard for `--plan-only` from a terminal: it prints and exits, so a port
  // nobody can reach in time is a port for nothing. It is the CI mode, and CI has no
  // browser.
  //
  // A *composed* plan-only mission is the opposite case and the exception is not a
  // convenience (UI plan U6): the port already exists, and plan-only still runs intake
  // — so a mission with no port would ask its three questions into a process nobody is
  // attached to and hang there until the budget ran out.
  const web =
    attended && options.web && (!options.planOnly || deps.surface !== undefined)
      ? createWebHuman()
      : undefined;

  if (web && deps.surface) {
    // Composed from `orchestra serve`: publish through the lent server, and let the
    // serve process route dashboard messages here for as long as the mission runs.
    publish = deps.surface.server.publish;
    deps.surface.register(missionId, { human: web, store: wired, onPanic: () => panic.abort() });
    io.out(`dashboard: ${deps.surface.server.url}`);
  } else if (web) {
    ownedServer = await startWebServer({
      events: () => store.events(),
      onMessage: (message) =>
        handleFromDashboard(message, web, wired, missionId, io, () => panic.abort()),
      onWarn: (message) => io.err(message),
    });
    publish = ownedServer.publish;
    io.out(`dashboard: ${ownedServer.url}`);
  }

  // Deliberately after `mission_created`, not before: a dashboard registered against
  // an empty log could route an answer into `fold` before the log opens, and an
  // empty log is corruption by rule. The push here is what carries the events
  // emitted before the wiring existed.
  publish?.();

  // Either surface may answer; §10's one-inbox rule, one level down.
  const surfaces = [...(deps.human ? [deps.human] : []), ...(web ? [web] : [])];
  const human = attended && surfaces.length > 0 ? anyOf(surfaces) : undefined;

  // The server outlives every return below, including the failure ones, so it is
  // closed in one place rather than at each exit — a missed one leaves the process
  // holding a port after the mission has finished.
  try {
    const prepared = await prepareOrPark(wired, missionId, () => prepareMission({
      store: wired,
      calls,
      planOnly: options.planOnly,
      unattended: options.unattended,
      ...(human ? { human } : {}),
      // Memory first (§5, §6). Bound here rather than inside `prepareMission`,
      // which never touches disk — and bound unconditionally, because an optional
      // dependency nothing passes is a feature that is finished and switched off at
      // the same time (defects 12b, 23, 24). An absent lore directory is empty
      // memory, which is what the first mission in a repo has.
      recall: () => readLore(loreDir(config.stateDir), now(), (message) => io.err(message)),
      // Procedural memory (§6, §7), bound here for the same reason `recall` is — and
      // at *this* root as well as `executeMission`'s, because `run` staffs its
      // approved plan inside `prepareMission` and `resume` staffs it afterwards. One
      // of the two wired is a feature switched off on the commoner path.
      roles: staffableRoles(config, (message: string) => io.err(message)),
      // What this machine can actually start (§7, defect 21). `run` staffs its
      // approved plan inside `prepareMission`, so the offer has to be here as well as
      // in the loop's replan — one of the two wired is a mission staffed against a
      // transport that cannot spawn, discovered one dispatch at a time.
      ...staffingOffer(config, options.runtime, staffableCards(config.stateDir, (message) =>
        io.err(message),
      )),
      onWarn: (message) => io.err(message),
    }));

    if (!prepared.ok) {
      io.err(prepared.reason);
      for (const rejection of prepared.rejected ?? []) {
        io.err(`  rejected: ${rejection.criterion} — ${rejection.reason}`);
      }
      return 1;
    }

    printPlan(prepared.criteria, prepared.plan, prepared.estimate, io);

    if (options.planOnly) {
      io.out("");
      io.out(`--plan-only: nothing dispatched. Resume with 'orchestra resume ${missionId}'.`);
      return 0;
    }

    // `prepareMission` already signed off and synthesized, so this is the loop and
    // nothing else — the same call `resume` makes, against the same wiring.
    const { code } = await executeMission({
      store: wired,
      calls: () => calls,
      config,
      io,
      signal: panic.signal,
      ...(human ? { human } : {}),
    });
    return code;
  } finally {
    // Own server closed, borrowed one released — never the other way around: a
    // mission that closed the serve process's port would take every other mission's
    // dashboard down with its own exit.
    deps.surface?.release(missionId);
    await ownedServer?.close();
  }
}

/**
 * The pre-sign-off half of defect 36: a decision point that will not answer parks the
 * mission rather than throwing a stack trace out of `main`.
 *
 * `runLoop` owns the same rule for the executing half, and this is the other side of
 * it — research, intake, plan, and the sign-off staffing all happen before the loop
 * exists, and a throttled call there used to kill the process on a mission whose log
 * was perfectly intact. Parking records the failure as a status change, which is what
 * makes the state on disk mean something to `resume` rather than looking like a run
 * that simply stopped mid-sentence.
 *
 * Whether resume can *continue* it depends on how far the mission got —
 * `continuationFor` decides that from the fold, and a mission with no plan is honestly
 * told to start again. Either way the answer comes from state rather than from a
 * crash.
 */
async function prepareOrPark(
  store: MissionStore,
  missionId: string,
  prepare: () => Promise<PrepareResult>,
): Promise<PrepareResult> {
  try {
    return await prepare();
  } catch (error) {
    if (!(error instanceof DecisionPointError)) throw error;

    store.emit({
      type: "mission_status",
      missionId,
      actor: "orchestrator",
      from: store.state().mission.status,
      to: "blocked",
      reason: error.message,
    });

    return {
      ok: false,
      reason:
        `${error.message} Nothing was dispatched. Check 'orchestra doctor' and that you ` +
        `are still logged in, then 'orchestra resume ${missionId}'.`,
    };
  }
}

/**
 * Everything the dashboard can say, routed.
 *
 * Notes and panic are recorded rather than answered: §10's rule is that a note never
 * blocks and never waits for a turn boundary, so the only correct response to one is
 * to write it down and let the loop pick it up. Sign-off and intake are the two that
 * something is actually waiting on, and those go to the port.
 */
export function handleFromDashboard(
  message: ClientMessage,
  human: WebHuman,
  store: MissionStore,
  missionId: string,
  io: Io,
  onPanic: () => void,
): { ok: true } | { ok: false; problem: string } {
  const base = { missionId, actor: "human" as const };

  if (message.kind === "answer") {
    // Resolved against the log, not a port: the question parked its tasks in the
    // fold (§10), so the mission may be sitting `blocked` with no loop running when
    // this arrives. The event is what lifts the park, on resume if necessary.
    const open = store
      .state()
      .inbox.find(
        (item) => item.id === message.questionId && item.kind === "question" && !item.resolvedAt,
      );
    if (!open) return { ok: false, problem: "no open question with that id." };

    store.emit({
      ...base,
      type: "question_answered",
      questionId: message.questionId,
      answer: message.answer,
      ...(open.taskId ? { taskId: open.taskId } : {}),
    });
    // The answer is also a note, so it reaches `factsGiven` and survives replans —
    // §10's rule that an answer enters the ledger, via the machinery that already
    // does exactly that.
    store.emit({
      ...base,
      type: "note_received",
      scope: "global",
      text: `In answer to "${open.summary}": ${message.answer}`,
    });
    return { ok: true };
  }

  if (message.kind === "pause" || message.kind === "unpause") {
    store.emit({
      ...base,
      type: message.kind === "pause" ? "pause_requested" : "pause_lifted",
      by: "dashboard",
    });
    return { ok: true };
  }

  if (message.kind === "note") {
    store.emit({
      ...base,
      type: "note_received",
      scope: message.scope,
      text: message.text,
      ...(message.taskId ? { taskId: message.taskId } : {}),
    });
    return { ok: true };
  }

  if (message.kind === "panic") {
    // Recorded here and acted on by the abort signal the CLI already owns (§9.6).
    // Graceful drain is the wrong response to a worker on the wrong page in a bank,
    // so this is deliberately not `pause`.
    store.emit({ ...base, type: "panic", reason: message.reason, by: "dashboard" });
    io.err(`PANIC requested from the dashboard: ${message.reason}`);
    onPanic();
    return { ok: true };
  }

  // Sign-off, intake, and a live worker's permission request (`resolve`) all have
  // something *awaiting* the answer, so they go to the port rather than to the log.
  // `permission_resolved` is written by the permission port and by nothing else
  // (`workers/acp/permissionPort.ts`): one writer and one settle, or a request that
  // two surfaces answer is recorded twice and the worker is handed two decisions.
  return human.deliver(message)
    ? { ok: true }
    : { ok: false, problem: "nothing is waiting on that right now." };
}

/** What `--plan-only` prints. The same renderers the sign-off screen uses, so the CI
 *  output and the screen a human approves cannot drift apart. */
function printPlan(
  criteria: readonly Criterion[],
  plan: readonly PlannedTask[],
  estimate: Estimate,
  io: Io,
): void {
  for (const line of [
    "",
    ...renderCriteria(criteria),
    ...renderPlan(plan),
    ...renderEstimate(estimate),
  ]) {
    io.out(line);
  }
}

export const missionPath = (config: DiscoveredConfig, missionId: string): string =>
  path.join(config.stateDir, "missions", missionId);

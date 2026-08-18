// `orchestra run "<goal>"` — the mission, from the terminal.
//
// The app is the primary interface (§2b) and lands in Phase 3. The terminal is not
// scaffolding to throw away though: `--unattended` keeps it a supported mode forever,
// and `--plan-only` is the CI gate.
//
// Two rules are enforced here rather than left to habit. `--unattended` needs an
// explicit `--force` (§17: it must never become the habitual default), and a rejected
// criterion exits non-zero so a pipeline notices.
import { parseArgs } from "node:util";
import { spendPhase, type Budget, type Spend } from "../domain/budget.js";
import { hostOf, type Envelope } from "../domain/envelope.js";
import { type Criterion, type PlannedTask } from "../domain/ledger.js";
import {
  staffableCalls,
  type Estimate,
  type MissionRuntime,
  type MissionStaffing,
} from "../domain/mission.js";
import { type Calls } from "../loop/calls.js";
import { anyOf, type HumanPort } from "../loop/human.js";
import { prepareMission, type PrepareResult } from "../loop/prepare.js";
import { DecisionPointError } from "../loop/resilience.js";
import { createFileStore } from "../loop/store.js";
import { type MissionStore } from "../loop/run.js";
import {
  artifactRoot,
  loreDir,
  missionDir,
  withOrchestratorModel,
  type DiscoveredConfig,
} from "../config/discover.js";
import { writeDesignNote } from "../config/hygiene.js";
import { ensureRepoKb } from "../config/kb.js";
import { readLore } from "../memory/lore.js";
import { loadSavedMission, seedFromSaved, type SavedMission } from "../memory/savedMission.js";
import { staffableCards } from "../providers/modelCard.js";
import { resolveStaffing } from "../loop/providerCalls.js";
import { SCANNERS } from "../domain/artifacts.js";
import { availableScanners } from "../workers/availability.js";
import { staffingOffer } from "../workers/harness.js";
import { DEFAULT_TOOL_CLASSES } from "../workers/toolCatalogue.js";
import { type ClientMessage } from "../web/protocol.js";
import { grantedSecrets } from "../workers/redact.js";
import { startWebServer, type RunningServer } from "../web/server.js";
import { showWork } from "../web/showWork.js";
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
  /** The opposite judgment, and a preset over knobs that already exist (PLAN-NEXT 8.2):
   *  the standard passes, a second critic round, and a critic shown the design note.
   *  Grants nothing — every gate and cap is the one a standard mission has. */
  moonshot: boolean;
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
  /** Which decision points run on a model card rather than through the Agent SDK
   *  (`--staff plan=<card>`). Empty is every mission before PLAN-NEXT 4. */
  staffing: MissionStaffing;
  /**
   * Specialist scanners this mission's outcome spec may use as a check
   * (`--scan deepsec`) — PLAN-NEXT 6.3.
   *
   * A grant, and it goes into the envelope rather than into `runtime`, because that is
   * where the expensive human decisions live: a deepsec scan is an AI agent with shell
   * access on this machine and its own documentation puts a large repository at hundreds
   * of dollars. Empty is every mission that did not type the flag, which is the whole of
   * "never default".
   */
  scanners: string[];
  /**
   * Environment variable *names* this mission's workers may be given (`--env STRIPE_KEY`)
   * — PLAN-NEXT 7.1.
   *
   * The human half of the secrets flow, and it is a grant like `--scan`: it goes into
   * the envelope, because `Envelope.env` is already what `buildWorkerEnv` reads and what
   * synthesis checks a spec against (defect 42). Names only — a value typed here would
   * be in the shell history, in `ps`, and one careless log line from the event log, and
   * the value is read from this machine's environment at dispatch instead. Empty is
   * every mission that did not type the flag.
   */
  env: string[];
  /**
   * Whether the `research` decision point may read the web (`--research-web`) —
   * PLAN-NEXT 11.3.
   *
   * A grant like `--scan` and `--env`, and it goes into the envelope for their reason:
   * egress is a human's decision and belongs where the blast-radius decisions live.
   * `"closed"` is every mission that did not type the flag.
   */
  research: Envelope["research"];
  /**
   * Hosts `WebFetch` may reach (`--domain docs.python.org`), the existing
   * `Envelope.domains` a `net.read` worker is already checked against.
   *
   * Empty under a web grant is a real state and not a mistake: search still works and
   * every fetch is denied, which arrives in the inbox as one advisory question naming
   * what to grant next time.
   */
  domains: string[];
}

/**
 * `--staff research=<card>,plan=<card>` — a card id per decision point.
 *
 * Pure and separate from the flag loop because two of its three refusals are the kind a
 * human hits at the terminal and the message is the whole of the fix: a decision point
 * that is not staffable (`judge`, which needs tools a chat completion does not have), and
 * a pair with no `=` in it. The *third* refusal — a card id nobody probed — is not here,
 * because this function has no filesystem: `resolveStaffing` owns it, against the cards
 * this machine actually verified.
 */
export function parseStaff(value: string): { ok: true; staffing: MissionStaffing } | { ok: false; message: string } {
  const staffable = staffableCalls();
  const staffing: Record<string, string> = {};

  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;

    const at = trimmed.indexOf("=");
    const call = at === -1 ? "" : trimmed.slice(0, at).trim();
    const card = at === -1 ? "" : trimmed.slice(at + 1).trim();
    if (!call || !card) {
      return {
        ok: false,
        message: `--staff takes <decision point>=<card id> pairs, e.g. --staff plan=deepseek-ai/DeepSeek-V3. Got '${trimmed}'.`,
      };
    }

    if (!staffable.includes(call as keyof MissionStaffing)) {
      return {
        ok: false,
        message:
          `'${call}' cannot be staffed to a model card — staffable: ${staffable.join(", ")}.` +
          (call === "judge"
            ? ` A judge reads the artifacts it grades with Read, Glob and Grep, and a chat` +
              ` completion has no tools: it would fail correct work and say so honestly.`
            : ``),
      };
    }

    staffing[call] = card;
  }

  return { ok: true, staffing: staffing as MissionStaffing };
}

/** The shape `node:util`'s `parseArgs` is given: the flags this command has, and
 *  nothing about what they mean. Tokenising is the part that was hand-rolled and is not
 *  worth owning — repeatable flags, `--flag=value`, "a flag takes a value" and "that
 *  flag does not exist" are all the platform's, and every refusal below is about a
 *  *value*, which is the half no library can decide. */
const RUN_FLAGS = {
  "plan-only": { type: "boolean" },
  quick: { type: "boolean" },
  moonshot: { type: "boolean" },
  unattended: { type: "boolean" },
  force: { type: "boolean" },
  "no-web": { type: "boolean" },
  staff: { type: "string" },
  harness: { type: "string" },
  "worker-model": { type: "string" },
  "orchestrator-model": { type: "string" },
  scan: { type: "string", multiple: true },
  env: { type: "string", multiple: true },
  "research-web": { type: "boolean" },
  domain: { type: "string", multiple: true },
  saved: { type: "string" },
  budget: { type: "string" },
} as const;

/** The message a flag given no value gets, byte for byte what the hand-rolled loop
 *  said — §2a rule 5: the refusal shows what to type instead. Kept as a table because
 *  `parseArgs` throws one error for all of them and names the flag in its message. */
const VALUE_FLAG_REFUSALS: Readonly<Record<string, string>> = {
  "--staff": "--staff takes pairs, e.g. --staff research=<card>,plan=<card>.",
  "--harness": "--harness takes a value, e.g. --harness acp/claude.",
  "--worker-model": "--worker-model takes a value, e.g. --worker-model haiku.",
  "--orchestrator-model":
    "--orchestrator-model takes a value, e.g. --orchestrator-model sonnet.",
  "--scan": `--scan takes a scanner name, e.g. --scan ${SCANNERS[0]}.`,
  "--env": "--env takes a variable name, e.g. --env STRIPE_KEY.",
  "--domain": "--domain takes a host, e.g. --domain docs.python.org.",
  "--saved": "--saved takes a name, e.g. --saved monthly-reconcile.",
  "--budget": "--budget takes a number of minutes, e.g. --budget 90.",
};

/** `parseArgs` refuses an unknown flag and a valueless one by throwing; both are
 *  refusals a person hits at the terminal, so they are translated back into this
 *  command's own wording rather than surfaced as a Node error with advice about `--`. */
function refusalFor(error: unknown): string {
  const { code, message } = error as { code?: string; message?: string };
  const flag = /'(--?[^'\s]*)/.exec(message ?? "")?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `Unknown flag '${flag}'.`;
  const refusal = VALUE_FLAG_REFUSALS[flag];
  if (refusal) return refusal;
  return `${flag} takes no value — drop the '=' and everything after it.`;
}

export type ParsedRun = { ok: true; options: RunOptions } | { ok: false; message: string };

export function parseRunArgs(argv: readonly string[]): ParsedRun {
  let values: Partial<{
    "plan-only": boolean;
    quick: boolean;
    moonshot: boolean;
    unattended: boolean;
    force: boolean;
    "no-web": boolean;
    staff: string;
    harness: string;
    "worker-model": string;
    "orchestrator-model": string;
    scan: string[];
    env: string[];
    "research-web": boolean;
    domain: string[];
    saved: string;
    budget: string;
  }>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: RUN_FLAGS,
      allowPositionals: true,
    }));
  } catch (error) {
    return { ok: false, message: refusalFor(error) };
  }

  let staffing: MissionStaffing = {};
  if (values.staff !== undefined) {
    if (values.staff.trim() === "") return { ok: false, message: VALUE_FLAG_REFUSALS["--staff"]! };
    const parsed = parseStaff(values.staff);
    if (!parsed.ok) return parsed;
    staffing = parsed.staffing;
  }

  const runtime: Record<string, string> = {
    ...(values.harness === undefined ? {} : { harness: values.harness }),
    ...(values["worker-model"] === undefined ? {} : { workerModel: values["worker-model"] }),
    ...(values["orchestrator-model"] === undefined
      ? {}
      : { orchestratorModel: values["orchestrator-model"] }),
  };

  const scanners = values.scan ?? [];
  // Checked against the names that exist rather than against what is installed: this
  // is a typo check, and whether the binary answers is `orchestra doctor`'s question
  // and `writeOutcomeSpec`'s refusal. Granting a scanner on a machine that cannot run
  // it fails the criterion with a message naming the fix, which is better than a flag
  // that reads as accepted on one machine and rejected on another.
  const unknownScanner = scanners.find(
    (value) => !SCANNERS.includes(value as (typeof SCANNERS)[number]),
  );
  if (unknownScanner !== undefined) {
    return {
      ok: false,
      message: `--scan does not know '${unknownScanner}'. Known scanners: ${SCANNERS.join(", ")}.`,
    };
  }

  const env = values.env ?? [];
  for (const value of env) {
    // The one refusal that matters: a human who types `--env STRIPE_KEY=sk_live_…` has
    // put a live key on the command line, and accepting it would grant a variable
    // literally named `STRIPE_KEY=sk_live_…` — nothing, granted, with the key now in
    // the shell history and in `mission_created`. Refused with the rule named.
    // A pasted *value* is the other half of the same slip and the more dangerous one:
    // `--env sk_live_…` has no `=`, so it would be accepted as a variable name, written
    // into `mission_created.capabilityEnvelope.env` and onto the sign-off screen — and
    // `grantedSecrets` would find no variable by that name, so nothing could ever scrub
    // it. A POSIX name is what an environment variable is; anything else is refused,
    // truncated in the message.
    if (!value.includes("=") && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      return {
        ok: false,
        message:
          `--env takes a variable name like STRIPE_KEY. '${value.slice(0, 8)}…' is not ` +
          `one — if that is the key itself, export it in your shell and pass the name.`,
      };
    }
    if (value.includes("=")) {
      // Truncated to the same 8 characters as the branch above, and not to the `=`.
      // A base64 credential ends in `=`, so `indexOf("=")` is its last character and
      // the untruncated message would print the whole key to stderr — twice — in the
      // one error whose entire purpose is that the key was typed where it should not
      // have been.
      const head = value.slice(0, Math.min(8, value.indexOf("=")));
      return {
        ok: false,
        message:
          `--env takes a name, never a value. Got '${head}…=…'. ` +
          `Export the variable in your shell and pass just the name: --env ${head}….`,
      };
    }
  }

  const domains = values.domain ?? [];
  for (const value of domains) {
    // Exact hosts, `envelopeSchema.domains`' rule: an allowlist that accepts patterns
    // eventually holds one too broad to mean anything, approved by a human who read it
    // as specific. A URL is the likelier slip and is refused with the host to type
    // instead — `allowedFetchHost` compares hostnames, so `https://host/docs` would
    // match nothing while reading as granted.
    const host = hostOf(value) ?? hostOf(`https://${value}`);
    if (value.includes("*") || host === undefined || host !== value.toLowerCase()) {
      return {
        ok: false,
        message:
          `--domain takes one exact host, e.g. --domain docs.python.org. '${value}' is ` +
          `not one${host === undefined ? "" : ` — try --domain ${host}`}.`,
      };
    }
  }

  const research: Envelope["research"] = values["research-web"] === true ? "web" : "closed";

  // A quick mission's only research pass is the scan, and the scan is never given tools:
  // it is the cheap first look, and a mission a human called small is not the one to spend
  // a multi-turn web pass on. Accepting both would leave a grant no call is ever told
  // about, which is a flag that reads as honoured and does nothing — `--scan`'s refusal
  // one grant along.
  if (values.quick === true && research === "web") {
    return {
      ok: false,
      message:
        "--research-web and --quick do not go together. A quick mission's only research " +
        "pass is the scan, which is never given tools, so the grant would do nothing. " +
        "Drop --quick to research the web.",
    };
  }

  const saved = values.saved;
  const minutes = values.budget === undefined ? DEFAULT_BUDGET_MINUTES : Number(values.budget);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, message: VALUE_FLAG_REFUSALS["--budget"]! };
  }
  const budgetMinutes = minutes;

  const goal = positionals.join(" ").trim();
  // A saved mission carries its own goal, so the positional one becomes an override
  // rather than a requirement.
  if (!goal && saved === undefined) {
    return {
      ok: false,
      message:
        'Usage: orchestra run "<goal>" [--plan-only] [--budget <minutes>] [--saved <name>]',
    };
  }

  // A quick mission's outcome spec is written by `research`, never by the architect, and
  // `research` is never offered a scanner — a mission a human called small is the one not
  // to spend a per-file security scan on. Accepting both would hand back a grant no call
  // is ever told about, which is a flag that reads as honoured and does nothing.
  if (values.quick === true && scanners.length > 0) {
    return {
      ok: false,
      message:
        "--scan and --quick do not go together. A quick mission's criteria are written by " +
        "the research scan, which is never offered a scanner — the outcome spec would come " +
        "back without one and the grant would do nothing. Drop --quick to gate on a scan.",
    };
  }

  // The two are opposite judgments about the same job (PLAN-NEXT 8.2). Taking both would
  // mean deciding which one wins here, and whichever answer this file picked, half the
  // people typing it would get the other mission.
  if (values.quick === true && values.moonshot === true) {
    return {
      ok: false,
      message:
        "--quick and --moonshot do not go together. One says the job is small enough to " +
        "skip the deep research pass, the other says it is worth a second critic round. " +
        "Drop whichever is not true of this job.",
    };
  }

  const unattended = values.unattended === true;
  // §7 couples the two deliberately: the easy path to skipping sign-off is a mission
  // whose criteria a human already approved and has not edited since. `--force` is
  // still offered, because a first run of something you trust is a real case — it is
  // just the one you have to type out.
  if (unattended && saved === undefined && values.force !== true) {
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
      planOnly: values["plan-only"] === true,
      quick: values.quick === true,
      moonshot: values.moonshot === true,
      unattended,
      force: values.force === true,
      web: values["no-web"] !== true,
      budgetMinutes,
      runtime,
      staffing,
      scanners,
      env,
      research,
      domains,
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
export function defaultEnvelope(
  config: DiscoveredConfig,
  budget: Budget,
  scanners: readonly string[] = [],
  env: readonly string[] = [],
  research: Envelope["research"] = "closed",
  domains: readonly string[] = [],
): Envelope {
  return {
    // From the catalogue rather than written out here, because these classes have to
    // resolve to tools synthesis can actually offer — a class this file invents grants
    // nothing and every task fails validation on a spelling.
    toolClasses: [...DEFAULT_TOOL_CLASSES],
    // The hosts `--domain` granted, which `WebFetch` on a granted research call and a
    // `net.read` worker are both held to. Empty is every mission that did not type it.
    domains: [...domains],
    fsRoots: [config.repoRoot ?? config.cwd],
    // No mission variables (defect 42). A worker gets the vars its transport needs to
    // start — those live beside the launch in `workers/` — and nothing else until a
    // human names one here, which is the same act as widening any other capability —
    // `--env NAME`, which is that act (PLAN-NEXT 7.1). Names, never values.
    env: [...env],
    network: "none",
    // On this machine, like every mission before containment existed. A terminal run has
    // no screen to choose on and no image configured by default, so promoting it here
    // would fail every mission at validation for a capability nobody asked for
    // (PLAN-NEXT 3.2).
    containment: "none",
    // Granted by name or not at all (PLAN-NEXT 6.3). A deepsec scan costs real money per
    // file, so a terminal run that never typed `--scan` never pays for one.
    scanners: [...scanners],
    // Closed unless `--research-web` was typed (PLAN-NEXT 11.3). Egress is the same kind
    // of decision as containment, and a research call that reads the web on nobody's
    // instruction is the default this field exists to refuse.
    research,
    maxSpend: budget,
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
  createCalls(
    config: DiscoveredConfig,
    onSpend: (call: keyof Calls, spend: Spend, ranOn?: string) => void,
    /** Which decision points this mission staffed to a model card (PLAN-NEXT 4.2).
     *  Absent, or absent for a given call, is the Agent SDK exactly as before. */
    staffing?: MissionStaffing,
    /** The panic signal, so a call in flight is aborted rather than paid for after
     *  a human has already pulled the cord. */
    signal?: AbortSignal,
  ): Calls;
  /** Injected so a run is testable without a tty. Absent under `--unattended`, and
   *  absent means nobody is there. */
  human?: HumanPort;
  /** Present when `orchestra serve` composed this mission. */
  surface?: RunSurface;
}

export async function runMission(
  options: RunOptions,
  config: DiscoveredConfig,
  io: Io,
  deps: RunDeps,
): Promise<number> {
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

  // A saved mission carries the staffing it was run with (PLAN-NEXT 11.2), which is what
  // makes `save … --as kimi-deepseek` a preset rather than a flag string to remember. A
  // `--staff` pair typed now wins per decision point, for `--scan`'s reason: a grant typed
  // now is a human's decision made now. Merged here, before `resolveStaffing`, so a preset
  // naming a card whose probe transcript has since gone is refused with the same message
  // the flag gets rather than falling through to the Agent SDK silently.
  const staffing: MissionStaffing = { ...saved?.staffing, ...options.staffing };

  const goal = options.goal || saved?.goal || "";
  const missionId = newMissionId(goal, new Date());
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
  // Refused before the log opens rather than at the call: a card id nobody probed is a
  // mission that would run its research on the default model and fail three phases later
  // with a directory already on disk (PLAN-NEXT 4.2's door).
  const resolved = resolveStaffing(
    staffing,
    staffableCards(config.stateDir, (message) => io.err(message)),
    config.providerKeys ?? {},
    options.research === "web",
  );
  if (!resolved.ok) {
    io.err(resolved.problem);
    return 1;
  }

  const calls = deps.createCalls(
    withOrchestratorModel(config, options.runtime.orchestratorModel),
    (call, spend, ranOn) =>
      wired.emit({
        type: "spend_recorded",
        missionId,
        actor: "orchestrator",
        phase: spendPhase(call),
        spend,
        // What actually answered, where the transport says so — the provider path always
        // does. `metrics` prices off this and never off what was asked for.
        ...(ranOn ? { model: ranOn } : {}),
      }),
    staffing,
    panic.signal,
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
    // `--scan` widens either one: a saved mission's envelope was scoped without knowing
    // this run wants a scanner, and a grant typed now is a human's decision made now.
    envelope: saved
      ? {
          ...saved.envelope,
          maxSpend: budget,
          scanners: [...new Set([...saved.envelope.scanners, ...options.scanners])],
          env: [...new Set([...saved.envelope.env, ...options.env])],
          // `--research-web` and `--domain` widen a saved envelope for `--scan`'s reason:
          // the grant is a decision a human is making now, about this run.
          research: options.research === "web" ? "web" : saved.envelope.research,
          domains: [...new Set([...saved.envelope.domains, ...options.domains])],
        }
      : defaultEnvelope(
          config,
          budget,
          options.scanners,
          options.env,
          options.research,
          options.domains,
        ),
    budget,
    unattended: options.unattended,
    quick: options.quick,
    moonshot: options.moonshot,
    // Recorded for `runtime`'s reason, and omitted the same way when nothing was chosen:
    // a resumed mission runs its second half on what its first half ran on.
    ...(Object.keys(staffing).length > 0 ? { staffing } : {}),
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
      // A per-run server has one mission and one checkout, so the workspace dance
      // `serve` does collapses to the config this run was discovered with. The
      // `missionId` argument is the socket's cursor and is always absent here — this
      // server streams its one mission unasked (PLAN-NEXT 9.3).
      show: (request) =>
        showWork(request, {
          events: store.events(),
          ...(config.repoRoot ? { repoRoot: config.repoRoot } : {}),
        }),
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

  // The repository as a map, for the two calls that have no tools to look at one
  // (PLAN-NEXT 8.1). Built here rather than inside `prepareMission`, which never touches
  // disk and never runs git, and awaited out here because the call below is a closure.
  // A cache keyed on HEAD, so it is one `git rev-parse` on every run after the first.
  const repoKb = await ensureRepoKb(config.stateDir, config.repoRoot, (message) =>
    io.err(message),
  );

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
      recall: () => readLore(loreDir(config.stateDir), new Date(), (message) => io.err(message)),
      // Procedural memory (§6, §7), bound here for the same reason `recall` is — and
      // at *this* root as well as `executeMission`'s, because `run` staffs its
      // approved plan inside `prepareMission` and `resume` staffs it afterwards. One
      // of the two wired is a feature switched off on the commoner path.
      roles: staffableRoles(config, (message: string) => io.err(message)),
      // Where the architect's design note lands (PLAN-NEXT 5.1), bound here for
      // `recall`'s reason — prepare never touches disk — and bound unconditionally,
      // because an optional dependency nothing passes is a feature finished and switched
      // off at the same time (defects 12b, 23, 24). The mission's own artifact root, so
      // `orchestra forget` takes the note with everything else the mission wrote.
      writeDesign: (note: string) => writeDesignNote(artifactRoot(config.stateDir, missionId), note),
      // The prepare phase's half of the scrub (PLAN-NEXT 7.3). `buildLoopDeps` derives
      // the same list for the loop, and the loop runs after this — so without it here
      // the research brief, the design note and its summary were the three surfaces
      // written in front of the scrubber rather than behind it. Bound unconditionally
      // for `writeDesign`'s reason, and empty on every mission that granted nothing.
      secrets: grantedSecrets(process.env, wired.state().mission.capabilityEnvelope.env),
      // What this machine can actually start (§7, defect 21). `run` staffs its
      // approved plan inside `prepareMission`, so the offer has to be here as well as
      // in the loop's replan — one of the two wired is a mission staffed against a
      // transport that cannot spawn, discovered one dispatch at a time.
      ...staffingOffer(config, options.runtime, staffableCards(config.stateDir, (message) =>
        io.err(message),
      )),
      // The specialist gates this mission may name (PLAN-NEXT 6.3): what its envelope
      // granted, narrowed to what this machine answered for. Bound unconditionally for
      // `roles`' reason — an optional dependency nothing passes is a feature finished and
      // switched off at once — and empty on every mission that granted none, which is
      // every mission until a human writes one into the envelope.
      scanners: availableScanners(
        wired.state().mission.capabilityEnvelope,
        config.scanners ?? [],
      ),
      // The repository as a map, for the two calls that have no tools to look at one
      // (PLAN-NEXT 8.1). Bound unconditionally for `writeDesign`'s reason, and built here
      // rather than inside `prepareMission`, which never touches disk. A cache keyed on
      // HEAD, so this is one `git rev-parse` on every run after the first — and the empty
      // string outside a repository, which is the prompt every mission had before.
      repoKb,
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

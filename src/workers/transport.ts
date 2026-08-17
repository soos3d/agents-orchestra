// Picking the way a worker actually runs, from the `TransportRef` on its synthesized
// agent spec (§7).
//
// The registry lists transports, not agents: the small fixed set of ways work can be
// executed. Which one a task uses is a property of its spec, so the model and the
// timeout arrive as arguments rather than from a config singleton — a per-task
// decision made per task.
import { workerReportSchema } from "../domain/report.js";
import { type WorkerRun, type WorkerTransport } from "../loop/dispatch.js";
import { type Containment } from "../runtime/contained.js";
import { renderSchema } from "../runtime/json.js";
import { workerPrompt } from "./prompt.js";
import { type Reformatter } from "./report.js";
import { buildWorkerEnv } from "./childEnv.js";
import { CLAUDE_TRANSPORT_VARS, runClaudeCode } from "./claudeCode.js";
import { CODEX_TRANSPORT_VARS, runCodex } from "./codex.js";
import { PI_TRANSPORT_VARS, runPi } from "./pi.js";

/**
 * The registry: the transports that are actually built, as opposed to the five §7
 * describes. Synthesis draws from this the way it draws from the envelope — a spec
 * naming anything else fails at validation, not at dispatch.
 *
 * It lives here rather than in `loop/` because this file is what would have to change
 * to make the list longer, so the two cannot drift.
 *
 * This is what the *build* ships, which is not the same question as what a given machine
 * can run: `acp` needs an agent CLI on PATH for its adapter to shim, and offering it
 * where there is none is defect 21 reproduced exactly. `availableTransports()` in
 * `availability.ts` narrows this list per machine, and that narrowed list — not this one
 * — is what a composition root hands synthesis.
 */
export const AVAILABLE_TRANSPORTS: readonly string[] = ["cli", "acp"];

/** The agent CLIs `createCliTransport` can actually spawn — beside `runners` below,
 *  which is the list it has to stay equal to. Not every probed agent has a `cli`
 *  launcher: `opencode` speaks ACP and nothing else here, so a machine holding only it
 *  has no `cli` transport at all. */
export const CLI_TARGETS: readonly string[] = ["claude", "codex", "pi"];

/** How each `cli` target is launched and what its child environment is built from, in one place
 *  so the two cannot be wired apart.
 *
 *  It replaced a `target === "codex"` boolean, which was correct for exactly as long as there
 *  were two targets: a third one would have run through `claude`'s launcher with `claude`'s
 *  credentials while the log named it, and nothing about that is loud. A record keyed by the
 *  same strings `CLI_TARGETS` lists is the shape that cannot do that — and `runnerFor` refuses
 *  an unknown key rather than defaulting to one, because a target validation let through is a
 *  planning problem (defect 21) and not a reason to run something else. */
export type CliRunner = typeof runClaudeCode;

const CLI_RUNNERS: Readonly<
  Record<string, { readonly run: CliRunner; readonly vars: readonly string[] } | undefined>
> = {
  claude: { run: runClaudeCode, vars: CLAUDE_TRANSPORT_VARS },
  codex: { run: runCodex, vars: CODEX_TRANSPORT_VARS },
  pi: { run: runPi, vars: PI_TRANSPORT_VARS },
};

export interface CliTransportOptions {
  /** Injected so what a worker is *told* is assertable without spawning a CLI — the
   *  same reason `createCliReformatter` takes one (defect 18). */
  runners?: Readonly<Record<string, CliRunner | undefined>>;
  /** The environment this process was started with, from which a worker's own is
   *  *constructed* (defect 42). Injected for the reason `runners` is: what a worker
   *  receives has to be assertable without spawning anything, and a test cannot put a
   *  fake secret in the real `process.env`. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Run every worker inside a disposable container (PLAN-NEXT 3.2). Decided by the
   *  mission's envelope at the composition root, never per task — a task cannot opt out
   *  of it, which is what `inspectContainment` refuses at synthesis. */
  contained?: Containment;
}

export interface ReformatterOptions {
  /** Where the restating session runs. It reads nothing, so any directory the mission
   *  already owns will do — the worktree may be gone by the time this is called. */
  cwd: string;
  /** Injected so what the restating session is *told* is assertable without spawning
   *  a CLI — the same reason `queryOptions` is a function (defect 18). */
  run?: typeof runClaudeCode;
  /** The environment its own is constructed from (defect 42). See `CliTransportOptions`. */
  parentEnv?: NodeJS.ProcessEnv;
}

/** Restating a JSON object is not the work, so it gets a cheap model and minutes
 *  rather than the task's whole wall-clock budget. */
export const REFORMAT_MODEL = "haiku";
export const REFORMAT_TIMEOUT_MS = 3 * 60_000;

/**
 * The one reformat attempt §4.1 promises a worker that answered in prose.
 *
 * `parseWorkerReport` has taken a `reformat` since Phase 1a and nothing ever supplied
 * one, so every worker whose last message was not already a clean object failed
 * outright — the same shape of bug as the `requestExtension` that Phase 3 found, and
 * it showed up the same way: on a real mission, where four of seven dispatches ended
 * in prose and the "one attempt" the design guarantees was never made.
 *
 * It goes back to a CLI rather than to an orchestrator decision point on purpose. §3
 * caps the decision points at five and a model call that is not on that list does not
 * exist; this makes no decision, it restates one message as the schema that message
 * was always supposed to match. The worker's own transport is the honest place for
 * that, and it rides the subscription rather than the metered budget.
 */
export function createCliReformatter(options: ReformatterOptions): Reformatter {
  return async (raw, problem) => {
    const prompt = `A worker was asked to end its turn with a single JSON object and did
not. Restate what it said as that object.

## What was wrong

${problem}

## The schema

${renderSchema(workerReportSchema)}

## What the worker actually said

${tail(raw)}

Reply with the JSON object and nothing else — no prose before it, no fence around it.
Carry over only what the message above actually supports: use "failed" or "partial"
for \`outcome\` if it does not claim the work was finished, and empty arrays where it
says nothing. Do not invent artifacts, claims, or a summary the worker did not give.`;

    // `.text` only: restating one object is not the mission's work, and folding its
    // tokens into the task's figure would price a parse failure as part of the task
    // that suffered it. It rides the subscription either way (§9.5).
    // Restating one object is still a CLI session in the mission's directory, so it
    // gets a constructed environment like any other (defect 42) — and never a task's
    // granted variables, since it is not doing the task's work.
    const outcome = await (options.run ?? runClaudeCode)(prompt, options.cwd, {
      model: REFORMAT_MODEL,
      timeoutMs: REFORMAT_TIMEOUT_MS,
      env: buildWorkerEnv({
        parent: options.parentEnv ?? process.env,
        transportVars: CLAUDE_TRANSPORT_VARS,
      }),
    });
    return outcome.text;
  };
}

/** The end of a worker's message, which is where a report would be. Bounded because
 *  a chatty CLI's output is already ring-buffered to something large, and sending all
 *  of it back to restate one object is the wrong end of the trade. */
const REFORMAT_INPUT_LIMIT = 20_000;

export function tail(raw: string, limit = REFORMAT_INPUT_LIMIT): string {
  return raw.length <= limit ? raw : `…${raw.slice(-limit)}`;
}

/** The `cli` transport: a headless coding CLI in the task's worktree. ACP replaces
 *  the flag-scraping underneath this in Phase 7; the seam does not move.
 *
 *  Which id reaches which transport is `routeTransport`'s decision (`router.ts`), not
 *  this function's. The guard below stays anyway, and deliberately: this is the one
 *  place that knows it is the `cli` transport, and a composition root that wires it
 *  under another id should say so rather than silently running an ACP task through a
 *  subscription CLI. */
export function createCliTransport(options: CliTransportOptions = {}): WorkerTransport {
  return async ({ task, cwd, artifactDir, designNote, signal }): Promise<WorkerRun> => {
    const { transport, model } = task.agentSpec;
    if (transport.id !== "cli") {
      throw new Error(
        `The cli transport was handed a '${transport.id}' task. Route transports with ` +
          `routeTransport() rather than wiring one transport for every id.`,
      );
    }

    // What the worker is told is assembled in one place for every transport, so the
    // CLI and ACP paths cannot drift into two contracts (`prompt.ts`).
    const prompt = workerPrompt(task, artifactDir, designNote);
    // `target` is optional on a `TransportRef` and an absent one has always meant `claude`
    // here — kept rather than tightened, because a log written before targets existed still
    // folds and would otherwise fail at dispatch on a field it never carried.
    const target = transport.target ?? "claude";
    const launch = CLI_RUNNERS[target];
    if (launch === undefined) {
      throw new Error(
        `The cli transport has no launcher for target '${target}' — it can start ` +
          `${CLI_TARGETS.join(", ")}. Plan this task with one of those, or add the target's ` +
          `launcher beside the others in transport.ts.`,
      );
    }
    // An injected runner replaces the launcher for its own target and nothing else, so a test
    // that fakes `claude` still fails loudly if the task it built is routed to `pi`.
    const run = options.runners?.[target] ?? launch.run;

    // Constructed, never filtered (defect 42): what the CLI needs to start plus the
    // variables this task's envelope granted it, and nothing else this process happens
    // to hold. `agentSpec.env` was checked against the envelope at synthesis, so by
    // here the only question left is which of those names the machine actually has.
    const env = buildWorkerEnv({
      parent: options.parentEnv ?? process.env,
      transportVars: launch.vars,
      ...(task.agentSpec.env ? { allowed: task.agentSpec.env } : {}),
    });

    const startedAt = Date.now();
    const outcome = await run(prompt, cwd, {
      model: transport.model ?? model,
      timeoutMs: task.budget.wallMs,
      env,
      ...(signal ? { signal } : {}),
      // The mission's envelope, not the spec's: a task that asked to run outside the
      // container was already refused at synthesis, and one that said nothing runs
      // however the mission was composed. The artifact directory rides along because a
      // worker that cannot write its report has not been contained, it has been broken.
      ...(options.contained
        ? { contained: options.contained, mounts: artifactDir ? [artifactDir] : [] }
        : {}),
    });

    // The usage is carried when the CLI reported it and omitted when it did not,
    // which is a per-target answer rather than a per-transport one: `claude
    // --output-format json` says, `codex` is scraped from a last-message file and
    // cannot. Omitting is what makes `spendOf` count an unmeasured dispatch instead
    // of booking a confident zero (§9.5).
    return {
      raw: outcome.text,
      elapsedMs: Date.now() - startedAt,
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    };
  };
}

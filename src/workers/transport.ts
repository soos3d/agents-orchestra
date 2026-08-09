// Picking the way a worker actually runs, from the `TransportRef` on its synthesized
// agent spec (§7).
//
// The registry lists transports, not agents: the small fixed set of ways work can be
// executed. Which one a task uses is a property of its spec, so the model and the
// timeout arrive as arguments rather than from a config singleton — a per-task
// decision made per task.
import { workerReportSchema } from "../domain/report.js";
import { type WorkerRun, type WorkerTransport } from "../loop/dispatch.js";
import { renderSchema } from "../runtime/json.js";
import { type Reformatter } from "./report.js";
import { runClaudeCode } from "./claudeCode.js";
import { runCodex } from "./codex.js";

/**
 * The registry: the transports that are actually built, as opposed to the five §7
 * describes. Synthesis draws from this the way it draws from the envelope — a spec
 * naming anything else fails at validation, not at dispatch.
 *
 * It lives here rather than in `loop/` because this file is what would have to change
 * to make the list longer, so the two cannot drift.
 */
export const AVAILABLE_TRANSPORTS: readonly string[] = ["cli"];

export interface CliTransportOptions {
  timeoutMs?: number;
}

export interface ReformatterOptions {
  /** Where the restating session runs. It reads nothing, so any directory the mission
   *  already owns will do — the worktree may be gone by the time this is called. */
  cwd: string;
  model?: string;
  timeoutMs?: number;
  /** Injected so what the restating session is *told* is assertable without spawning
   *  a CLI — the same reason `queryOptions` is a function (defect 18). */
  run?: typeof runClaudeCode;
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

    return (options.run ?? runClaudeCode)(prompt, options.cwd, {
      model: options.model ?? REFORMAT_MODEL,
      timeoutMs: options.timeoutMs ?? REFORMAT_TIMEOUT_MS,
    });
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
 *  the flag-scraping underneath this in Phase 7; the seam does not move. */
export function createCliTransport(options: CliTransportOptions = {}): WorkerTransport {
  return async ({ task, cwd, signal }): Promise<WorkerRun> => {
    const { transport, model, systemPrompt } = task.agentSpec;
    if (transport.id !== "cli") {
      throw new Error(
        `Transport '${transport.id}' is not available yet — Phase 2 ships 'cli' only. ` +
          `Plan this task with a cli worker, or wait for the ACP transport (Phase 7).`,
      );
    }

    // The worker sees the goal and nothing else: it has no view of the mission, the
    // ledger, or the other tasks (§4, context discipline).
    const prompt = `${systemPrompt}\n\n## Your task\n\n${task.goal}\n\n${REPORT_INSTRUCTION}`;
    const run = transport.target === "codex" ? runCodex : runClaudeCode;

    const startedAt = Date.now();
    const raw = await run(prompt, cwd, {
      model: transport.model ?? model,
      timeoutMs: options.timeoutMs ?? task.budget.wallMs,
      ...(signal ? { signal } : {}),
    });

    // No token count: a subscription CLI does not report one, which is exactly why
    // `Spend.tokens.unmeasured` exists (§9.5). Reporting a confident 0 would be worse.
    return { raw, elapsedMs: Date.now() - startedAt };
  };
}

/**
 * The report is the orchestrator's entire evidence base (§4.1) — it never sees the
 * transcript — so a worker that ends its turn in prose has done the work and thrown
 * it away. Against a real model that happened on four of seven dispatches, because
 * the instruction described the shape in prose and left the model to infer which
 * fields were required and what an `Artifact` looks like.
 *
 * The schema is rendered from `workerReportSchema` rather than written out, so it
 * cannot drift from the parser that will reject the answer. The prose that survives
 * is the part a schema cannot say: that the transcript is discarded, and what the
 * `outcome` values are actually for.
 */
const REPORT_INSTRUCTION = `## How to finish

The orchestrator never sees your transcript. Anything not in the object below is
lost — including work you did. End your turn with a single JSON object matching this
schema, and nothing after it:

${renderSchema(workerReportSchema)}

Every required field must be present; use an empty array where you have nothing.

\`outcome\` is your own verdict, not a formality. Use "completed" only if you did the
whole task, "partial" if you got some of the way, "failed" if the approach does not
work, and "blocked" if you need a human — with the question in \`summary\`.

\`deadEnds\` is what stops the next attempt walking into what you already tried, and
\`unknowns\` becomes the next round's research. A failed task that fills those in is
worth more than a silent one.`;

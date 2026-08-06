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

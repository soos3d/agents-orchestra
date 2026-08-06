// Picking the way a worker actually runs, from the `TransportRef` on its synthesized
// agent spec (§7).
//
// The registry lists transports, not agents: the small fixed set of ways work can be
// executed. Which one a task uses is a property of its spec, so the model and the
// timeout arrive as arguments rather than from a config singleton — a per-task
// decision made per task.
import { type WorkerRun, type WorkerTransport } from "../loop/dispatch.js";
import { runClaudeCode } from "./claudeCode.js";
import { runCodex } from "./codex.js";

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

const REPORT_INSTRUCTION = `## How to finish

Your final message must be a single JSON object matching this shape, and nothing else:

{
  "outcome": "completed" | "partial" | "blocked" | "failed",
  "summary": "what you did, under 200 words",
  "criteriaTouched": ["criterion ids this work bears on"],
  "claims": ["assertions the orchestrator may treat as findings"],
  "unknowns": ["what you could not determine"],
  "deadEnds": ["approaches you tried that do not work"],
  "artifacts": [{ "kind": "diff", "id": "a1", "branch": "...", "files": [], "insertions": 0, "deletions": 0 }]
}

The orchestrator never sees your transcript, so anything not in this object is lost.
Use "blocked" if you need a human, and put the question in "summary".`;

// The orchestrator loop: Fable plans, decomposes, routes, verifies, and merges —
// using only the typed tools in tools.ts. It never edits code itself.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { orchestraServer } from "./tools.js";

const SYSTEM_PROMPT = `You are the ORCHESTRATOR of a small team of coding agents. You do NOT write code yourself.

Your job, given a goal:
1. PLAN. Break the goal into independent, well-scoped tasks. Prefer tasks that touch non-overlapping files so they can run in parallel.
2. ROUTE each task to the right worker:
   - dispatch_claude_code: careful multi-file refactors, reasoning-heavy or ambiguous changes.
   - dispatch_codex: well-scoped, clearly specified, self-contained changes.
   Give each task a short, unique branch name and FULL self-contained instructions
   (the worker cannot see this conversation or the other tasks).
3. VERIFY. After a worker returns, call run_verification with the project's test/typecheck/build
   command on that branch. If it fails, dispatch a follow-up fix task on the same area.
4. MERGE only branches that verified clean, via merge_task.
5. Keep your own context lean: rely on the workers' short reports, do not re-read their full output.

Dispatch independent tasks in the same turn so they run concurrently (respect a max of ${config.maxConcurrency}
in flight). When everything is merged and verified, summarize what shipped.`;

export async function orchestrate(goal: string): Promise<void> {
  const stream = query({
    prompt: `GOAL:\n${goal}\n\nPlan, dispatch, verify, and merge. The verification command for this repo is: npm test`,
    options: {
      model: config.orchestratorModel, // 'fable' if your SDK build accepts the alias
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { orchestra: orchestraServer },
      // Auto-approve our tools; the orchestrator has no raw Bash/Edit of its own.
      allowedTools: [
        "mcp__orchestra__dispatch_claude_code",
        "mcp__orchestra__dispatch_codex",
        "mcp__orchestra__run_verification",
        "mcp__orchestra__merge_task",
        "mcp__orchestra__list_tasks",
      ],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  for await (const msg of stream) {
    // Minimal live view. Swap for a TUI / dashboard later.
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
        if (block.type === "tool_use") console.log(`\n→ ${block.name}(${JSON.stringify(block.input)})`);
      }
    }
    if (msg.type === "result" && "result" in msg) {
      console.log(`\n\n=== DONE ===\n${msg.result}`);
    }
  }
}

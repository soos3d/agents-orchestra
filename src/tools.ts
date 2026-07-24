// The typed tool surface the Fable orchestrator sees. Each tool is deterministic
// TypeScript — the model decides *what* to dispatch; the code decides *how*.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createWorktree, diffStat, mergeBranch } from "./worktree.js";
import { runClaudeCode } from "./workers/claudeCode.js";
import { runCodex } from "./workers/codex.js";
import { run } from "./sh.js";
import { store } from "./store.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const dispatchClaudeCode = tool(
  "dispatch_claude_code",
  "Run a coding task with a Claude Code worker in an isolated git worktree. Best for careful, multi-file refactors and reasoning-heavy changes. Returns the worker's final report and a diff stat.",
  {
    task: z.string().describe("Full, self-contained instructions for the worker."),
    branch: z.string().describe("Short branch name for this task, e.g. 'feat/login-refactor'."),
  },
  async ({ task, branch }) => {
    const t = store.add({ description: task, backend: "claude-code", branch });
    try {
      const worktree = await createWorktree(branch);
      store.update(t.id, { status: "in_progress", worktree });
      const result = await runClaudeCode(task, worktree);
      const diff = await diffStat(worktree);
      store.update(t.id, { status: "review", result });
      return text(`[${t.id}] claude-code on ${branch}\nDIFF:\n${diff}\n\nWORKER REPORT:\n${result}`);
    } catch (e) {
      store.update(t.id, { status: "failed", result: String(e) });
      return text(`[${t.id}] FAILED: ${e}`);
    }
  },
);

const dispatchCodex = tool(
  "dispatch_codex",
  "Run a coding task with a Codex worker in an isolated git worktree. Best for well-scoped, clearly specified changes. Returns the worker's final report and a diff stat.",
  {
    task: z.string().describe("Full, self-contained instructions for the worker."),
    branch: z.string().describe("Short branch name for this task, e.g. 'fix/date-parse'."),
  },
  async ({ task, branch }) => {
    const t = store.add({ description: task, backend: "codex", branch });
    try {
      const worktree = await createWorktree(branch);
      store.update(t.id, { status: "in_progress", worktree });
      const result = await runCodex(task, worktree);
      const diff = await diffStat(worktree);
      store.update(t.id, { status: "review", result });
      return text(`[${t.id}] codex on ${branch}\nDIFF:\n${diff}\n\nWORKER REPORT:\n${result}`);
    } catch (e) {
      store.update(t.id, { status: "failed", result: String(e) });
      return text(`[${t.id}] FAILED: ${e}`);
    }
  },
);

const runVerification = tool(
  "run_verification",
  "Run a shell command (tests, typecheck, build) inside a task's worktree to verify its work before merge.",
  {
    branch: z.string().describe("The branch/worktree to run in."),
    command: z.string().describe("Command to run, e.g. 'npm test' or 'pytest -q'."),
  },
  async ({ branch, command }) => {
    const t = store.list().find((x) => x.branch === branch);
    if (!t?.worktree) return text(`No worktree found for branch ${branch}.`);
    const [cmd, ...args] = command.split(" ");
    const r = await run(cmd, args, { cwd: t.worktree, timeoutMs: 10 * 60_000 });
    return text(`exit=${r.code}\nSTDOUT:\n${r.stdout.slice(-4000)}\nSTDERR:\n${r.stderr.slice(-2000)}`);
  },
);

const mergeTask = tool(
  "merge_task",
  "Merge a reviewed, passing task branch back into the target repo. Only call after verification passes.",
  { branch: z.string() },
  async ({ branch }) => {
    const msg = await mergeBranch(branch);
    const t = store.list().find((x) => x.branch === branch);
    if (t) store.update(t.id, { status: "done" });
    return text(msg);
  },
);

const listTasks = tool(
  "list_tasks",
  "List all tasks and their current status.",
  {},
  async () => text(JSON.stringify(store.list(), null, 2)),
);

export const orchestraServer = createSdkMcpServer({
  name: "orchestra",
  version: "0.1.0",
  instructions:
    "Tools for dispatching coding work to Claude Code and Codex workers and merging their results.",
  tools: [dispatchClaudeCode, dispatchCodex, runVerification, mergeTask, listTasks],
});

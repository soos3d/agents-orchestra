// Central config, read from environment. Keep this the only place that touches process.env.
import path from "node:path";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

const TARGET_REPO = path.resolve(req("TARGET_REPO"));

export const config = {
  targetRepo: TARGET_REPO,
  worktreeRoot: path.resolve(
    process.env.WORKTREE_ROOT && process.env.WORKTREE_ROOT !== ""
      ? process.env.WORKTREE_ROOT
      : path.join(TARGET_REPO, "..", ".orchestra-worktrees"),
  ),
  orchestratorModel: process.env.ORCHESTRATOR_MODEL || "fable",
  claudeWorkerModel: process.env.CLAUDE_WORKER_MODEL || "sonnet",
  codexWorkerModel: process.env.CODEX_WORKER_MODEL || "gpt-5-codex",
  maxConcurrency: Number(process.env.MAX_CONCURRENCY || "3"),
  // Where task state is persisted.
  stateDir: path.join(TARGET_REPO, "..", ".orchestra-state"),
};

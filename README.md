# fable-orchestra

A minimal **Fable-brained orchestrator** that dispatches coding tasks to **Claude Code** and **Codex** workers, each running in an isolated **git worktree**, and merges their work only after verification.

This is a **starter skeleton**, not a finished product. It's meant to be read, run against a throwaway repo, and adapted. CLI flags for `claude` and `codex` change between versions — expect to tweak `src/workers/*`.

## How it works

```
              ┌─────────────────────────────┐
   goal  ──►  │  Orchestrator (Fable)       │   plans → routes → verifies → merges
              │  Claude Agent SDK query()   │   (writes no code itself)
              └──────────────┬──────────────┘
                             │  typed tools (in-process MCP server)
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                     ▼
 dispatch_claude_code  dispatch_codex        run_verification / merge_task
   (worktree A)          (worktree B)          (tests, then merge to main)
```

- **Orchestrator** = one `query()` loop on `model: 'fable'` with a "you are a dispatcher, you don't write code" system prompt. It only has the typed tools in `src/tools.ts`.
- **Workers** = headless `claude -p` and `codex exec` subprocesses (`src/workers/`), each in its own branch/worktree so they never collide.
- **State** = plain JSON on disk (`.orchestra-state/tasks.json`). No DB.

## Prerequisites

- Node 20+
- Claude Code CLI installed and authed: `npm i -g @anthropic-ai/claude-code` then `claude` once to log in
- Codex CLI installed and authed: `npm i -g @openai/codex` (or your install), then `codex` once to log in
- A git repo to work in (use a scratch clone the first few runs)

## Setup

```bash
npm install
cp .env.example .env      # then edit: TARGET_REPO, models, concurrency
```

## Run

```bash
# against a throwaway repo first!
npm run dev -- "Add a /health endpoint and a unit test for it"
```

You'll see the orchestrator plan, call `dispatch_*` tools, run verification, and merge. Task state lands in `../.orchestra-state/tasks.json`; worktrees in `../.orchestra-worktrees/`.

## Adapt / extend

- **Routing rules:** hard-code obvious routing in the system prompt (e.g. "frontend → codex") to save tokens.
- **A third worker (computer use):** add `src/workers/computerUse.ts` (Bytebot or the computer-use API) and a `dispatch_computer_use` tool the same way.
- **Safety:** swap `--dangerously-skip-permissions` for an allowedTools/settings policy once flows are proven; keep workers sandboxed to their worktree.
- **Scale:** for dozens of parallel tasks, move dispatch into the SDK's `Workflow` tool.

## Files

| File | Purpose |
|------|---------|
| `src/orchestrator.ts` | The Fable planning/dispatch loop |
| `src/tools.ts` | Typed tools the orchestrator can call (in-process MCP server) |
| `src/workers/claudeCode.ts` | Headless `claude -p` worker |
| `src/workers/codex.ts` | Headless `codex exec` worker |
| `src/worktree.ts` | git worktree create / diff / merge |
| `src/store.ts` | JSON task state |
| `src/config.ts` | env-driven config |
| `src/sh.ts` | child_process wrapper |

# orchestra

[![npm](https://img.shields.io/npm/v/@soos3d/orchestra)](https://www.npmjs.com/package/@soos3d/orchestra)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

A local program that runs a **mission**: a goal, a written definition of done, and a loop that drives the coding tools you already have until that definition is met (or you run out of time, or something actually blocks).

![orchestra-hero](/assets/readme-hero.png)

## The idea

You know Claude Code, Codex, OpenCode, and friends. You type what you want, an assistant edits the repo, you watch the terminal. Fine for a small change. Less fine when the job is bigger than one sitting, or when you hit the weekly cap while it is still planning.

Orchestra sits above those tools. It does not replace them.

1. You give it a goal in English.
2. It looks at the repo, asks up to three questions, and writes down what “done” means (checks that can actually fail).
3. You sign off on that definition *and* the plan. Nothing runs until you do.
4. It starts the coding tools as **workers**, possibly several at once, each on its own git copy of the repo.
5. It grades the result against the written checks, not against the worker’s claim that it finished.
6. If the work is incomplete it replans and goes again. If the process dies you type `orchestra resume`.

Most of a long job is thinking (research, a plan, a critique), not the file edit. Claude and Codex are good at the edit and they run out. You can put the thinking on a cheaper pay-per-token model (Nebius and anything else you have probed) and keep the capped seat for the task that needs it:

```bash
orchestra run "add a clamp helper with a colocated test" \
  --staff plan=Qwen/Qwen3-30B-A3B-Instruct-2507
```

`--staff` is per step of the loop. Workers can also use different tools and models from each other. The model that writes the code is never the one that grades it.

## Fair warning

This is early (0.1.0). A mission runs end to end. It is also probably over-engineered for what it currently delivers, and it is not the fastest or cheapest way to change a file. Opening Claude still wins for a two-hour feature.

I built a lot of machinery. Some of it is the point (the frozen definition of done, the log you can resume, spending Claude only on the edit). Some of it is me enjoying types. Help me tell which is which.

If you are smarter than I am, which is likely, [contributions](./CONTRIBUTING.md) are welcome. Make it smaller. Make it nicer to use. Delete something.

What works and what does not: [docs/status.md](./docs/status.md).

## Run it

You need **Node 20+** and **at least one coding CLI, already logged in**.

Use a scratch git repo the first time. Workers get a real shell and will edit whatever you point them at.

```bash
# 1. A coding CLI (one is enough)
npm i -g @anthropic-ai/claude-code && claude   # log in once, then quit
#    or:  npm i -g @openai/codex && codex

# 2. Orchestra
npm i -g @soos3d/orchestra
#    or from this repo:  npm install && npm run build && npm link

# 3. What is missing
cd ~/scratch/trial          # git init if you need to
orchestra doctor

# 4. Plan only (cheap). Read the spec, then stop. Nothing edits the repo.
orchestra run "add a clamp(value, min, max) helper with a colocated test" --plan-only

# 5. Same goal, actually run it. Sign off in the terminal or the local dashboard.
orchestra run "add a clamp(value, min, max) helper with a colocated test" --budget 30
```

`--quick` skips the long research pass and plans a single task. Use it when you already know the job. `--plan-only` plus `--quick` is the cheapest way to see whether a goal even makes sense.

A dashboard URL prints on `127.0.0.1` unless you pass `--no-web`. Sign-off appears there and in the terminal; whichever you answer first wins.

No environment variable is required. Everything in `.env.example` is an override (API keys for extra model providers, a container image if you want workers boxed in).

From source, the gate is `npm run typecheck && npm test`. There is no linter.

## Why bother with the extra ceremony

**Done is the document you signed.** After sign-off, a worker cannot quietly change the goal. A check that never ran cannot count as met.

**The writer does not grade the paper.** Repo tests run first. A separate judge reads the artifacts. That judge cannot be swapped onto a cheap chat-completion model, because it has to open files.

**Several coding tools, one mission.** Claude on one task, Codex on another, OpenCode plus a factory model on a third, if those tools are on your machine. Labs will not dispatch each other’s CLIs. This will.

**Spend the capped seat on the edit.** Loop steps (`research`, `plan`, `critique`, …) can run on a probed model card. `orchestra metrics <id> --staffing` shows what was asked for, what actually answered, and what it cost.

**The mission is a log.** State lives in `.orchestra/` as `events.jsonl`. Crash, close the lid, `orchestra resume <id>`. Round 15 does not replay round 1’s conversation.

**Workers only get what you named.** Their environment is built from an allowlist, not inherited from your shell. A missing secret is a question. The mission plans against mocks and continues.

## Commands

| Command | What it does |
|---|---|
| `orchestra doctor` | What is installed, logged in, and missing |
| `orchestra run "<goal>"` | Start a mission |
| `orchestra resume <id>` | Continue from the log |
| `orchestra serve` | Dashboard that outlives a single run |
| `orchestra metrics <id>` | Cost per step; add `--staffing` for the model split |
| `orchestra save <id> --as <name>` | Replay later with `--saved` |
| `orchestra promote <id> <task> --as <name>` | Keep a worker as a reusable role |
| `orchestra forget <id>` | Delete everything that mission wrote |

Useful flags on `run`: `--plan-only`, `--quick`, `--budget <minutes>`, `--staff <step>=<card>`, `--unattended` (needs `--saved` or `--force`; asked for twice on purpose).

Full flag list: [docs/cli.md](./docs/cli.md). How to add a model card and staff a step: [docs/models.md](./docs/models.md).

## Documentation

| | |
|---|---|
| [Status](./docs/status.md) | What has landed, what has not |
| [Receipts](./docs/receipts/2026-08-18-calculator.md) | A real mission: two models, cost, evidence |
| [CLI](./docs/cli.md) | Every flag and command |
| [Architecture](./docs/architecture.md) | The loop, the event log, `.orchestra/` |
| [Models](./docs/models.md) | Cards, the probe, staffing |
| [Agent roster](./docs/agent-roster.md) | Roles a worker can start from |
| [Development](./docs/development.md) | Build, test, the rule the suite cannot enforce |
| [Contributing](./CONTRIBUTING.md) | What a first patch has to hit |

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

# orchestra

[![npm](https://img.shields.io/npm/v/@soos3d/orchestra)](https://www.npmjs.com/package/@soos3d/orchestra)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**A local, resilient, looping orchestrator for any kind of task — not only coding.**

You give it a mission. Orchestra researches it *and what a good outcome would look like*, writes that
down, asks up to three questions, plans a set of tasks, waits for you to sign off, synthesizes a
purpose-built agent for each task, runs them in parallel, verifies each, and re-assesses after every
round. It loops until the outcome is met, the budget is spent, or it is genuinely blocked.

---

## Quickstart

```bash
# 1. A coding CLI, logged in (at least one)
npm i -g @anthropic-ai/claude-code && claude   # log in once, then quit

# 2. Orchestra itself
npm i -g @soos3d/orchestra

# 3. Check your setup
orchestra doctor

# 4. Plan a mission without paying for a full run
cd ~/some/scratch/repo
orchestra run "add a clamp(value, min, max) helper with a colocated test" --plan-only
```

---

## Contents

- [What it is not](#what-it-is-not)
- [Install](#install)
- [Run a mission](#run-a-mission)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Documentation](#documentation)
- [License](#license)

---

## What it is not

| | |
|---|---|
| **Not a coding swarm** | A task can be research, review, or writing. Only `code` tasks get git. |
| **Not a hosted service or desktop app** | One npm package, one `orchestra` binary, one process. No database, no daemon. |
| **Not autonomous by default** | A human signs off on the outcome spec *and* the plan before anything is synthesized. `--unattended` has to be asked for twice. |

**Status:** Phases 1–7 have landed — a mission runs end to end.
See [docs/status.md](./docs/status.md) for what works and what does not.

---

## Install

**Requirements:** Node 20+, and at least one coding CLI, logged in.

```bash
npm i -g @anthropic-ai/claude-code && claude   # log in once, then quit
npm i -g @openai/codex             && codex    # log in once, then quit
```

Then the orchestrator:

```bash
npm i -g @soos3d/orchestra
```

<details>
<summary><strong>Or from source</strong> — the same thing plus the tests</summary>

```bash
git clone https://github.com/soos3d/orchestra.git && cd orchestra
npm install
npm run build
npm link          # puts `orchestra` on your PATH
```

</details>

### `orchestra doctor`

It tells you what is missing and what to type. It is the first thing to run and the only setup
documentation there should ever be:

```
✓ node          v23.11.0
✓ repo          /Users/you/code/ledger (detected from cwd)
✓ verification  npm test (from package.json)
✓ workers       claude, codex
✓ state         /Users/you/code/ledger/.orchestra
✓ gitignore     .orchestra/ is ignored

Ready.
```

No environment variable is required. Everything in `.env.example` is an override.

---

## Run a mission

> ⚠️ Work in a scratch repo the first time. Workers get a real git worktree and a real shell, and
> they will edit the repository you point them at.

**Plan only** — the cheap half. Scan, intake, research, spec, plan, estimate, then stop. Nothing is
dispatched and no agent is synthesized.

```bash
orchestra run "<goal>" --plan-only
```

**Full run** — drop the flag. It prints a dashboard URL on `127.0.0.1` within seconds. The sign-off
screen renders in the browser and the terminal at once; whichever you answer first wins.

```bash
orchestra run "<goal>" --budget 30
```

**Quick mode** — for a job you already understand. Skips the deep research call and plans one task:
**8,194 tokens / 1m53s** against **15,921 / 3m35s** on the same goal.

```bash
orchestra run "fix the off-by-one in parseRange" --quick --plan-only
```

### Flags at a glance

| Flag | Effect |
|---|---|
| `--plan-only` | Plan and stop. Nothing runs. |
| `--quick` | Skip deep research, plan one task. A hint, not a permission. |
| `--budget <minutes>` | Wall-clock ceiling. Default 240. |
| `--unattended` | Skip sign-off. Requires `--saved` or `--force`. |
| `--saved <name>` | Replay a saved mission. |
| `--force` | The acknowledgement `--unattended` needs without `--saved`. |
| `--no-web` | No dashboard. For CI. |

→ Full details, budgets, and the rules around `--quick` in the **[CLI reference](./docs/cli.md)**.

---

## Commands

| Command | What it does |
|---|---|
| `orchestra serve` | The dashboard that outlives missions — compose, watch, answer, resume, save, promote |
| `orchestra run <goal>` | Start a mission |
| `orchestra resume <missionId>` | Replay the log, reconcile orphans, carry on |
| `orchestra forget <missionId>` | Delete everything a mission wrote |
| `orchestra save <missionId> --as <name>` | Keep the mission to replay with `--saved` |
| `orchestra promote <missionId> <taskId> --as <name>` | Keep the agent as a reusable role |
| `orchestra metrics <missionId> [--json]` | What each decision point cost |
| `orchestra doctor` | What is installed, authed, and missing |

`orchestra serve` is the only command a normal run needs.

---

## How it works

```
  events.jsonl ──fold──►  MissionState  ──►  mission.json + tasks.json
   (source of truth)      (pure reducer)     (projections — safe to delete)
```

The loop is a TypeScript `while`, not a conversation. A model is called at six fixed decision points
— `research`, `intake`, `plan`, `synthesize`, `progress`, `judge` — each with a fresh context built by
folding the log, each returning a structured value that becomes an event.

Between calls, TypeScript owns everything: the counters, the budget, lease overlap, DAG readiness, and
the criteria freeze. **A model never enforces an invariant.**

→ The module map, replay rules, and the `.orchestra/` security notes are in
**[docs/architecture.md](./docs/architecture.md)**.

---

## Documentation

| | |
|---|---|
| **[Status](./docs/status.md)** | What has landed, what has not |
| **[CLI reference](./docs/cli.md)** | Every flag and command, in full |
| **[Architecture](./docs/architecture.md)** | The loop, the event log, the modules, `.orchestra/` |
| **[Agent roster](./docs/agent-roster.md)** | The eighteen roles, and how to add your own |
| **[Development](./docs/development.md)** | Build, test, and the one rule the suite cannot enforce |
| **[Contributing](./CONTRIBUTING.md)** | What a first patch has to hit |

---

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

# orchestra

A local, resilient, **looping** orchestrator for **any kind of task** — not only coding.

You give it a mission. Fable researches it *and what a good outcome would look like*, writes that
down, asks up to three questions, plans a set of tasks, waits for you to sign off, synthesizes a
purpose-built agent for each task, runs them in parallel, verifies each, and re-assesses after every
round. It loops until the outcome is met, the budget is spent, or it is genuinely blocked.

**What it is not.** Not a coding swarm — a task can be research, review, or writing, and only `code`
tasks get git. Not a hosted service and not a desktop app: one npm package, one `orchestra` binary,
one process, no database, no daemon. Not autonomous by default — a human signs off on the outcome
spec and the plan before anything is synthesized, and `--unattended` has to be asked for twice.

Apache-2.0.

The design document and the roadmap are kept privately and are not part of this repository. Code
comments cite them by section (`§9.1`) and by defect number ("defect 30"), and those citations are
left in deliberately: each one says *why* a piece of code is shaped the way it is, and the reason
is usually a bug that a real mission found. You do not need either document to run a mission or to
send a patch — [`CONTRIBUTING.md`](./CONTRIBUTING.md) and `CLAUDE.md` carry what a change has to
respect.

## Status

**Phases 1–7 have landed.** A mission runs end to end: scan, intake, research, outcome spec, plan,
sign-off, synthesis, dispatch into parallel worktrees, verification, merge, replan. Memory recalls
lore before the scan and writes back on completion; saved missions replay with `--saved`. An
attended run serves a dashboard on loopback, and `orchestra serve` outlives missions — compose one
from the page, watch any of them, answer a parked one's question, pause, forget. `ask_human` parks
exactly the tasks it blocks while the rest keep running, and the carrier-independent trust core for
the future phone mirror (single-use nonces, one bound sender, replay approves once) ships tested.
Workers also run over **ACP** — a pinned adapter per target, a real permission channel in place of
`--dangerously-skip-permissions` — and a real mission has gone from brief to `complete`
uninterrupted on it: six synthesized agents, five real merges, nine criteria met with evidence.

Two things since exist to make a mission cheaper rather than more capable. `--quick` skips the deep
research call on a job you already understand, halving a plan-only run. And synthesis now starts
from a **roster** of eighteen documented roles instead of authoring a system prompt from scratch
for every task — it reads one line per role, never the bodies.

What is not built: computer use and its approval gates, and the concrete phone carrier for the
inbox. Smaller things are started and named rather than half-wired — killing a single task,
resuming a parked mission from the server rather than the CLI, the artifact retention sweep, and
streaming live worker activity to the dashboard.

## Install

Node 20+, and at least one coding CLI, logged in:

```bash
npm i -g @anthropic-ai/claude-code && claude   # log in once, then quit
npm i -g @openai/codex             && codex    # log in once, then quit
```

Then the orchestrator itself:

```bash
npm i -g @soos3d/orchestra
```

Or from source, which is the same thing plus the tests:

```bash
git clone https://github.com/soos3d/orchestra.git && cd orchestra
npm install
npm run build
npm link          # puts `orchestra` on your PATH
```

`orchestra doctor` tells you what is missing and what to type. It is the first thing to run and the
only setup documentation there should ever be:

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

## Run a mission

Work in a scratch repo the first time. Workers are given a real git worktree and a real shell, and
they will edit the repository you point them at.

```bash
mkdir -p ~/scratch/trial && cd ~/scratch/trial
git init && git commit --allow-empty -m "init"
```

### 1. Plan without paying for it

```bash
orchestra run "write a RISKS.md covering the security risks of running coding agents
               unattended, with a mitigation for each" --plan-only
```

`--plan-only` runs the cheap half: a silent scan, up to three intake questions **on stdin**, then
research, the outcome spec, the plan, and an estimate — and stops. Nothing is dispatched and no
agent is synthesized. It costs a handful of orchestrator calls, it is the CI gate, and it exits
non-zero if any criterion was rejected for having no way to check it.

Intake asks only what the scan made answerable. Press Enter to skip a question; the answer becomes a
labelled guess on the sign-off screen instead.

### 1b. When the job is small, say so

Most of that cost is the deep `research` call and a planner told to decompose. A mission you already
understand needs neither:

```bash
orchestra run "fix the off-by-one in parseRange" --quick --plan-only
```

`--quick` keeps the scan's own brief and criteria instead of throwing them away and researching
again, and it asks the planner for one task rather than a decomposition. Measured on the same goal:
**8,194 tokens and 1m53s, against 15,921 and 3m35s** for the standard path.

It is a hint and never a permission. The outcome-spec gate is unchanged, and a scan-derived spec
that fails it escalates to the deep call the mission skipped — so ticking the box on a job that was
not small costs one call, not a run. Two other things buy the deep call back, both structural: an
**answered intake question**, because the scan runs before intake and its criteria would predate the
answer; and the **first send-back at sign-off**, because rejecting a quick plan contradicts your own
checkbox, and replanning over scan-depth findings would answer that with the same thin ground twice.

The compose card in the dashboard has the same thing as a checkbox.

### 2. The full run

Drop the flag:

```bash
orchestra run "add a clamp(value, min, max) helper, in its own file with a colocated
               test, following the conventions already in src/" --budget 30
```

It prints a dashboard URL on `127.0.0.1` within a few seconds. Open it. The sign-off screen renders
there and in the terminal at the same time, and whichever one you answer first wins — approve, or
type feedback and it replans. Nothing is synthesized until you approve.

From then on the dashboard carries the board, the ledger strip, and the inbox. You can drop a note
in at any time without blocking the loop, and panic stops dispatch immediately.

### The flags

| | |
|---|---|
| `--plan-only` | scan, intake, research, spec, plan, estimate — then stop. Nothing runs. |
| `--quick` | skip the deep research call and plan one task. A hint, not a permission — see above. |
| `--budget <minutes>` | wall-clock ceiling for the mission. Default 240. |
| `--unattended` | skip sign-off. Requires `--saved` or `--force`, and is never written to config. |
| `--saved <name>` | replay a saved mission — goal, envelope, criteria skeleton. Scan and research still re-run. |
| `--force` | the explicit acknowledgement `--unattended` needs when there is no `--saved`. |
| `--no-web` | no dashboard. For CI, where binding a port is a nuisance and nobody will open it. |

Wall-clock is the ceiling that actually binds. Token budgets are secondary and cover only the
measured portion — a subscription CLI does not report usage, so the estimate splits measured from
unmeasured rather than showing one confident number that omits most of the spend.

### The other commands

```bash
orchestra serve                            # the dashboard that outlives missions
orchestra resume <missionId>               # replay the log, reconcile orphans, carry on
orchestra forget <missionId>               # delete everything a mission wrote
orchestra save <missionId> --as <name>     # keep the mission to replay with --saved
orchestra promote <missionId> <taskId> --as <name>   # keep the agent as a role
orchestra metrics <missionId> [--json]     # what each decision point cost
orchestra doctor                           # what is installed, authed, and missing
```

`orchestra serve` is the only command a normal run needs: compose a mission, watch any of them,
answer a parked one, resume, save, promote, and a `doctor` panel are all on the page. One composed
mission per workspace, and a workspace is a directory that was probed rather than one that was
declared.

`metrics --json` is the form that matters while tuning, because the point of collecting any of it is
diffing two runs of the same goal. Spend is attributed per decision point — `call:research`,
`call:plan` — rather than lumped into one "orchestration" figure.

`resume` is not a repair tool, it is the normal way back in. A mission left at its sign-off screen
overnight survives a restart and is approved through the same code path an attended run uses. A
`--plan-only` mission is resumed by typing `resume`, and typing it is the sign-off.

### Working in one repo while the orchestrator lives in another

`npm link` is the ordinary path. During development, `TARGET_REPO` points a source run at a
different repo without linking:

```bash
cd /path/to/orchestra
TARGET_REPO="$HOME/scratch/trial" npm run dev -- run "<goal>" --plan-only
```

State then lands in `$TARGET_REPO/.orchestra`, and worktrees beside it.

## How it works

```
  events.jsonl ──fold──►  MissionState  ──►  mission.json + tasks.json
   (source of truth)      (pure reducer)     (projections — safe to delete)
```

The loop is a TypeScript `while`, not a conversation. A model is called at six fixed decision
points — `research`, `intake`, `plan`, `synthesize`, `progress`, `judge` — each with a fresh context
built by folding the log, each returning a structured value that becomes an event. Between calls,
TypeScript owns everything: the counters, the budget, lease overlap, DAG readiness, and the criteria
freeze. A model never enforces an invariant.

That is what makes the whole thing testable without spending anything. `src/loop/calls.ts` is the
seam; a canned `events.jsonl` plus scripted answers drives every path above it.

- **The event log** (`src/events/`) — the §9.1 union, a synchronous append that keeps `seq` gapless,
  and four replay rules: a gap is fatal, an unknown schema version is fatal, an unknown event type is
  skipped with a warning, a malformed known event is fatal.
- **The domain** (`src/domain/`) — `Mission`, `Task`, the two ledgers, `Envelope`, `WorkerReport`.
  Git is a property of `CodeTask`, not of work in general.
- **The loop** (`src/loop/`, `src/scheduler/`) — ready set, per-kind concurrency, stall and reset
  counters, typed retry, criterion checks fired on completion rather than on a clock.
- **Synthesis** (`src/loop/synthesize.ts`, `src/workers/`) — an agent authored per task, drawing
  tools from a catalogue the mission's envelope resolves to. A spec that reaches outside the
  envelope, names a transport that is not built, or declines to declare its file lease is refused at
  validation, not at dispatch.
- **The roster** (`src/agents/`, `agents/`) — eighteen documented roles synthesis may start from
  instead of writing a system prompt from scratch every time. See below.
- **Isolation** (`src/git/`) — worktrees pinned to an explicit base sha, a serialized merge queue
  that asserts its base and aborts cleanly on conflict.
- **Resilience** (`src/runtime/`) — orphan reconciliation, graceful shutdown that prints the resume
  command, ring-buffered subprocess output, SIGTERM → SIGKILL escalation.

## The agent roster

Synthesis used to author a full system prompt for every task. Eighteen documented roles now ship
under `agents/` — ten `code`, four `review`, four `research` — and a spec may start from one:

```
- code-reviewer (review) [fs.read]: Reviews a change for correctness, security and
  maintainability, ranked by severity, with a concrete failure scenario for each finding.
- minimal-change-engineer (code) [fs.read fs.write shell.run]: Surgical fixer for a known
  defect: reproduce, fix at the root, change as little as possible, prove it with a test.
```

**The orchestrator never reads a role's body.** It is shown that index and nothing else — 18 lines,
about 820 tokens — and answers with `basedOn: "code-reviewer"` plus a short paragraph saying what
*this* task needs. The role's ~30-line body is read from disk and composed into the spec before the
event is written, so the log still carries a complete prompt: `fold`, replay, and the committed
receipt are untouched by the roster's existence, and a mission stays readable from its own log.

Naming a role grants nothing. The capability classes in brackets are a hint about the shape of the
work; `tools`, the transport, and the file lease are still the model's own answer and are still
checked against the mission's envelope. Writing a spec from scratch remains a normal answer — the
roster is a starting point, not the set of things the system can do.

Add your own as markdown under `.orchestra/agents/`, where they shadow a shipped role of the same
name:

```markdown
---
name: migration-writer
description: Writes reversible schema migrations and the backfill that goes with them.
worker: code
suggests: fs.read, fs.write, shell.run
---

You write database migrations...
```

`orchestra promote <missionId> <taskId> --as <name>` keeps an agent that worked as a role, and
promoted roles join the same index.

Two limits are enforced rather than advised, because the index is paid for on **every** synthesize
call of every mission: a description is capped at 160 characters by the schema, and the whole
rendered index at 4,000 by a test that fails if a nineteenth entry pushes it over. The roles are
derived from [agency-agents](https://github.com/msitarzewski/agency-agents) (MIT, attributed in
`NOTICE`) and substantially rewritten.

## Develop

```bash
npm run build     # tsc → dist/, then the dashboard bundle → dist/web/app.js
npm test          # 1191 tests, ~95s
npm run typecheck
npm run dev -- doctor
```

A single file: `node --import tsx --no-warnings --test src/events/fold.test.ts`.

Build before testing on a fresh checkout: the dashboard is a bundle, and the suite asserts the route
that serves it. There is no lint and no formatter — typecheck, build, and test are the whole gate,
and CI runs exactly that on Node 22 and 24, with a separate job proving the shipped binary starts on
Node 20. [`CONTRIBUTING.md`](./CONTRIBUTING.md) has the conventions a first patch has to hit.

Working on the dashboard itself: `npm run build:web -- --watch` alongside `npm run dev`, or the page
you reload is the one you built last.

**One rule the suite cannot enforce for you.** `src/loop/agentCalls.ts` is the file the fixture
harness substitutes for, so a green suite says nothing about what a model actually receives. Six
defects hid there behind 331 passing tests until the first real run. If you change a prompt, a
schema, or a decision point's input, do one real `--plan-only` run against a scratch directory
before believing it.

That applies to the roster too, and to its whole reason for existing. The suite proves a role is
offered, resolved, and composed; it cannot tell you the arrangement saves anything. Run the same
goal twice — once with `agents/` moved aside — and diff `call:synthesize` in
`orchestra metrics --json`.

## A note on `.orchestra/`

Mission state holds screenshots of logged-in sessions, event-log entries quoting real records, and
worker reports containing real names. The directory is created `0700`, its files `0600`, and the
`.gitignore` entry is re-asserted on **every** run rather than written once — the failure being
prevented is somebody deleting the line. `orchestra forget <missionId>` deletes a mission outright.
Disk encryption is assumed, not provided.

Each task also gets `.orchestra/missions/<id>/artifacts/<taskId>/`, which is the one place a worker
without a git worktree may write. Check output and judge verdicts are kept there too, because the
log carries only a tail and a mission sometimes has to be re-argued weeks later.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

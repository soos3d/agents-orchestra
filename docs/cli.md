# CLI reference

- [`orchestra run`](#orchestra-run)
- [Flags](#flags)
- [Quick mode](#quick-mode)
- [Moonshot mode](#moonshot-mode)
- [The other commands](#the-other-commands)
- [Working across two repos](#working-across-two-repos)

---

## `orchestra run`

```bash
orchestra run "<goal>" [flags]
```

Work in a scratch repo the first time. Workers are given a real git worktree and a real shell, and
they will edit the repository you point them at.

```bash
mkdir -p ~/scratch/trial && cd ~/scratch/trial
git init && git commit --allow-empty -m "init"
```

### Plan without paying for it

```bash
orchestra run "write a RISKS.md covering the security risks of running coding agents
               unattended, with a mitigation for each" --plan-only
```

`--plan-only` runs the cheap half: a silent scan, up to three intake questions **on stdin**, then
research, the outcome spec, the plan, and an estimate — and stops. Nothing is dispatched and no agent
is synthesized. It costs a handful of orchestrator calls, it is the CI gate, and it exits non-zero if
any criterion was rejected for having no way to check it.

Intake asks only what the scan made answerable. Press Enter to skip a question; the answer becomes a
labelled guess on the sign-off screen instead.

### The full run

Drop the flag:

```bash
orchestra run "add a clamp(value, min, max) helper, in its own file with a colocated
               test, following the conventions already in src/" --budget 30
```

It prints a dashboard URL on `127.0.0.1` within a few seconds. Open it. The sign-off screen renders
there and in the terminal at the same time, and whichever one you answer first wins — approve, or
type feedback and it replans. **Nothing is synthesized until you approve.**

From then on the dashboard carries the board, the ledger strip, and the inbox. You can drop a note in
at any time without blocking the loop, and panic stops dispatch immediately.

---

## Flags

| Flag | Effect |
|---|---|
| `--plan-only` | scan, intake, research, spec, plan, estimate — then stop. Nothing runs. |
| `--quick` | skip the deep research call and plan one task. A hint, not a permission — [see below](#quick-mode). |
| `--moonshot` | a job worth spending on: a second critic round, and the critic reads the design note — [see below](#moonshot-mode). Refused with `--quick`. |
| `--budget <minutes>` | wall-clock ceiling for the mission. Default 240. |
| `--unattended` | skip sign-off. Requires `--saved` or `--force`, and is never written to config. |
| `--saved <name>` | replay a saved mission — goal, envelope, criteria skeleton. Scan and research still re-run. |
| `--force` | the explicit acknowledgement `--unattended` needs when there is no `--saved`. |
| `--no-web` | no dashboard. For CI, where binding a port is a nuisance and nobody will open it. |
| `--harness <id>` | how the workers run: `<transport>/<agent>`, e.g. `acp/claude`. Defaults to what this machine offers — see `doctor`. |
| `--worker-model <m>` | the model workers run on. `acp/claude` and `acp/codex` pick their own and ignore it; `acp/opencode` honours it. |
| `--orchestrator-model <m>` | the model the decision points run on, for this mission only. |
| `--staff <pairs>` | run named decision points on a verified model card or tier (`fast`, `worker`, `strong`, `frontier`): `--staff plan=fast,research=<card>`. `doctor` is what makes a card offerable; `judge` is not staffable. See [models](./models.md). |
| `--factory` | fill still-empty staffable points with the cheapest probed `fast` (else `worker`) card. Opt-in. Refused if this machine has neither. |
| `--scan <name>` | let the outcome spec gate on a security scanner (`deepsec`). Off by default — a scan runs an AI agent over the changed files and costs real money per file. Not with `--quick`. |
| `--research-web` | let the research pass read the web (WebSearch, WebFetch). Off by default; not with `--quick` or `--staff research=<card>`. |
| `--domain <host>` | a host `--research-web` may fetch (repeatable). WebFetch is held to the list; search is not, because results come from a backend rather than a host. A denied fetch lands in the inbox. |
| `--env <NAME>` | let this mission's workers read one environment variable, by name (repeatable). Without it a mission plans against mocks and asks. The value is read from your shell, never typed here and never written to the log. |

### On budgets

Wall-clock is the ceiling that actually binds. Token budgets are secondary and cover only the
measured portion — a subscription CLI does not report usage, so the estimate splits measured from
unmeasured rather than showing one confident number that omits most of the spend.

---

## Quick mode

Most of a plan-only run's cost is the deep `research` call and a planner told to decompose. A mission
you already understand needs neither:

```bash
orchestra run "fix the off-by-one in parseRange" --quick --plan-only
```

`--quick` keeps the scan's own brief and criteria instead of throwing them away and researching
again, and it asks the planner for one task rather than a decomposition.

Measured on the same goal:

| | Tokens | Time |
|---|---|---|
| `--quick` | 8,194 | 1m53s |
| Standard | 15,921 | 3m35s |

### It is a hint, never a permission

The outcome-spec gate is unchanged. A scan-derived spec that fails it escalates to the deep call the
mission skipped — so ticking the box on a job that was not small costs one call, not a run.

Two other things buy the deep call back, both structural:

- **An answered intake question**, because the scan runs before intake and its criteria would predate
  the answer.
- **The first send-back at sign-off**, because rejecting a quick plan contradicts your own checkbox,
  and replanning over scan-depth findings would answer that with the same thin ground twice.

The compose card in the dashboard has the same thing as a checkbox.

---

## Moonshot mode

The opposite judgment about the same job, and a preset over knobs that already exist rather than a
mode of its own:

```bash
orchestra run "migrate the billing service off the legacy ledger" --moonshot
```

A moonshot mission runs every standard pass — architect, design note, plan critic, three-seat judge
panel — and turns two of them up:

- **A second critic round.** The plan the critic bought is itself critiqued once, and then the
  critic stops. Two rounds, not "until quiet": a critic with no ceiling is a budget leak whatever
  asked for it.
- **A design review round.** The critic is handed the architect's design summary, so "the plan does
  not build what was designed" becomes an objection it can raise — and one the planner can act on in
  the replan it already buys.

It grants nothing. Every gate, cap, envelope and criteria freeze is the one a standard mission has.

`--quick --moonshot` is refused at parse, and the two checkboxes together are refused by the server:
a job is not both small enough to skip the deep research pass and worth a second critic round.

The judge panel is unchanged at three seats. Quorum is a strict majority of the votes cast, so a
two-seat panel is not a bigger panel — it is one where an even split is unmet and either seat can
veto the other.

---

## The other commands

```bash
orchestra serve                            # the dashboard that outlives missions
orchestra resume <missionId>               # replay the log, reconcile orphans, carry on
orchestra forget <missionId>               # delete everything a mission wrote
orchestra save <missionId> --as <name>     # keep the mission to replay with --saved
orchestra promote <missionId> <taskId> --as <name>   # keep the agent as a role
orchestra metrics <missionId> [--json] [--staffing]   # what each decision point cost
orchestra doctor                           # what is installed, authed, and missing
```

**`orchestra serve`** is the only command a normal run needs: compose a mission, watch any of them,
answer a parked one, resume, save, promote, and a `doctor` panel are all on the page. One composed
mission per workspace, and a workspace is a directory that was probed rather than one that was
declared.

**`orchestra metrics --json`** is the form that matters while tuning, because the point of collecting
any of it is diffing two runs of the same goal. Spend is attributed per decision point —
`call:research`, `call:plan` — rather than lumped into one "orchestration" figure. Add
`--staffing` for the model split: per decision point, what it was staffed to, what actually
answered, tokens, cost, and send-backs.

**`orchestra resume`** is not a repair tool, it is the normal way back in. A mission left at its
sign-off screen overnight survives a restart and is approved through the same code path an attended
run uses. A `--plan-only` mission is resumed by typing `resume`, and typing it is the sign-off.

---

## Working across two repos

Working in one repo while the orchestrator lives in another: `npm link` is the ordinary path. During
development, `TARGET_REPO` points a source run at a different repo without linking:

```bash
cd /path/to/orchestra
TARGET_REPO="$HOME/scratch/trial" npm run dev -- run "<goal>" --plan-only
```

State then lands in `$TARGET_REPO/.orchestra`, and worktrees beside it.

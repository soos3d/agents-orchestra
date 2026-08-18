# Status

**Phases 1–7 have landed.** A mission runs end to end.

## What works

| Area | State |
|---|---|
| The loop | scan → intake → research → outcome spec → plan → sign-off → synthesis → dispatch → verification → merge → replan |
| Memory | recalls lore before the scan, writes back on completion |
| Saved missions | replay with `--saved` |
| Dashboard | attended runs serve one on loopback; `orchestra serve` outlives missions — compose, watch, answer a parked question, resume, pause, save, promote, forget, inspect a task's diff and evidence, and manage multiple workspaces |
| `ask_human` | parks exactly the tasks it blocks; the rest keep running |
| ACP workers | a pinned adapter per target (`acp/opencode` is the deliberate exception — it is the agent's own subcommand, nothing to pin), a real permission channel in place of `--dangerously-skip-permissions` |
| Worker lanes | `cli/claude`, `cli/codex`, `cli/pi`, `acp/claude`, `acp/codex`, `acp/opencode` — the open-model lanes (`cli/pi`, `acp/opencode`) run factory models by config alone |
| Research web access | `--research-web` grants the deep research pass WebSearch/WebFetch; `--domain <host>` constrains what WebFetch may reach. Off by default |
| Spend attribution | `metrics --staffing`: per decision point, staffed-to vs actually-answered, tokens, cost, send-backs |

A real mission has gone from brief to `complete` uninterrupted over ACP: six synthesized agents, five
real merges, nine criteria met with evidence.

A later staffed run (architect on a Nebius card, worker on `acp/claude`) is the public
[calculator receipt](./receipts/2026-08-18-calculator.md).

## Recent work: cheaper, not more capable

- **`--quick`** skips the deep research call on a job you already understand, halving a plan-only
  run. See [Quick mode](./cli.md#quick-mode).
- **The roster** — synthesis now starts from eighteen documented roles instead of authoring a system
  prompt from scratch for every task. It reads one line per role, never the bodies. See
  [The agent roster](./agent-roster.md).

## Landed since: providers, containment, staffing, panels, secrets

| Area | State |
|---|---|
| Model cards | a model is offered only once `orchestra doctor` has probed it and written the transcript its `verifiedBy` names. See [Models and providers](./models.md) |
| Staffed decision points | `--staff plan=<card>` routes one of seven decision points through an OpenAI-compatible provider; `judge` is excluded by shape, because it reads the artifacts it grades |
| Architect + plan critic | research splits into researcher → architect for non-quick missions, the architect writes a design note workers are handed by path, and the plan is attacked once before dispatch |
| `--moonshot` | the opposite of `--quick` and a preset over the same knobs: a second critic round, and the critic reads the design note. Refused alongside `--quick`. See [Moonshot mode](./cli.md#moonshot-mode) |
| Judge panels | criteria that gate sign-off are judged by three seats with distinct lenses and resolved by strict majority; quick missions still convene one |
| Gates before judges | deterministic checks run first, and a failure suppresses that round's panels at no judge spend |
| Scanner gate | `--scan deepsec` runs a specialist over the merged tree; absent or ungranted, the `VerifySpec` variant is refused at `writeOutcomeSpec` rather than skipped |
| Containment | a worker can run in a disposable container with the worktree mounted at the same path inside and out, network default-deny. Needs `ORCHESTRA_CONTAINER_IMAGE` — there is no default image |
| Secrets | a missing credential is a question, not a stop: the mission plans against mocks and carries on. `--env` grants names only, and granted values are scrubbed from reports and evidence |

**Not yet proven end to end:** a secrets-flow mission running all the way to `complete` — both
evidence runs parked on a provider 529 before their last criterion.

## Not built

- Computer use and its approval gates
- Phone inbox (no carrier)

Started and named rather than half-wired:

- Killing a single task
- The artifact retention sweep (the scheduled purge half; `forget` exists)
- Streaming live worker activity to the dashboard
- Compose controls for containment and scanners (both are CLI or saved-mission only)

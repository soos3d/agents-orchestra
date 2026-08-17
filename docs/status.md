# Status

**Phases 1–7 have landed.** A mission runs end to end.

## What works

| Area | State |
|---|---|
| The loop | scan → intake → research → outcome spec → plan → sign-off → synthesis → dispatch → verification → merge → replan |
| Memory | recalls lore before the scan, writes back on completion |
| Saved missions | replay with `--saved` |
| Dashboard | attended runs serve one on loopback; `orchestra serve` outlives missions — compose, watch, answer a parked question, pause, forget |
| `ask_human` | parks exactly the tasks it blocks; the rest keep running |
| Phone mirror (trust core) | carrier-independent and tested: single-use nonces, one bound sender, replay approves once |
| ACP workers | a pinned adapter per target, a real permission channel in place of `--dangerously-skip-permissions` |

A real mission has gone from brief to `complete` uninterrupted over ACP: six synthesized agents, five
real merges, nine criteria met with evidence.

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
| Judge panels | criteria that gate sign-off are judged by three seats with distinct lenses and resolved by strict majority; quick missions still convene one |
| Gates before judges | deterministic checks run first, and a failure suppresses that round's panels at no judge spend |
| Scanner gate | `--scan deepsec` runs a specialist over the merged tree; absent or ungranted, the `VerifySpec` variant is refused at `writeOutcomeSpec` rather than skipped |
| Containment | a worker can run in a disposable container with the worktree mounted at the same path inside and out, network default-deny. Needs `ORCHESTRA_CONTAINER_IMAGE` — there is no default image |
| Secrets | a missing credential is a question, not a stop: the mission plans against mocks and carries on. `--env` grants names only, and granted values are scrubbed from reports and evidence |

**Not yet proven end to end:** a secrets-flow mission running all the way to `complete` — both
evidence runs parked on a provider 529 before their last criterion.

**No control chooses containment or a scanner from the dashboard yet.** Both are CLI or saved-mission
only.

## Not built

- Computer use and its approval gates
- The concrete phone carrier for the inbox

Started and named rather than half-wired:

- Killing a single task
- Resuming a parked mission from the server rather than the CLI
- The artifact retention sweep
- Streaming live worker activity to the dashboard

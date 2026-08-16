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

## Not built

- Computer use and its approval gates
- The concrete phone carrier for the inbox

Started and named rather than half-wired:

- Killing a single task
- Resuming a parked mission from the server rather than the CLI
- The artifact retention sweep
- Streaming live worker activity to the dashboard

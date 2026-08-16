# How it works

```
  events.jsonl ──fold──►  MissionState  ──►  mission.json + tasks.json
   (source of truth)      (pure reducer)     (projections — safe to delete)
```

The loop is a TypeScript `while`, not a conversation. A model is called at **six fixed decision
points** — `research`, `intake`, `plan`, `synthesize`, `progress`, `judge` — each with a fresh
context built by folding the log, each returning a structured value that becomes an event.

Between calls, TypeScript owns everything: the counters, the budget, lease overlap, DAG readiness,
and the criteria freeze. **A model never enforces an invariant.**

That is what makes the whole thing testable without spending anything. `src/loop/calls.ts` is the
seam; a canned `events.jsonl` plus scripted answers drives every path above it.

## The pieces

| Module | What it owns |
|---|---|
| `src/events/` | The §9.1 union, a synchronous append that keeps `seq` gapless, and four replay rules. |
| `src/domain/` | `Mission`, `Task`, the two ledgers, `Envelope`, `WorkerReport`. Git is a property of `CodeTask`, not of work in general. |
| `src/loop/`, `src/scheduler/` | Ready set, per-kind concurrency, stall and reset counters, typed retry, criterion checks fired on completion rather than on a clock. |
| `src/loop/synthesize.ts`, `src/workers/` | An agent authored per task, drawing tools from a catalogue the mission's envelope resolves to. |
| `src/agents/`, `agents/` | Eighteen documented roles synthesis may start from. See [the roster](./agent-roster.md). |
| `src/git/` | Worktrees pinned to an explicit base sha, a serialized merge queue that asserts its base and aborts cleanly on conflict. |
| `src/runtime/` | Orphan reconciliation, graceful shutdown that prints the resume command, ring-buffered subprocess output, SIGTERM → SIGKILL escalation. |

### The four replay rules

1. A gap is fatal.
2. An unknown schema version is fatal.
3. An unknown event type is skipped with a warning.
4. A malformed known event is fatal.

### Synthesis validation

A spec that reaches outside the envelope, names a transport that is not built, or declines to declare
its file lease is refused **at validation, not at dispatch**.

---

## A note on `.orchestra/`

Mission state holds screenshots of logged-in sessions, event-log entries quoting real records, and
worker reports containing real names.

- The directory is created `0700`, its files `0600`.
- The `.gitignore` entry is re-asserted on **every** run rather than written once — the failure being
  prevented is somebody deleting the line.
- `orchestra forget <missionId>` deletes a mission outright.
- Disk encryption is assumed, not provided.

Each task also gets `.orchestra/missions/<id>/artifacts/<taskId>/`, which is the one place a worker
without a git worktree may write. Check output and judge verdicts are kept there too, because the log
carries only a tail and a mission sometimes has to be re-argued weeks later.

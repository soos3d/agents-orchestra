# How it works

```
  events.jsonl ──fold──►  MissionState  ──►  mission.json + tasks.json
   (source of truth)      (pure reducer)     (projections — safe to delete)
```

The loop is a TypeScript `while`, not a conversation. A model is called at **eight fixed decision
points** — `research`, `architect`, `intake`, `plan`, `critique`, `synthesize`, `progress`,
`judge` — each with a fresh context built by folding the log, each returning a structured value
that becomes an event. The list is closed: a model call that is not one of these does not exist.

Between calls, TypeScript owns everything: the counters, the budget, lease overlap, DAG readiness,
and the criteria freeze. **A model never enforces an invariant.**

That is what makes the whole thing testable without spending anything. `src/loop/calls.ts` is the
seam; a canned `events.jsonl` plus scripted answers drives every path above it.

## Principles

1. **Build the brain, adopt the hands.** Coding agents, worktrees, and parallel execution are
   commodity. Orchestra's value is the layer around them: define success, plan, staff, verify,
   detect failure, replan, enforce safety.
2. **One mission contract.** Every criterion answers: what does done mean, and how can we prove it?
3. **The outcome is frozen; the plan is flexible.** After sign-off, plans, tasks and assumptions
   stay revisable. Criteria do not — changing one requires human approval
   (`criteria_change_requested` is the only door).
4. **The loop is a program, not a conversation.** Code owns state, scheduling, budgets, limits,
   permissions, leases, termination, recovery. Models own the eight decision points above, and
   nothing else.
5. **Verify artifacts, not claims.** A worker does not get to declare itself successful. The judge
   reads the evidence; the writer never grades its own paper.
6. **Replanning is informed.** The ledger carries verified facts, guesses, unknowns and dead ends
   forward, so a replan is a new strategy, not a retry.
7. **Not progressing and in a loop are different.** The first can justify more resources; the
   second triggers a replan.
8. **Agents are task-specific and capability-bounded.** Synthesis may start from a documented
   roster role (`basedOn`) — a role contributes a system prompt and nothing else, and its body
   never enters the orchestrator's context. Named or invented, a spec is validated against the
   mission's envelope; naming a role grants nothing.
9. **Human involvement is front-loaded.** Clarify, sign off, then leave; execution is asynchronous,
   interrupted only by gates and parked questions.
10. **Safety boundaries are enforced by code.** Prompts are not security boundaries.
11. **Everything is resumable.** A crash means `orchestra resume`, never start over.

## The two loops

The **outer loop** answers *what should we do*:

```
scan → intake (≤3 questions, asked once) → research → outcome contract (architect)
  → plan → critique (one objection buys one replan; a moonshot mission gets two rounds) → estimate
  → human sign-off  ← criteria, plan and estimate approved together; the freeze happens here
  → agent synthesis ← nothing is synthesized until a human approves
```

A quick mission skips research, the architect and the critic — the scan's own brief and criteria
are the sole pass.

The **inner loop** answers *are we actually getting closer*, once per round:

```
task selection (the scheduler's ready set)
  → dispatch → execute → collect artifacts
  → commit the worktree        ← a worker leaves its work uncommitted otherwise
  → repo-escape check          ← a worker with no worktree may not have edited the checkout
  → task verification          ← the task's own VerifySpec
  → repo janitor               ← the project's own discovered check, code tasks only
  → merge                      ← serialized, base asserted; an empty merge is a failure
  → criterion checks           ← fired when the last task a criterion depends on lands
  → progress evaluation        → next round | replan | complete
```

Agent synthesis is **not** a per-round step: an agent is synthesized when a task is first planned
or when a replan redefines it. An edges-only replan keeps the agent it has. The steps between
artifact collection and the merge are gates, not bookkeeping — each is a place where correct,
finished work was once lost or graded wrongly.

## Workers

Five kinds: `code`, `research`, `review`, `general`, `computer`. **Git is a property of `code`
tasks** — worktree, file lease, auto-commit, merge. The other four get an artifact directory
instead. The rule that follows, enforced at planning and dispatch: **a goal that changes
repository files is a `code` task, whatever else it is doing.**

## Verification

Three gates, deliberately distinct:

1. **Task verification** — did this worker do its assigned task? (the `VerifySpec`)
2. **The repo janitor** — did it break something it was not asked about? The project's own
   discovered check, run in the worktree before the merge. Discovered, never invented: no check
   found means no gate, not an assumed `npm test`.
3. **Mission verification** — does the overall result satisfy the contract? Deterministic checks
   run before judges; criteria that gate sign-off are judged by a three-seat panel with distinct
   lenses, resolved by strict majority.

All tasks green with criteria unsatisfied is not a contradiction — it means the plan was wrong,
which triggers a replan rather than a false success.

## The pieces

| Module | What it owns |
|---|---|
| `src/events/` | The event union (58 types), a synchronous append that keeps `seq` gapless, and four replay rules. |
| `src/domain/` | `Mission`, `Task`, the two ledgers, `Envelope`, `WorkerReport`. Git is a property of `CodeTask`, not of work in general. |
| `src/loop/`, `src/scheduler/` | Ready set, per-kind concurrency, stall and reset counters, typed retry, criterion checks fired on completion rather than on a clock. |
| `src/loop/synthesize.ts`, `src/workers/` | An agent authored per task, drawing tools from a catalogue the mission's envelope resolves to. |
| `src/agents/`, `agents/` | Eighteen documented roles synthesis may start from. See [the roster](./agent-roster.md). |
| `src/git/` | Worktrees pinned to an explicit base sha, a serialized merge queue that asserts its base and aborts cleanly on conflict. |
| `src/runtime/` | Orphan reconciliation, graceful shutdown that prints the resume command, ring-buffered subprocess output, SIGTERM → SIGKILL escalation. |
| `src/providers/` | Model cards, the probe, and the OpenAI-compatible call path. See [models](./models.md). |

### The four replay rules

1. A gap is fatal.
2. An unknown schema version is fatal.
3. An unknown event type is skipped with a warning.
4. A malformed known event is fatal.

The fold's handler table is a mapped type over the event union, so an event type nobody handles is
a compile error — the union is the one list in this system that cannot drift silently.

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

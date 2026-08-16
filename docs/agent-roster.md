# The agent roster

Synthesis used to author a full system prompt for every task. Eighteen documented roles now ship
under `agents/` — ten `code`, four `review`, four `research` — and a spec may start from one.

The index the orchestrator sees is one line per role:

```
- code-reviewer (review) [fs.read]: Reviews a change for correctness, security and
  maintainability, ranked by severity, with a concrete failure scenario for each finding.
- minimal-change-engineer (code) [fs.read fs.write shell.run]: Surgical fixer for a known
  defect: reproduce, fix at the root, change as little as possible, prove it with a test.
```

## The orchestrator never reads a role's body

It is shown that index and nothing else — 18 lines, about 820 tokens — and answers with
`basedOn: "code-reviewer"` plus a short paragraph saying what *this* task needs.

The role's ~30-line body is read from disk and composed into the spec **before the event is written**,
so the log still carries a complete prompt: `fold`, replay, and the committed receipt are untouched by
the roster's existence, and a mission stays readable from its own log.

## Naming a role grants nothing

The capability classes in brackets are a hint about the shape of the work. `tools`, the transport, and
the file lease are still the model's own answer and are still checked against the mission's envelope.

Writing a spec from scratch remains a normal answer — the roster is a starting point, not the set of
things the system can do.

## Adding your own

Add markdown under `.orchestra/agents/`, where they shadow a shipped role of the same name:

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

## Two enforced limits

The index is paid for on **every** synthesize call of every mission, so these are enforced rather than
advised:

| Limit | Enforced by |
|---|---|
| Description ≤ 160 characters | the schema |
| Rendered index ≤ 4,000 characters | a test that fails if a nineteenth entry pushes it over |

## Attribution

The roles are derived from [agency-agents](https://github.com/msitarzewski/agency-agents) (MIT,
attributed in [`NOTICE`](../NOTICE)) and substantially rewritten.

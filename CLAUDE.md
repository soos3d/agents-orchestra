# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-process looping orchestrator: given a mission goal it researches, writes an outcome
spec, plans tasks, synthesizes a purpose-built agent per task, runs them in parallel git
worktrees, verifies, and re-plans each round. One npm package, one `orchestra` bin, no services
and no database — setup simplicity is a hard constraint, not a cleanup item.

**Phases 1 and 2 exist.** `orchestra run "<goal>"` researches, writes an outcome spec, plans,
synthesizes, dispatches, verifies, merges, and replans; `--plan-only` stops after the estimate.
Other commands: `doctor`, `resume <missionId>`, `forget <missionId>`, `help`.

`src/loop/calls.ts` is still the seam: the five model calls (`research`, `plan`, `synthesize`,
`progress`, `judge`) as an interface, implemented for real in `loop/agentCalls.ts` and scripted in
`testing/fixtures.ts`. **Everything above that interface is tested with no model and no spend, and
it should stay that way** — a test that needs a live call belongs behind an injected transport.

Unproven: a whole mission of non-coding tasks against a real model (the one open Phase 2 exit
criterion). Phase 3 — sign-off, intake, the web shell — has not started, so the loop auto-approves
its own sign-off and records that it did.

The design docs are authoritative and code comments cite them by section number (`§9.1`,
`§2a rule 5`, "defect 13"). Read the cited section before changing the behavior it describes.

- @specs.md — the full design, §0–§17
- @ROADMAP.md — phases, milestone checklist, known-defects table

## Commands

```
npm test          # node:test via tsx over src/**/*.test.ts — the whole suite, ~30s
npm run typecheck # tsc --noEmit (includes tests; the build config excludes them)
npm run build     # tsc -p tsconfig.build.json → dist/
npm run dev       # run the CLI from source, e.g. `npm run dev -- doctor`
```

Single test file: `node --import tsx --no-warnings --test src/events/fold.test.ts`.
Single test by name: append `--test-name-pattern "<name>"`.

There is no lint or format tooling and no CI — `npm run typecheck && npm test` is the only gate.

## Architecture

```
events.jsonl (append-only, the source of truth)
  ──fold()──►  MissionState (pure reducer over the event union)
  ──────────►  mission.json + tasks.json (projections — derived, safe to delete)
```

State lives at `<stateDir>/missions/<missionId>/`, `stateDir` defaulting to `<repo>/.orchestra`.

Workers are subprocesses of external CLIs (`claude`, `codex`) spawned through `runtime/sh.ts`,
cwd'd into a per-task worktree. Model and timeout arrive as arguments from a per-task synthesized
`AgentSpec` — never from a config singleton.

**Adding an event type is a two-file change**: `events/schema.ts` (the discriminated union) then
`events/fold.ts` (the handler table is a mapped type `{ [K in EventType]: Handler<K> }`, so
forgetting the second file is a compile error by design). See the `/add-event` skill.

The loop is a TypeScript `while` over five model calls, not a conversation (§3). Counters, the
criteria freeze, the ready set, and the budget are enforced in `loop/run.ts` and the pure modules it
calls (`scheduler/ready.ts`, `scheduler/validate.ts`, `loop/revise.ts`, `loop/outcomeSpec.ts`); a
model never enforces an invariant. `loop/prompts.ts` builds every call's input as a pure function of
folded state — which is what makes the whole loop assertable against a canned `events.jsonl`.

## Conventions

- **ESM on bare Node: every relative import carries the `.js` extension.** No exceptions.
- Zod at boundaries only — disk reads, event append *and* replay, worker output. Never on internal
  function arguments. Use `safeParse` plus a hand-written message, not `.parse()`.
- `interface` for behavior and shape contracts; `type` only for `z.infer` and unions. Naming:
  `fooSchema` const → `Foo` type.
- No classes except `Error` subclasses. Factory functions returning an object literal typed by an
  interface (`createEventLog`, `createMergeQueue`). Named exports only, zero default exports.
- Dependency injection instead of module singletons: `Io` into `main`, `now`/`onWarn` into
  `createEventLog`, a probe into `reconcileOrphans`. There are no globals — keep it that way.
- Pure core, impure edge: `fold`, `reconcileOrphans`, `violations` return values or events; the CLI
  does the writing. Immutable updates throughout (`{ ...state.mission, … }`, `map`, `readonly`).
- Every error message names the fix (§2a rule 5) — "Fix or delete the file to start fresh.",
  "Narrow one of the tasks or make them sequential."
- Disk writes are atomic: `${file}.${pid}.tmp` then `renameSync`. Dirs 0700, files 0600.
- File header comments are a paragraph of prose explaining *why the file exists* and often name the
  concrete bug being prevented. Match that when adding a file.
- Tests are colocated `*.test.ts`, `node:test` + `node:assert/strict`, real tmp dirs and real git
  repos over mocks (`src/testing/gitRepo.ts`), with a header naming the failure mode under test.

## Gotchas

- `events/log.ts` `append` **must stay synchronous** — gapless `seq` depends on an in-memory
  counter advanced only after the write returns.
- The outcome spec is written by the `research` call, and its `criteria` are deliberately typed
  `unknown[]`. That is what keeps a criterion with no check *representable*, so `writeOutcomeSpec`
  can reject it — typing it as `Criterion[]` would make the system's most important validation
  untestable. **The cost is that `withSchema` renders it as an unconstrained array**, so the model
  is told nothing about a criterion by the derived schema — `RESEARCH_PROMPT` spells out
  `criterionSchema` and the `VerifySpec` union by hand. Change one and change the other.
- **`agentCalls.ts` is the one file the fixture harness cannot cover**, since it is the thing the
  harness substitutes for. Four defects hid there behind 331 green tests until the first real-model
  run. Anything the model *receives* — SDK options, prompt text, a decision point's input — belongs
  in a pure function (`queryOptions`, `withSchema`, `AVAILABLE_TRANSPORTS`) so the next regression
  is catchable for free, and still wants one real `--plan-only` run before you believe it.
- `AVAILABLE_TRANSPORTS` in `workers/transport.ts` is the registry, and it is shorter than §7's
  table. Synthesis is told what it may pick and a spec outside it fails at validation (§7) — not at
  dispatch, where it costs a typed retry and a replan to learn the same thing.
- `attempts` is incremented in `fold`'s `task_status` handler when a task enters `running`; there is
  no separate dispatch event. The §9.4 retry cap reads it.
- Worktrees are pinned to an explicit base sha, never HEAD. Compare paths through
  `fs.realpathSync` (macOS `/var` vs `/private/var`).
- `runtime/command.ts` is a tokenizer, not a shell — no globs, pipes, or substitution.
  `needsShell()` exists so a piped command fails loudly instead of silently misbehaving.
- Requires Node 20+ (`MIN_NODE_MAJOR` in `config/doctor.ts`; nothing enforces it at install time)
  and `claude` / `codex` on PATH, already logged in.
- No env validation layer and no dotenv. `process.env` is read in exactly two places
  (`config/discover.ts`, `index.ts`); every var in `.env.example` is an optional override.
- Everything past the initial commit is uncommitted, so `git log` and `git blame` give no context.

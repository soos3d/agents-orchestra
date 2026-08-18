# CLAUDE.md

Guidance for Claude Code working in this repository. **Read this file only.** The detail behind
every claim here lives in `.claude/notes/` and in `plans/`; load one when you are about to touch
that area, not before.

## What this is

A single-process looping orchestrator: given a mission goal it researches, writes an outcome spec,
plans tasks, staffs each with an agent (roster entry or freshly synthesized), runs them in parallel
git worktrees, verifies, merges, and re-plans each round. One npm package (`@soos3d/orchestra`), one
`orchestra` bin, no services and no database — **setup simplicity is a hard constraint, not a
cleanup item.**

Phases 1–7 and P1–P5 have landed; the dashboard is a real app (U0–U7). Defects 1–42 are closed —
42 last: a worker's child environment is now **constructed** from an `Envelope.env` allowlist rather
than inherited from the process (`workers/childEnv.ts`, and see `.claude/notes/workers.md`).
PLAN-NEXT stages 1–11 are in (that plan is done — archived at `plans/archive/PLAN-NEXT.md`; the
active plan is `plans/v2-plan.md`); 11 gave `research` real web access behind an opt-in grant and
put both open-model worker lanes (`cli/pi`, `acp/opencode`) onto Nebius by config alone.
Branch `feat/phase-3`, no remote. Apache-2.0, prepared to publish; `npm publish` and making the
GitHub repo public are the last steps.

Commands: `run "<goal>" [--quick|--plan-only|--no-web|--unattended|--staff <pairs>]`, `serve`,
`doctor`, `resume`, `forget`, `save … --as`, `promote … --as`, `metrics [--json|--staffing]`,
`help`. `serve` is the only command a normal run needs. `run` takes more grant flags than that
list shows — `--scan`, `--env`, `--research-web`, `--domain`; `orchestra help` is the full set.

## Where the detail is

| You are about to… | Read first |
|---|---|
| touch `src/web/**` | `.claude/notes/web.md` |
| touch `src/workers/**`, dispatch, envelopes, git leases | `.claude/notes/workers.md` |
| touch spend, tokens, `metrics`, `domain/budget.ts`, `src/providers/**` | `.claude/notes/spend.md` |
| touch `src/loop/**`, `src/agents/**`, decision points | `.claude/notes/loop.md` |
| ask "why is it like this / has this been tried" | `.claude/notes/history.md`, then the notes file for the area |
| plan work | `plans/v2-plan.md` (the active plan) and `plans/ecosystem-analysis.md` (why that order) |

### Docs layout

Tracked and public: `README.md`, `docs/` (the user-facing reference — `architecture.md` is the
conceptual spec now), `CONTRIBUTING.md`, `agents/`, and this file plus `.claude/notes/`.
Maintainer-only and gitignored: `plans/` — `v2-plan.md` and `ecosystem-analysis.md` are the active
strategy; `plans/archive/` holds superseded documents (`PLAN-NEXT.md`, the old `specs.md`,
`SPECS-AUDIT.md`, session handoffs). Do not add new documents at the repo root.

### `§N` citations

**`§N` citations in the source resolve against nothing on disk.** The code carries ~686 of them
(`§9.4`, `§7`, `§17`…); they refer to a retired long-form spec that no longer exists in this repo.
Treat a citation as a marker of *why this shape*: read the comment beside it and the test header,
**do not follow the number anywhere**, do not delete a citation, and do not invent a new one.
What the numbers meant, by subject (full audit: `plans/archive/SPECS-AUDIT.md`):

| Citation | Subject |
|---|---|
| §2, §2a, §2b | core principles; intake's three-question cap |
| §3 | the decision points / the call-loop contract |
| §4, §4.0–§4.2 | task states, criterion-check timing, git as a `code` property |
| §6 | memory: lore, provenance, staling, promotion |
| §7 | transports, the registry, saved missions, envelope validation |
| §8 | file leases, `owns`, overlap and escape detection |
| §9.1 | the event schema union and the four replay rules |
| §9.4 | the failure policy: typed retry, park, escalate |
| §9.5 | the measured/unmeasured spend split |
| §11 | the computer-use security posture |
| §12 | ACP and the transport bet |
| §13 | the run view |
| §17 | what leaves the machine; the risk register |

## Commands

```
npm test          # node:test via tsx over src/**/*.test.ts(x) — ~1,760 tests, ~110s
npm run typecheck # tsc --noEmit (includes tests and the dashboard; build config excludes both)
npm run build     # tsc -p tsconfig.build.json → dist/, then esbuild → dist/web/app.js
npm run build:web # just the dashboard bundle; add `-- --watch` while working on it
npm run dev       # run the CLI from source, e.g. `npm run dev -- doctor`
```

Single file: `node --import tsx --no-warnings --test src/events/fold.test.ts`; add
`--test-name-pattern "<name>"` for one test.

No lint or format tooling — `npm run typecheck && npm test` is the whole gate. **`npm run build`
must run before `npm test` on a fresh checkout** (`web/server.test.ts` asserts the bundle route
returns something); CI does typecheck → build → test. The suite needs Node 21+ (`node --test` gained
globs there); the shipped binary runs on 20 and a separate CI job asserts it. Do not "fix" this by
raising `engines`.

## Architecture

```
events.jsonl (append-only, the source of truth)
  ──fold()──►  MissionState (pure reducer over the event union)
  ──────────►  mission.json + tasks.json (projections — derived, safe to delete)
```

State at `<stateDir>/missions/<missionId>/`, `stateDir` defaulting to `<repo>/.orchestra`.

The loop is a TypeScript `while` over the decision points, **not a conversation**. Counters, the
criteria freeze, the ready set and the budget are enforced in `loop/run.ts` and the pure modules it
calls (`scheduler/ready.ts`, `scheduler/validate.ts`, `loop/revise.ts`, `loop/outcomeSpec.ts`); **a
model never enforces an invariant.** `loop/prompts.ts` builds every call's input as a pure function
of folded state, which is what makes the loop assertable against a canned `events.jsonl`.

Two seams:

- **`loop/calls.ts`** — the model calls (`research`, `architect`, `intake`, `plan`, `critique`,
  `synthesize`, `progress`, `judge`) as an interface; real in `loop/agentCalls.ts`, scripted in
  `testing/fixtures.ts`.
  **Everything above it is tested with no model and no spend — keep it that way.** A test needing a
  live call belongs behind an injected transport.
- **`loop/human.ts`** — the places a mission blocks on a person. Terminal (`cli/terminal.ts`),
  dashboard (`web/webHuman.ts`) and `unattendedHuman` all implement it; `anyOf` takes whichever
  answers first, and `prepareMission` cannot tell them apart.

Workers are subprocesses: external CLIs via `runtime/sh.ts` cwd'd into a per-task worktree, **or**
ACP over `runtime/duplex.ts` + `workers/acp/transport.ts`. Model and timeout come from the per-task
`AgentSpec` — never from a config singleton. `workers/router.ts` maps `TransportRef.id` to a
runtime; `workers/availability.ts` narrows the built list to what *this machine* can start.

### The load-bearing facts, and where each one now lives

Each line below is a claim whose *reasoning* is a paragraph you do not need until you touch that
area. The paragraph moved, unchanged, to the section named after the arrow. **A claim here is not
guessable from the code** — read the paragraph before changing anything it names.

| Claim | Read |
|---|---|
| A harness is `<transport>/<target>` and it is one choice, not two — `staffingOffer` is the one function every composition root calls | `workers.md` → *A harness is one choice, not two* |
| `AgentSpec.model` reaching an ACP agent is per agent (`honoursModel`), and `MODELS_BY_VENDOR.openai` being empty is the answer, not a gap | same section |
| `acp/opencode` is the agent's own subcommand, not an `npx` adapter — `OPENCODE_PERMISSION`, lower-case tool names, `rememberToolName` | `workers.md` → *`acp/opencode`* |
| A model card is evidence: no `verifiedBy` probe transcript, no offer. Card ids are shown to synthesis and never added to `models` | `spend.md` → *Model cards are evidence* |
| A decision point can be staffed to a card; `judge` has no `staffing` field at all, and `resolveStaffing` is where the allowlist door landed | `loop.md` → *Staffing a decision point* |
| The outcome spec is the architect's, a quick mission has no architect, the critic runs before dispatch, one objection buys one replan | `loop.md` → *The architect and the critic* |
| A panel is three seats, the fold applies only the resolved verdict, quorum is a majority of votes cast; deterministic checks close the round to panels | `loop.md` → *The verdict panel* |
| A scanner gate is granted on the envelope, and deepsec's exit 1 does not mean "findings" | `loop.md` → *The deepsec scanner gate* |
| A missing credential is a question, never a stop; the scrubber matches exact values and is applied to what a text was written *from* | `workers.md` → *Secrets* |
| Research reaches the web only where a human granted it, and a grant is not grounding | `loop.md` → *Research on the web* |
| A staffing choice survives into a saved mission, through the door it already had | `loop.md` → *Staffing in a saved mission* |
| There is one list of decision-point names and it is `CALL_NAMES` | `loop.md` → *`CALL_NAMES`* |
| The orchestrator gets a model and no harness | `workers.md` → *The orchestrator gets a model* |
| Containment is a third runtime that wraps the other two; identical mount paths, no default image, `containmentFor` throws | `workers.md` → *Containment* |
| `inspect()` checks the target and the model — a pinned model is a ceiling in code | `workers.md` → *`inspect()`* |
| A harness or model from a browser is checked against what the server offered | `web.md` → *A runtime from a browser* |

**Adding an event type is a two-file change**: `events/schema.ts` (the union) then `events/fold.ts`
(the handler table is a mapped type, so forgetting the second file is a compile error by design).
See the `/add-event` skill.

## Conventions

- **ESM on bare Node: every relative import carries the `.js` extension.** No exceptions.
- Zod at boundaries only — disk reads, event append *and* replay, worker output. Never on internal
  function arguments. `safeParse` plus a hand-written message, not `.parse()`.
- `interface` for behavior and shape contracts; `type` only for `z.infer` and unions.
  `fooSchema` const → `Foo` type.
- No classes except `Error` subclasses. Factory functions returning an object literal typed by an
  interface (`createEventLog`, `createMergeQueue`). Named exports only, zero default exports.
- Dependency injection instead of module singletons — `Io` into `main`, `now`/`onWarn` into
  `createEventLog`, a probe into `reconcileOrphans`. There are no globals; keep it that way.
- Pure core, impure edge: `fold`, `reconcileOrphans`, `violations` return values or events; the CLI
  does the writing. Immutable updates throughout.
- Every error message names the fix — "Fix or delete the file to start fresh.", "Narrow one of the
  tasks or make them sequential."
- Disk writes are atomic: `${file}.${pid}.tmp` then `renameSync`. Dirs 0700, files 0600.
- File header comments are a paragraph of prose explaining *why the file exists*, usually naming the
  concrete bug prevented. Match that when adding a file.
- Tests are colocated `*.test.ts`, `node:test` + `node:assert/strict`, real tmp dirs and real git
  repos over mocks (`src/testing/gitRepo.ts`), with a header naming the failure mode under test.

## Traps

Each of these has cost real time. The reasoning is in the notes file for its area.

- **`agentCalls.ts` and `web/server.ts` are below the fixture harness** — they are what the harness
  substitutes for, so a green suite says nothing about them. Six defects hid in `agentCalls.ts`
  behind hundreds of passing tests. Push anything decidable (`queryOptions`, `withSchema`,
  `eventsSince`, `isAllowedOrigin`) into a pure tested function, and still do one real run.
- **An optional field on a `Deps` interface is a place a feature can be finished and switched off at
  once.** `requestExtension`, `owns` and `reformat` were each built, tested, and reachable through a
  parameter no entry point passed. Test the composition root (`buildLoopDeps`, `runMission`), not
  only the mechanism.
- **`src/loop/prepare.ts` `appendFacts` uses `\0` composite-key separators** (`fact.text` + `\0` +
  `source.ref`). Those used to be literal NUL bytes in the source, which made `rg` treat the file
  as binary and silently skip it — a search for a symbol in this file returned nothing. The
  separators are now the JS escape `\0` (same value at runtime). `grep -a` still works if a
  similar byte ever lands again.
- **`src/web/style.ts` is a template literal; a stray backtick in a comment is a parse error many
  lines later.** Never write `` `tokens.ts` `` in a CSS comment there. `web/style.test.ts` trips on
  it and refuses any interpolation that is not a `tokens.ts` value.
- **`npm run dev` serves whatever `dist/web/app.js` last held.** Run `npm run build:web -- --watch`
  alongside it.
- **End of input is not approval.** `Prompter.ask` returns `undefined` for a closed pipe and `""`
  for a human pressing Enter; conflating them hands sign-off to a shell redirect.
- **`events/log.ts` `append` must stay synchronous** — gapless `seq` depends on an in-memory counter
  advanced only after the write returns.
- **Every scanner over model output has to know what it is inside of.** `needsShell` read a `=>`
  inside a quoted string as a redirect (34); `extractJsonObject` stopped at a fence inside a JSON
  string (38); the ACP reader split a UTF-8 sequence across a chunk boundary (37); and
  `parseCommand` deleted backslashes inside double quotes (44). Four files, one mistake — and all
  four failed on *correct* work, three of them quietly. **44 is the one to read first**: POSIX keeps
  a backslash literal inside double quotes unless the next char is `` $ ` " \ `` or a newline, so a
  check carrying `r'-?\d+\.?\d*'` ran as `r'-?d+.?d*'`, matched nothing, and failed three criteria
  while quoting the correct output of a correct script. The same string pasted into a shell passed.
  **Fixing the tokenizer was only half of it.** Once it behaves like a shell, a check written with
  `\n` between statements fails to parse — correctly, and just as fatally. All three calls that
  author a `command` check (`research`, `plan`, `synthesize`) now say the argument reaches the
  program *exactly as written*, because "no shell" does not tell a model that `\n` is two
  characters. `agentCalls.test.ts` asserts the sentence is in all three; the real run is what
  proved it works, and the same goal went from 4/7 criteria and blocked to 9/9 and complete.
- **Derived output a worker cannot avoid writing is excluded, not blamed** (`git/excludes.ts`,
  defect 43). A plan told a worker to verify with `python3 -m py_compile add.py`; CPython wrote
  `__pycache__/add.cpython-314.pyc`, `git add -A` committed it, and `detectEscape` failed the task
  **without retry** for a file the plan had asked for. The system obliged an artifact and then
  punished it — the P2 collision (27 and 41) in its third shape. `ensureDerivedExcluded` writes a
  delimited block into `$GIT_COMMON_DIR/info/exclude` at every `createWorktree`, which closes both
  halves at once: `git add -A` will not stage an excluded file and `ls-files --others
  --exclude-standard` will not report one. Never the user's tracked `.gitignore` — that is their
  file and their history. **Keep `DERIVED_PATHS` short.** `dist/`, `build/` and `target/` are
  deliberately absent: they are plausible names for real directories, and un-counting one turns a
  genuine scope error into a file that vanishes with the worktree.
- **`src/testing/receipts/` is a real mission's committed log**, replayed and folded by
  `receipt.test.ts`. Re-record it only from a real run.
- **`src/testing/acp-transcripts/` are executable fixtures**, parsed by `acp/protocol.test.ts`.
  Adapter versions are pinned exact in `acp/registry.ts` — bump one and re-capture.
- **A criterion's `criteria` are typed `unknown[]` on purpose** so a criterion with no check stays
  representable and `writeOutcomeSpec` can reject it. The cost: `withSchema` renders it as an
  unconstrained array, so `RESEARCH_PROMPT` spells out `criterionSchema` and the `VerifySpec` union
  by hand. Change one, change the other. Same argument for `AgentSpec.tools: z.array(z.string())`.
- **Worktrees are pinned to an explicit base sha, never HEAD.** Compare paths through
  `fs.realpathSync` (macOS `/var` vs `/private/var`).
- `runtime/command.ts` is a tokenizer, not a shell — no globs, pipes or substitution; `needsShell()`
  exists so a piped command fails loudly.
- No env validation layer and no dotenv. *Configuration* is read from `process.env` in exactly two
  places (`config/discover.ts`, `index.ts`); every var in `.env.example` is an optional override.
  (The runtime also passes `process.env` through as a parent env for subprocesses and reads granted
  secret *values* from it at the composition roots — those are not configuration reads.)
- Requires Node 20+ (`MIN_NODE_MAJOR` in `config/doctor.ts`, unenforced at install) and
  `claude` / `codex` on PATH, already logged in.

# CLAUDE.md

Guidance for Claude Code working in this repository. **Read this file only.** The detail behind
every claim here lives in `.claude/notes/` and in `PLAN.md`; load one when you are about to touch
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
Branch `feat/phase-3`, no remote. Apache-2.0, prepared to publish; `npm publish` and making the
GitHub repo public are the last steps.

Commands: `run "<goal>" [--quick|--plan-only|--no-web|--unattended]`, `serve`, `doctor`, `resume`,
`forget`, `save … --as`, `promote … --as`, `metrics [--json]`, `help`. `serve` is the only command a
normal run needs.

## Where the detail is

| You are about to… | Read first |
|---|---|
| touch `src/web/**` | `.claude/notes/web.md` |
| touch `src/workers/**`, dispatch, envelopes, git leases | `.claude/notes/workers.md` |
| touch spend, tokens, `metrics`, `domain/budget.ts` | `.claude/notes/spend.md` |
| touch `src/loop/**`, `src/agents/**`, decision points | `.claude/notes/loop.md` |
| ask "why is it like this / has this been tried" | `PLAN.md` §4 decisions, §6 gotchas, §7 defects 1–42 |
| plan work | `PLAN.md` §1 status, §2 next |

**`§N` citations in the source do not resolve against `specs.md` as it stands.** The code carries
662 of them (`§9.4`, `§7`, `§17`…); the current `specs.md` was condensed and renumbered and has only
§1–§9, pointing at different subjects. `SPECS-AUDIT.md` has the mapping table. So: treat a citation
as a marker of *why this shape*, read the comment beside it and the test header, **do not follow the
number into `specs.md`**, do not delete a citation, and do not invent one. `specs.md` and `PLAN.md`
are gitignored — they exist on the maintainer's machine only.

## Commands

```
npm test          # node:test via tsx over src/**/*.test.ts(x) — ~1,190 tests, ~95s
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

- **`loop/calls.ts`** — the model calls (`research`, `intake`, `plan`, `synthesize`, `progress`,
  `judge`) as an interface; real in `loop/agentCalls.ts`, scripted in `testing/fixtures.ts`.
  **Everything above it is tested with no model and no spend — keep it that way.** A test needing a
  live call belongs behind an injected transport.
- **`loop/human.ts`** — the places a mission blocks on a person. Terminal (`cli/terminal.ts`),
  dashboard (`web/webHuman.ts`) and `unattendedHuman` all implement it; `anyOf` takes whichever
  answers first, and `prepareMission` cannot tell them apart.

Workers are subprocesses: external CLIs via `runtime/sh.ts` cwd'd into a per-task worktree, **or**
ACP over `runtime/duplex.ts` + `workers/acp/transport.ts`. Model and timeout come from the per-task
`AgentSpec` — never from a config singleton. `workers/router.ts` maps `TransportRef.id` to a
runtime; `workers/availability.ts` narrows the built list to what *this machine* can start.

**A harness is `<transport>/<target>` and it is one choice, not two** (`workers/harness.ts`).
`acp/claude`, `cli/codex` — the pair was never independent, and the cross-product is not the menu:
`cli/opencode` does not exist, and a machine with only `codex` on PATH must never be shown a
`claude` row. `staffingOffer` is the **one** function every composition root calls for
`{transports, targets, models}`; three separately-derived lists across four roots is twelve chances
to wire two of them. `harness.test.ts` pins its unpinned transport answer to `availableTransports`
so the two cannot drift. The choice lives on `mission_created.runtime` — optional, folded like
`quick` — so a resume runs on what was chosen rather than on what the process defaults to.

Three facts about it are load-bearing and none is guessable. **Whether `AgentSpec.model` reaches an
ACP agent is per agent, and only a capture can say.** It does not reach `acp/claude` or `acp/codex`:
the adapter picks its own, and `sessionNewResultSchema.models.currentModelId` is the only place the
client learns which — in the capture, a task specced `claude-sonnet-4-5` ran on `claude-opus-4-6`.
It does reach `acp/opencode`, whose `session/set_model` is refused `-32602` for a model it does not
have, before the prompt. So `Harness.honoursModel` is read off the launch row
(`AcpLaunch.honoursModel`), never derived from the transport id, and the compose card says which
control is real instead of implying one that does nothing. **`MODELS_BY_VENDOR.openai` is empty and that is the answer,
not a gap**: no list of `codex` models has been verified, and empty means *unknown* everywhere it
is read — nothing offered, nothing refused. `MODELS_BY_VENDOR.opencode` is empty for a neighbouring
reason: its menu is the human's own account and arrives on the wire in `session/new`'s
`configOptions`, so there is no list to write down.

**`acp/opencode` landed 2026-08-16 (PLAN-NEXT stage 1)** and is the first ACP row that is not an
`npx` adapter — `opencode acp` is the agent's own subcommand, so there is no package to pin and an
upgrade changes the wire with nothing to review but `protocol.ts`'s schemas. Two facts came out of
the capture and both are in the launch row rather than in prose: `OPENCODE_PERMISSION` is set as a
literal because OpenCode's default agent writes with its own tools and never opens the permission
channel this transport exists for; and its tool names are lower case, which is why `classOf` matches
case-insensitively. A real mission is what caught the third: the permission frame carries no tool
name, OpenCode's later `tool_call_update`s rewrite the title to *what the tool is doing*
(`bash` → `ls -la`), and three granted shell calls arrived as `pwd`, `git` and `python3`, matched no
class, and were refused. `rememberToolName` keeps the first announcement.

And **the orchestrator gets a model and no harness**, because `runViaAgentSdk` *is*
the Agent SDK; a second orchestrator harness is deferred because `queryOptions` encodes Agent-SDK
semantics (`settingSources: []`, the `tools`-vs-`allowedTools` trap) and `withSchema` assumes a
model that follows a derived schema.

**`inspect()` checks the target and the model, and the second had no door at all before.**
`AgentSpec.model` is a required non-empty string that becomes `--model` on a real CLI, written by a
model and checked by nothing — an invented name passed validation, reached the log, and failed at
dispatch with the task already staffed. `transport.target` was the same shape one field along: the
prompt named "claude or codex" *in prose*, so a machine holding one of them still invited a spec
for the other. Both park as planning problems now, and `SYNTHESIZE_PROMPT` changed with them — the
standing rule that a prompt and its validation move together. A pinned model collapses
`allowedModels` to one entry, which is how "run this on haiku" becomes a ceiling in code rather
than a preference a model may reconsider.

**A harness or model from a browser is checked against what the server offered.**
`isOfferedRuntime` (`web/protocol.ts`) is `workspace_add`'s rule applied to a runtime: you cannot
choose one you have not been shown. Pure, and tested in `server.test.ts`, because these strings
decide which binary is spawned and what `--model` it gets — the same reason `compose` carries a
`workspaceId` and never a path.

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
- **`src/loop/prepare.ts` contains a literal NUL byte and is not corrupt** (a `\x00` composite-key
  separator, ~line 538). `rg` calls it binary and silently skips it — a ripgrep search for a symbol
  in this file returns nothing. Use `grep -a`.
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
- No env validation layer and no dotenv. `process.env` is read in exactly two places
  (`config/discover.ts`, `index.ts`); every var in `.env.example` is an optional override.
- Requires Node 20+ (`MIN_NODE_MAJOR` in `config/doctor.ts`, unenforced at install) and
  `claude` / `codex` on PATH, already logged in.

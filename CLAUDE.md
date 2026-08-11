# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Note: you have a handoff file in .claude/handoff.md. it should update you on the previous session.

## What this is

A single-process looping orchestrator: given a mission goal it researches, writes an outcome
spec, plans tasks, synthesizes a purpose-built agent per task, runs them in parallel git
worktrees, verifies, and re-plans each round. One npm package, one `orchestra` bin, no services
and no database — setup simplicity is a hard constraint, not a cleanup item.

**Phases 1–7 exist.** `orchestra run "<goal>"` scans, asks up to three intake questions, researches,
writes an outcome spec, plans, **waits for a human to sign off**, then synthesizes, dispatches,
verifies, merges, and replans; `--plan-only` stops after the estimate. An attended run also serves a
dashboard on loopback (`--no-web` turns it off), and `orchestra serve` is the server that outlives
missions: list, watch, compose, answer, pause, forget — one composed mission at a time, and the
per-run server is untouched (`runMission` takes an optional `RunSurface` and never closes a server
it did not open). Other commands: `doctor`, `resume <missionId>`, `forget <missionId>`,
`save <missionId> --as <name>`, `promote <missionId> <taskId> --as <name>`, `help`.

**Phase 7 added `src/workers/acp/`** — ACP as a worker transport (§12): `protocol.ts` (the JSON-RPC
frames as zod schemas), `registry.ts` (the pinned adapter launch per target — exact versions, and
`CLAUDECODE` stripped from the child), `transport.ts` (one live session per task), `permissions.ts`
(what the grant already covers, decided in code) and `permissionPort.ts` (what it does not, asked
of a human). Underneath it, `runtime/duplex.ts` is the framed stdio child; above it,
`workers/router.ts` owns the transport id so `cli` no longer answers for ids it is not, and
`workers/availability.ts` narrows the built list to what *this machine* can start. The
`requestPermission` seam is what closes defect 14: ACP has a channel to say no on, so nothing needs
`--dangerously-skip-permissions` — the `cli` fallback still passes it, and that is the reason to
migrate off it. **Five real missions have run over ACP** (2026-08-10): tasks completed first-attempt
over `acp/claude`, with real commits, merges, and criterion checks — and the runs surfaced defects
28–35, all fixed. No mission has yet gone brief→`complete` uninterrupted; that is the standing check.

**Phase 6 also added `src/channel/`** — the carrier-independent trust core (§17): `trust.ts` (
single-use nonce, bound sender identity, replay-approves-once as a property of the store),
`cards.ts` (a `credential` gate has no card; `GateCard` has no field an image could ride in), and
the `Carrier` interface. The serve process mirrors a live mission's open questions through an
optional `channel` dep; no concrete carrier ships until the §0 spike's live-Gateway half is
verified. `doctor` refuses a non-loopback `ORCHESTRA_GATEWAY_URL` — the spike showed the client
would allow remote `wss://`, so that refusal is load-bearing.

**Phase 5 added `src/memory/`** — the semantic and procedural tiers (§6, §7), all markdown under
`<stateDir>`: `lore/` (one fact per file; provenance required at write, `principle` human-only,
stale entries re-enter the ledger as guesses via `recallToLedger`), `saved/` (saved missions —
deliberately not `missions/`, which holds state dirs), and `profiles/` (promoted `AgentSpec`s,
offered to synthesis as hints that still pass full validation). Recall, write-back
(`memory/writeBack.ts`), and profile loading are optional deps wired in `runCommand.ts` and
`buildLoopDeps` — each has a composition-root test, which is the defect-12b lesson applied. Replays
of a saved mission re-run scan and research; `--unattended` requires `--saved` or `--force`.

`src/loop/calls.ts` is still the seam: the model calls (`research`, `intake`, `plan`, `synthesize`,
`progress`, `judge`) as an interface, implemented for real in `loop/agentCalls.ts` and scripted in
`testing/fixtures.ts`. **Everything above that interface is tested with no model and no spend, and
it should stay that way** — a test that needs a live call belongs behind an injected transport.

§3 names five decision points and `intake` is the sixth. It is a one-shot call rather than the
streaming conversation §3 imagined, because §2b caps intake at three questions asked once — which
keeps it *above* the seam, where the cap and the answers are assertable. That closes defect 15.

`src/loop/human.ts` is the second seam, and it is the one Phase 3 added: the two places a mission
blocks on a person. The terminal (`cli/terminal.ts`), the dashboard (`web/webHuman.ts`), and
`unattendedHuman` all implement it, and `anyOf` lets a decision arrive from whichever surface answers
first. `prepareMission` cannot tell them apart, which is the point.

`ask_human` now parks exactly its `blocks` tasks — in the *fold*, deliberately, because the answer
may arrive when no loop is running and resume can only lift what the fold recorded. A worker
reporting `blocked` raises the question; the inbox answers it; `question_answered` returns the task
to `waiting`, where the scheduler owns the promotion. Pause works the same way: a folded flag the
loop parks on, lifted by `orchestra resume`. Still open after Phase 6: kill-task, serve-side resume
of a parked mission, the retention sweep, artifact content serving, envelope editing on compose, and
the concrete OpenClaw carrier (see the Phase 6 as-built notes in ROADMAP.md); panic still has no
browser session to close until Phase 8.

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

**Or over ACP** (§12), which is the other shape: `runtime/duplex.ts` spawns a framed stdio child and
`workers/acp/transport.ts` drives one live JSON-RPC session, answering the agent mid-turn.
`permissions.ts` decides in code what the grant already covers; anything else goes through
`permissionPort.ts` to a human, into the one inbox (§10) — that seam is the whole of defect 14, and
`allow_always` is never selected (one ask, one grant). The port has no clock of its own: the
session's `wallMs` timeout bounds the wait, because a second timer would race the first and leave a
promise unsettled. `workers/router.ts` maps `TransportRef.id` to a runtime, and
`workers/availability.ts` computes what to *offer* synthesis from what `doctor` probed — the built
set and the runnable set are different lists, and offering the wrong one is defect 21 (an ACP
adapter is a shim over `claude` or `codex`, so it needs one on PATH).

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

- **The web layer is below the fixture harness, exactly like `agentCalls.ts`.** Nothing above it
  substitutes for a socket. Keep what the server *decides* — `eventsSince`, `parseClientMessage`,
  `renderSignoff` — in pure functions with tests, and leave only plumbing in `web/server.ts`.
- **The page is client-side JavaScript carried in TypeScript template literals** (`web/page/*` —
  style, projection, screens, wire, composed by `shell.html.ts`). A backtick or `${` inside a
  fragment silently truncates or interpolates the page; `shell.test.ts` trips on it, and it has
  already caught one comment. No `send()` argument may derive from the page's own fold — the one
  exception is the id of the element that was clicked.
- **End of input is not approval.** `Prompter.ask` returns `undefined` for a closed pipe and `""` for
  a human pressing Enter, and conflating them hands sign-off to a shell redirect. The same
  distinction is why the terminal port *rejects* on intake when nothing was answered: these ports
  race, and a port that cheerfully returns "no answers" wins that race and the browser never gets
  asked.
- `events/log.ts` `append` **must stay synchronous** — gapless `seq` depends on an in-memory
  counter advanced only after the write returns.
- The outcome spec is written by the `research` call, and its `criteria` are deliberately typed
  `unknown[]`. That is what keeps a criterion with no check *representable*, so `writeOutcomeSpec`
  can reject it — typing it as `Criterion[]` would make the system's most important validation
  untestable. **The cost is that `withSchema` renders it as an unconstrained array**, so the model
  is told nothing about a criterion by the derived schema — `RESEARCH_PROMPT` spells out
  `criterionSchema` and the `VerifySpec` union by hand. Change one and change the other.
- **`agentCalls.ts` is the one file the fixture harness cannot cover**, since it is the thing the
  harness substitutes for. Five defects hid there behind 331 green tests until the first real-model
  run, and a sixth (25) behind 461. Anything the model *receives* — SDK options, prompt text, a
  decision point's input — belongs in a pure function (`queryOptions`, `withSchema`,
  `AVAILABLE_TRANSPORTS`) so the next regression is catchable for free, and still wants one real run
  before you believe it.
- **A judge reads files, and a rubric has to be about them.** §3 hands the judge `artifactPaths` and
  nothing else. Defect 22 was the judge having no tools to open them; defect 25 was synthesis writing
  "PASS only if the final message…", which no judge can evaluate. Both made every judge-verified
  criterion unpassable, and neither was visible to the suite.
- `AVAILABLE_TRANSPORTS` in `workers/transport.ts` is the registry, and it is shorter than §7's
  table. Synthesis is told what it may pick and a spec outside it fails at validation (§7) — not at
  dispatch, where it costs a typed retry and a replan to learn the same thing. **What the build
  ships is not what a machine can run**, so every composition root passes
  `availableTransports(config)` rather than the constant; a `transports` list left off a `Deps`
  falls back to the whole registry, which is the optional-dependency footgun again.
- **The ACP transcripts in `src/testing/acp-transcripts/` are executable fixtures**, not notes:
  `workers/acp/protocol.test.ts` parses the real captured frames, so a schema that drifts from what
  an adapter sends fails the suite. Adapter versions are pinned exact in `acp/registry.ts` — bump
  one and re-capture, since `npx -y` resolves at dispatch time in the task's worktree. Two facts
  from the capture that no documentation would have given: `CLAUDECODE` must be *stripped* (a
  present-and-`undefined` env key), and no frame carries token usage, so ACP spend is unmeasured
  (§9.5).
- **`workers/toolCatalogue.ts` is the other half of that**, and it translates rather than filters:
  the envelope is written in *classes* because a human reviews it, and a spec comes back in *tool
  names*. `resolveClasses` is what synthesis offers the model, `classOf` is what maps the answer back
  so `violations()` has something to judge. `AgentSpec.tools` is `z.array(z.string())` on purpose —
  an out-of-envelope tool has to be representable or the validation is untestable, the same argument
  that keeps `criteria` typed `unknown[]`.
- **An empty `owns` is not "no restriction", it is a lease that matches nothing.** `readyTasks` skips
  the overlap check when a code task declares none, and `detectEscape` then counts every changed file
  as an escape — so a code spec without a lease is refused at synthesis (defect 23).
- **An optional field on a `Deps` interface is a place a feature can be finished and switched off at
  once.** `requestExtension`, `owns`, and `reformat` were each built to spec, unit-tested, and
  reachable only through a parameter no entry point passed; all three surfaced on a real mission
  rather than in the suite. When you add one, test the composition root that builds it
  (`buildLoopDeps`, `runMission`), not only the mechanism.
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

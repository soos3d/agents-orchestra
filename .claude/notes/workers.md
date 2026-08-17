# Workers, transports, envelopes and the repo

Read before touching `src/workers/**`, dispatch, envelopes or git leases. Cited from `CLAUDE.md`.

## Two shapes

A worker is a subprocess either way:

- **CLI** — `runtime/sh.ts` spawns `claude` or `codex`, cwd'd into the per-task worktree. Still
  passes `--dangerously-skip-permissions`, which is the reason to migrate off it.
- **ACP** (`src/workers/acp/`) — `runtime/duplex.ts` is the framed stdio child and `transport.ts`
  drives one live JSON-RPC session per task, answering the agent mid-turn. `protocol.ts` is the
  frames as zod schemas; `registry.ts` is the pinned adapter launch per target (exact versions, and
  `CLAUDECODE` stripped from the child); `permissions.ts` decides in code what the grant already
  covers; `permissionPort.ts` asks a human about what it does not, into the one inbox. That
  `requestPermission` seam is the whole of defect 14 — ACP has a channel to say no on.
  `allow_always` is never selected (one ask, one grant). The port has no clock of its own: the
  session's `wallMs` timeout bounds the wait, because a second timer would race the first and leave
  a promise unsettled.

`workers/router.ts` owns the transport id so `cli` no longer answers for ids it is not.
`workers/availability.ts` computes what to *offer* synthesis from what `doctor` probed — **the built
set and the runnable set are different lists**, and offering the wrong one is defect 21 (an ACP
adapter is a shim over `claude` or `codex`, so it needs one on PATH).

`AVAILABLE_TRANSPORTS` in `workers/transport.ts` is the registry and is deliberately shorter than
the spec's table. Synthesis is told what it may pick and a spec outside it fails at *validation*,
not at dispatch where it would cost a typed retry and a replan to learn the same thing. Every
composition root passes `availableTransports(config)` rather than the constant; a `transports` list
left off a `Deps` falls back to the whole registry — the optional-dependency footgun again.

**The transcripts in `src/testing/acp-transcripts/` are executable fixtures**, not notes:
`workers/acp/protocol.test.ts` parses the real captured frames, so a schema that drifts from what an
adapter sends fails the suite. Adapter versions are pinned exact in `acp/registry.ts` — bump one and
re-capture, since `npx -y` resolves at dispatch time in the task's worktree. Two facts from the
capture no documentation would have given: `CLAUDECODE` must be *stripped* (a present-and-`undefined`
env key), and no frame carries token usage.

## Capabilities

**`workers/toolCatalogue.ts` translates rather than filters.** The envelope is written in *classes*
because a human reviews it; a spec comes back in *tool names*. `resolveClasses` is what synthesis
offers the model, `classOf` maps the answer back so `violations()` has something to judge.
`AgentSpec.tools` is `z.array(z.string())` on purpose — an out-of-envelope tool has to be
representable or the validation is untestable (same argument as `criteria: unknown[]`).

**The envelope governs the environment too — defect 42, closed.** It used to not: both spawn paths
composed the child env as `{ ...process.env, ...opts.env }`, so every worker, including a `research`
task that needed none, inherited every key the process was started with.

- `Envelope.env` is an allowlist of variable **names** (`.default([])`, so every log written before
  it existed still folds — `mission_created` embeds the envelope). `AgentSpec.env` names which of
  them a task asked for; a name outside the envelope is refused at synthesis through the same
  `EnvelopeViolationError` door as an out-of-envelope tool, because widening is a human decision
  either way. `defaultEnvelope` grants none, which is every mission today.
- **`workers/childEnv.ts` constructs, it does not filter.** `buildWorkerEnv` starts from `{}` and
  copies in the transport's own names plus the task's granted ones. A filter is a deny-list wearing
  an allow-list's clothes — correct only until someone adds a variable it forgot. An allowed name
  the parent lacks stays *absent*: inventing `""` flips an `if ("VAR" in env)` with no error.
- **`opts.env` on `sh.ts` / `duplex.ts` now means the child's *entire* environment**, not an overlay.
  Omitting it inherits the parent, which is right for git plumbing, `doctor` probes and the project's
  verify command — the operator's own tools running as the operator — and which no worker path does.
  Merging over the parent is still possible and now has to be written out.
- Transport-startup vars live **beside the launch**: `CLAUDE_TRANSPORT_VARS` (`claudeCode.ts`),
  `CODEX_TRANSPORT_VARS` (`codex.ts`), both over `PROCESS_BASELINE_VARS`, and `AcpLaunch.inherits`
  names them per adapter. The baseline is deliberately generous — a worker that cannot resolve `npx`
  or find `$HOME` fails as a broken task, not as a missing variable. `CLAUDECODE` is absent because
  nothing names it, which replaced the present-and-`undefined` strip; do not put it in a list.
- `saveProfile` strips `env` — those names were checked against another mission's envelope.
- `childEnv.wiring.test.ts` is the composition-root half and is a separate file on purpose: a green
  pure-function test read as evidence for the wiring is the defect this repo has paid for three times.

## Git, leases and the shared checkout

Git belongs to `code` tasks only.

- **An empty `owns` is not "no restriction", it is a lease that matches nothing.** `readyTasks`
  skips the overlap check when a code task declares none, and `detectEscape` then counts every
  changed file as an escape — so a code spec without a lease is refused at synthesis (defect 23).
- **A worker with no worktree runs in the shared checkout and may not change it.** A `research` or
  `review` worker gets no lease, no commit and no merge gate, and it is still standing in the repo.
  `dispatch` compares the working tree before and after (`git/repo.ts` `readWorkingTree`,
  `scheduler/repoEscape.ts`) and fails a delta as `repo_escape` — the alternative, committing for
  it, is a code path with none of the guarantees defects 30/31 bought. It **compares** rather than
  asking "is it dirty": the human's own uncommitted work is not the mission's business (defect 41).
- **Worktrees are pinned to an explicit base sha, never HEAD.** Compare paths through
  `fs.realpathSync` (macOS `/var` vs `/private/var`).
- The project's own verify command is a merge gate for code tasks (P5).

## Artifacts

**A worker with no worktree has exactly one place it may write, and the runtime tells it where.** A
judge grades files on disk (defect 27) and the checkout is refused (defect 41), which left a task
obliged to produce a file with nowhere to put one. `artifactDir(stateDir, missionId, taskId)`
(`config/discover.ts`, `loop/artifactPath.ts`) is that place, created `0700` before the worker runs
and injected into `workerPrompt` as an absolute path. `AgentSpec.outputPath` is optional and
**relative** — synthesis runs long before dispatch and the directory is the runtime's to decide, so
an absolute path or a `..` is refused at validation (`ArtifactEscapeError`). Check output and judge
verdicts land there too; `keepEvidence` is best-effort by design, because a full disk must not fail
a check.

## Scanners over model output

**Every scanner over model output has to know what it is inside of.** `needsShell` read the `=>`
inside a quoted string as a redirect (defect 34); `extractJsonObject` took the first fence match and
stopped at a fence *inside* a JSON string (defect 38); the ACP reader split a UTF-8 sequence across
a chunk boundary (defect 37). Three files, one mistake: a regex or a byte offset applied to text
that has structure. All three failed on correct work, two of them quietly.

`runtime/command.ts` is a tokenizer, not a shell — no globs, pipes or substitution. `needsShell()`
exists so a piped command fails loudly instead of silently misbehaving.

## Containment

**A contained worker is the same worker with the spawn rewritten** (`runtime/contained.ts`,
PLAN-NEXT 3). `Envelope.containment` decides it once per mission, `containmentFor` builds the
`Containment` at the composition root from the folded envelope, and `containedCommand` turns
`(cmd, args, env)` into the backend's argv for **both** spawners — `sh.ts` through `runCliProcess`
and `duplex.ts` in `acp/transport.ts`. Wiring one of them would have been the smaller change and a
sandbox with a door in it: the same mission staffed `acp` instead of `cli` would run on the machine
while the envelope said otherwise.

- **Paths are identical inside and out.** Everything above the runtime — `detectRepoEscape`,
  `changedFiles` against the pinned base sha, the `artifactDir` in the worker's prompt — holds host
  paths. A tidy `/workspace` remap makes all of them compare a tree the worker never touched, and
  they pass while meaning nothing. `contained.repo.test.ts` is the assertion.
- **`--env NAME`, never `NAME=VALUE`.** The backend CLI is spawned with the constructed worker env
  and copies each named value in; a value in the argv is readable by every process on the machine.
  `clientVars` (`CONTAINER_CLIENT_VARS`) is the *client's* own environment — its socket address is
  not the container's business.
- **`--entrypoint` is explicit**, or an image with its own `ENTRYPOINT` runs that program and takes
  `claude` as an argument, returning its output as the worker's report. Nothing about that is loud.
- **`--network none` by default**, and the allowlist is the name of a network the operator created.
  Docker has no per-host primitive; a domain list here would be a claim nothing enforces.
- **`--user uid:gid`** whenever the platform has one, or a Linux container leaves root-owned files
  in the mounted worktree that git can neither stage nor `removeWorktree` delete.
- **`--pull=never`**, so the one feature whose point is that the worker has no network does not
  fetch an image over it at dispatch.
- `runCodex` writes its `--output-last-message` file into a per-run tmp *directory* it asks to have
  mounted. A bare `os.tmpdir()` file would vanish inside the container and the scrape would fall
  through to stdout — a contained codex worker quietly delivering a worse answer than a plain one.
- **`containmentFor` throws** when a contained mission meets a machine that cannot contain.
  `undefined` means "not contained", so returning it would run the mission on the bare machine.
  Synthesis refuses first (`UnavailableContainmentError`, checked once before the first staffing
  call — no answer a model gives installs Docker); this is the resumed-elsewhere case.


## Redaction (PLAN-NEXT 7.3)

`workers/redact.ts` is pure and has one rule: **exact value match, no shape matching.** `grantedSecrets`
pairs each `Envelope.env` name with the value this process holds (skipping anything under
`MIN_REDACTED_LENGTH`, so a granted `LOG_LEVEL=debug` does not delete the word *debug* from every
report); `redact` does `split`/`join` per value, longest first, replacing with `[redacted:NAME]`.
`String.replace` is wrong here twice over — a value is a string and not a pattern, and a value
containing `$&` would be re-inserted by the replacement syntax.

Four sinks, all wired at `buildLoopDeps`, which is the only place `process.env` is read for this:
`dispatch` scrubs `run.raw` **before** `parseWorkerReport` (so the report, the reformatter's input and
every derived event are covered at once), `verify.ts` scrubs `runCommand`'s output and each judge's
reasoning, `keepEvidence` takes the secrets as a **required** parameter so a new call site cannot skip
it, and the ACP permission port scrubs the `detail` a request quotes before it is emitted or shown.

Four more sinks came out of the stage's security review, and all four were the same mistake: the scrub
was on where a text landed and not on what it was written *from*. `verification_run.spec` reached the
log unscrubbed on every check while `runCommand`'s refusal of the identical string was already covered
(`loggedSpec` in `dispatch.ts`); `merge_empty.reason` and the conflicted `move`/return were the two
dispatch outcomes not routed through `fail()`; and the whole prepare phase ran ahead of the scrubber,
because `buildLoopDeps` derives the list and the loop runs after `prepareMission` — `PrepareDeps.secrets`,
bound at `runMission`, is that half. `permission_requested.tool` is scrubbed alongside `detail` now:
OpenCode's later frames rewrite the title to what the tool is *doing*, so `tool` is a command string
often enough that covering one field and not the other was arbitrary.

**`withoutSecrets` is the scanner's exception and it is a filter, not a construct.** `runScanner`
inherited `process.env`, which handed every granted value to an AI agent with shell access whose store
persists in the repository — defect 42 one caller along. A `buildWorkerEnv`-style allowlist is not
writable for it: it drives `codex` or `claude` and needs the operator's own environment to find their
credentials, so a name list would be a gate that silently cannot start. What is decidable is what to
withhold. Its export is read, scrubbed, **written back** at 0600 and then parsed, so the file and the
summary cannot disagree — the finding likeliest to be quoted verbatim is the hardcoded credential.

The limit is deliberate: a file the worker writes itself is the deliverable, not a report about it, and
rewriting it would corrupt the work. Containment and `Envelope.env` are the line that decides whether a
worker sees a value at all; this is the second line behind them. Two known holes, both stated rather
than closed: a base64 or JSON-escaped rendering of a value is not the value byte for byte and passes
through, and `MIN_REDACTED_LENGTH` leaves a seven-character granted value alone everywhere.

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

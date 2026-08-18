# CLI transcripts — captured, not documented

Raw stdout from real headless `cli` sessions on this machine. The sibling
`acp-transcripts/` directory holds JSON-RPC frames; a `cli` transport has no wire to record, so
what is captured here is the thing a `cli` transport actually reads: the child's stdout, byte for
byte, as `workers/pi.ts` receives it. `pi.test.ts` parses these files, so a `pi` upgrade that
changes the event stream fails the suite instead of failing a mission.

## `pi` — captured 2026-08-17 against pi 0.84.2

`pi --mode json -p` writes one JSON object per line to stdout.

| File | Scenario |
|---|---|
| `pi-write-file.jsonl` | A git worktree; the model calls the built-in `write` tool, the file is written, the turn ends with prose. Two API calls, so two assistant `message_end` frames each carrying its own `usage`. |
| `pi-text-only.jsonl` | A plain directory that is not a repo; one API call, one text answer, no tool call. |

### How these were produced, and the one thing they are not

pi holds **no credentials on this machine** — `~/.pi/agent/auth.json` is `{}` and
`pi auth check` answers `credentials_not_configured` for every provider. So the model behind these
captures is a local OpenAI-compatible stub on `127.0.0.1`, registered through a throwaway
`pi.registerProvider()` extension and scripted to return a fixed tool call and a fixed sentence.

What that makes real and what it does not is worth being exact about. **Everything on pi's side of
the boundary is real**: the argv it accepts, the tools it advertises, the fact that it executes a
`write` with no approval prompt, the exact JSON event stream, the usage fields, the exit code, and
what it does with stdin. Those are the facts `workers/pi.ts` is written from. **The model's
behaviour is not real** — the assistant text is the stub's, not a model's — and nothing in
`pi.ts` depends on it.

### Four facts the capture gave and the documentation did not

1. **`pi -p` blocks until stdin reaches EOF.** The same command that finished in under a second
   with `< /dev/null` hung past two minutes with a pipe attached to stdin. `runtime/sh.ts` already
   ends the child's stdin after its optional `opts.input` write, so `cli/pi` needed no change —
   but pi is the first child that would break if that line went, and `sh.test.ts` pins it now for
   that reason. Anyone reproducing a capture by hand has to redirect stdin themselves.
2. **`--model` reaches the provider verbatim.** `--model capture/stub-1` arrived at the stub as
   `"model": "stub-1"` in the request body, and pi's own `message_end` frames report
   `"model": "stub-1"`. That is what sets `honoursModel` for the `cli/pi` row — measured on the
   wire, not read off a README.
3. **An unknown model is a warning, not a refusal.** `--model capture/does-not-exist` printed
   `Warning: Model "does-not-exist" not found for provider "capture". Using custom model id.` and
   then ran the turn anyway. Unlike `acp/opencode`, whose `session/set_model` refuses `-32602`
   before a token is spent, pi has no pre-flight door for an invented model.
4. **A repository's own `.pi/extensions/` does not load unless `--approve` is passed.** Found by
   putting the capture extension in the worktree and watching pi refuse to see it. That is the
   safe direction and `piArgs` keeps it: a worker's worktree is a tree the mission is *working
   on*, and a checked-in extension that loaded by default would run code of the repository's
   choosing inside the worker. Nothing here passes `--approve`, and adding it would need a
   reason better than convenience. Related: an unknown *provider* is a hard error and an
   unknown *model within a known provider* is only the warning in point 3.
5. **`pi --list-models` exits 0 with nothing to run.** With no provider configured it prints its
   `/login` hint to **stdout** — measured at 300 bytes with stderr empty — and this line first
   said the opposite, which is how `probePi` shipped offering `cli/pi` on a machine that cannot
   answer a prompt. `doctor` caught it, not the suite. `piListsModels` reads the hint itself now
   and `discover.test.ts` pins these bytes. What a *logged-in* pi prints has never been seen on
   this machine and is asserted nowhere.
   That is why `probePi` reads stdout rather than the exit code — the same trap
   `probeContainers` documents for `docker info`.

### Reproducing

The stub, the extension and the exact commands are not checked in: the rig is four dozen lines
(an `http.createServer` returning SSE chunks, and a `pi.registerProvider("capture", …)`
extension loaded with `-e`), and re-deriving it against a newer pi is the point of re-capturing.
Run pi with `--mode json -p --no-session < /dev/null` and redirect stdout to the file.

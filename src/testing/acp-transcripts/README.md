# ACP transcripts — captured, not documented

Raw JSON-RPC frames from real ACP sessions on this machine — the `claude` and `codex` captures on
2026-08-10 for the Phase 7 spike (§12), the `opencode` ones on 2026-08-16 for PLAN-NEXT stage 1.
Every `.jsonl` here is **captured traffic**, not documentation-derived
shapes — that distinction matters, because `agentCalls.ts`'s lesson is that a green suite says
nothing about what a real counterparty actually sends.

One JSON object per line:

```
{ "t": "<ISO timestamp>", "dir": "out" | "in" | "stderr" | "client-error", "frame": <JSON-RPC frame> }
```

`out` is client → agent, `in` is agent → client. `stderr` frames carry the agent's raw stderr string.

| File | Agent | Scenario |
|---|---|---|
| `claude-write-file-approved.jsonl` | `@zed-industries/claude-code-acp` 0.16.2 | Write `hello.txt`; `session/request_permission` **approved** with `allow`; `fs/write_text_file` routed back to the client; `stopReason: end_turn`. |
| `claude-write-file-rejected.jsonl` | same | Same shape, permission **rejected** with `reject`; the tool call goes `status: failed`, no file is written, the turn still ends `end_turn`. |
| `claude-bash-execute-approved.jsonl` | same | `Bash` tool → `kind: "execute"` tool call, permission approved. Shows the non-`edit` gate shape. |
| `codex-initialize-and-session-new.jsonl` | `@zed-industries/codex-acp` 0.16.0 | `initialize` + `session/new` succeed and are complete; `session/prompt` fails — the ChatGPT account was over its usage limit. Trimmed: stderr frames over 600 bytes were dropped (~391 KB of model-cache noise). |
| `opencode-write-file-approved.jsonl` | `opencode acp` 1.18.18 | The shipped configuration: `OPENCODE_PERMISSION={"edit":"ask",…}` set, so the write is gated by `session/request_permission` and routed back through `fs/write_text_file`. Approved with `once`; `stopReason: end_turn`. |
| `opencode-permission-off.jsonl` | same | The **default** configuration, and the reason the launch does not use it: the same prompt writes the file with OpenCode's own tools — no permission request, no `fs/write_text_file`, nothing for the client to refuse. |
| `opencode-set-model.jsonl` | same | `session/set_model` → `{}`, then the turn runs on the model asked for. |
| `opencode-model-refused.jsonl` | same | `session/set_model` with an invented id → `-32602 model not found`, before `session/prompt` and before any spend. |
| `prime-agent-research-ungated.jsonl` | `prime-agent --mode acp` 0.7.2 | A research-shaped turn — read two files, summarise. Three `%%bash` cells ran; **no `session/request_permission` was ever sent**. |
| `prime-agent-set-model-unsupported.jsonl` | same | `session/set_model` → `-32601 Method not found`. The ACP surface has no model control at all. |
| `prime-agent-subagents-reachable.jsonl` | same, `--tools ipython` | Under the narrowest allowlist prime-agent offers, a cell imports `rlm` and prints `list_subagents`, `delete_subagent`, `RLMSubagent`. Still no permission frame. |
| `prime-agent-model-flag-alone.jsonl` | same, `--model` without `--provider` | The model is resolved at process startup from the argv, not from the wire: `--model` alone routed to `openrouter` and the turn died `-32603` on a missing key. |

## What the OpenCode captures settled

Four facts, each measured here rather than read anywhere:

- **It honours the model.** `session/set_model` is accepted for a model the session offers and
  refused `-32602` for one it does not — so `acp/opencode` is the first ACP row with
  `honoursModel: true`, and the refusal lands before the prompt. Contrast `acp/claude`, which is
  never told our model at all.
- **The model menu is per machine.** `session/new` returns no `models.currentModelId`; it returns
  `configOptions` with a `model` select whose `currentValue` and `options` are whatever the human's
  account and config resolve to. There is no list to write into `MODELS_BY_VENDOR`, which is why
  `opencode` is empty there.
- **It reports usage, unlike Claude's adapter.** `session/prompt`'s result carries
  `{inputTokens, outputTokens, totalTokens, cachedReadTokens}`, and `usage_update` notifications
  carry a running context total with a cost. Neither is read yet — `usage.ts` still looks for a
  session log and falls back to the wire estimate, so an OpenCode dispatch is currently reported as
  *estimated*. Pricing it from the frame belongs with PLAN-NEXT stage 2.5.
- **It needs no login for a capture.** The OpenCode Zen free models answer with an empty
  `auth.json`, which is what made these captures possible at all. `HOME` and `PATH` were the whole
  environment for one of the runs.

## What the prime-agent captures settled: there is no row

PLAN-NEXT stage 8 item 4 asked for prime-agent as a harness for long-research tasks, "its
sub-agent spawning fenced off in the envelope's tool classes". These four captures are why
nothing was registered. prime-agent 0.7.2 drives headless cleanly — `--mode acp` is native, no
adapter package, no `npx` — and every problem below is on the wire rather than in the driving.

- **The permission channel is never opened.** Not once across four captures. The research turn ran
  `ls -la`, `cat README.md` and `cat add.py` and asked nobody. This is
  `opencode-permission-off.jsonl` exactly, and the difference is that OpenCode had
  `OPENCODE_PERMISSION` to answer it: prime-agent's ACP implementation carries the vendored SDK's
  `session/request_permission` constant and never sends the request. `permissions.ts`,
  `permissionPort.ts` and `decidePermission` would all be dead code behind this target, and a
  worker's tool use would be bounded by the worktree alone.
- **Sub-agent spawning has no name to fence.** prime-agent has one model-facing tool, a persistent
  IPython kernel; a cell is a `tool_call` of `kind: "execute"` whose `rawInput.code` is arbitrary
  Python, and `%%bash` inside it is arbitrary shell. Spawning is `rlm.*` — a Python symbol in that
  cell's namespace, not a tool. `Envelope.toolClasses` gates *names* through `classOf`, so at the
  protocol layer `rlm.spawn` and `ls -la` are the same frame and there is nothing to refuse.
  `--tools ipython`, the narrowest allowlist the CLI offers, still leaves the whole `rlm` API
  reachable: `prime-agent-subagents-reachable.jsonl` prints it.
- **`honoursModel` would be false.** `session/set_model` is `-32601 Method not found`. The model is
  fixed at process startup from `--provider`/`--model` on the argv, and `session/new`'s result
  carries neither `models.currentModelId` nor `configOptions` — so nothing on the wire could even
  report what a turn ran on. `MODELS_BY_VENDOR` would be empty for the OpenCode reason: the menu is
  the human's own account.
- **It reports no usage.** `session/prompt` resolves `{"stopReason":"end_turn"}` and nothing else.

Two smaller notes for whoever re-captures. The captures were made against Nebius, wired as an
OpenAI-compatible custom provider in `~/.prime/agent/models.json` with
`"apiKey": "!printenv NEBIUS_API_KEY"`, because a stock prime-agent has no models until someone
logs in — that file is on the maintainer's machine and holds no value, only the variable name.
And `session_info_update` is prime-agent's own notification, an empty ACP object wrapping a
`ai.primeintellect.prime-agent` `_meta` envelope; it is in `IGNORED_UPDATES` so the fixture does not
sit on the warning path, and reading its contents would be this transport learning one agent's
private dialect.

Its tool names are lower case (`write`, `bash`), which is why `classOf` matches case-insensitively:
the same tool spelled the other way was an unrecognised tool, and an unrecognised tool asks a human.

`spike-client.mjs.txt` is the ~130-line client that produced them — spawn, log both directions,
answer `session/request_permission` / `fs/read_text_file` / `fs/write_text_file`. It uses no SDK, on
purpose: it is the minimum an `AcpWorker` has to do, and it is what the transcripts were captured
against.

Reproduce with:

```
node spike-client.mjs <out.jsonl> <cwd> <agent-command> [args...]
ACP_PERMISSION=reject  ACP_PROMPT="..."  ACP_TIMEOUT_MS=240000  ACP_MODEL=…   # optional
```

The OpenCode captures were made with `opencode acp` as the command. `ACP_MODEL` sends
`session/set_model` before the prompt; the client drops `available_commands_update` frames, which
carry the capturing machine's own list of local skills and belong to nobody's protocol.

Note: `claude-code-acp` must never see `CLAUDECODE` — it reads it as being nested inside a session.
A capture run by hand has to unset it; the shipped path constructs the child environment and simply
never names it (`src/workers/childEnv.ts`, and the header of `src/workers/acp/registry.ts`).

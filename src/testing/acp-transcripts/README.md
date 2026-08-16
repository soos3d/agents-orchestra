# ACP transcripts — captured, not documented

Raw JSON-RPC frames from real ACP sessions on this machine, 2026-08-10, captured for the Phase 7
spike (§12, Phase 7). Every `.jsonl` here is **captured traffic**, not documentation-derived
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

`spike-client.mjs.txt` is the ~130-line client that produced them — spawn, log both directions,
answer `session/request_permission` / `fs/read_text_file` / `fs/write_text_file`. It uses no SDK, on
purpose: it is the minimum an `AcpWorker` has to do, and it is what the transcripts were captured
against.

Reproduce with:

```
node spike-client.mjs <out.jsonl> <cwd> <agent-command> [args...]
ACP_PERMISSION=reject  ACP_PROMPT="..."  ACP_TIMEOUT_MS=240000   # optional
```

Note: `claude-code-acp` must never see `CLAUDECODE` — it reads it as being nested inside a session.
A capture run by hand has to unset it; the shipped path constructs the child environment and simply
never names it (`src/workers/childEnv.ts`, and the header of `src/workers/acp/registry.ts`).

// How an ACP agent is actually launched — the one place a command line lives (§12).
//
// ACP's promise is one adapter for the entire long tail, and the thing that promise
// quietly depends on is a *correct invocation per agent*. Those invocations were not
// derived from documentation: they are what the Phase 7 spike spawned on this machine on
// 2026-08-10 to produce the captures in `src/testing/acp-transcripts/`, which are the same
// captures `protocol.ts` is written from. Keeping the launch beside the wire is what stops
// the two from describing different agent versions.
//
// **The version is pinned exactly, and that is a security decision rather than a taste
// one.** §0's OpenClaw spike found the `latest` dist-tag on an adopted package pointing at
// a 0.0.0 "reserved package name" stub, which is the cheap version of the expensive
// failure: `npx -y <pkg>` resolves at dispatch time, so a floating spec means every
// mission runs whatever was published that morning, in the task's worktree, with the
// task's tools. An exact pin makes an upgrade an edit here, reviewed against fresh
// captures — and `protocol.ts`'s schemas are the test that the new version still speaks
// the dialect we parse.
//
// **`CLAUDECODE` must never reach the adapter, and it no longer needs stripping.** The
// spike hit this directly: an orchestrator that is itself running under Claude Code
// exports `CLAUDECODE=1`, the inherited variable convinces `claude-code-acp` it is
// nested inside a session, and the adapter behaves accordingly. A mission that only ever
// runs from a plain shell would never see it, which is exactly the kind of
// environment-shaped bug that surfaces on someone else's machine. This used to be a
// present-and-`undefined` key removing a variable from an inherited environment; since
// defect 42 the child environment is *constructed* (`workers/childEnv.ts`), so the
// variable is absent because `inherits` never names it. Keep it that way — adding
// `CLAUDECODE` to a list here would put the bug back with no strip left to catch it.
//
// Everything here is pure data and a lookup: the transport turns an unknown target into
// an error naming the fix, because an unbuilt transport target is a planning problem
// (defect 21) and the planner has to be told which ids exist to plan differently.
import { PROCESS_BASELINE_VARS } from "../childEnv.js";
import { CLAUDE_TRANSPORT_VARS } from "../claudeCode.js";
import { CODEX_TRANSPORT_VARS } from "../codex.js";

/** A launch, in the shape `spawnDuplex` takes. The child environment is built from
 *  `inherits` and `env` alone (`workers/childEnv.ts`) — nothing is inherited by
 *  default, so a variable this launch needs and does not name will not be there. */
export interface AcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Variable *names* copied from the orchestrator's environment: what this adapter
   *  needs to start, resolve its package, and find its credentials. */
  readonly inherits?: readonly string[];
  /** Values this launch sets outright, whatever the parent has. */
  readonly env?: Record<string, string>;
  /** Whether `AgentSpec.model` reaches this agent — measured, never assumed. False for
   *  the adapters that pick their own model and are never told ours; true where a
   *  captured `session/set_model` was accepted for a real model and refused for an
   *  invented one. `workers/harness.ts` reads this rather than deriving it from the
   *  transport id, so the harness row and the wire cannot disagree. */
  readonly honoursModel?: boolean;
}

/** OpenCode's own startup variables, beside its launch for the same reason
 *  `CLAUDE_TRANSPORT_VARS` lives beside `claudeCode.ts` — except that this is the only
 *  place OpenCode is launched from, so there is no separate file to put them in. No
 *  provider key is named: a logged-in OpenCode keeps its credentials under `$HOME`
 *  (baseline), and a mission that wants a key in the worker's environment grants it by
 *  name through `Envelope.env`, which is the one door for that. */
export const OPENCODE_TRANSPORT_VARS: readonly string[] = [
  ...PROCESS_BASELINE_VARS,
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
];

/**
 * The one variable OpenCode must not be left to default (`opencode-permission-off.jsonl`
 * against `opencode-write-file-approved.jsonl`, captured minutes apart).
 *
 * OpenCode's `build` agent writes with its *own* tools and asks nobody: the default
 * session completed a file write with no `session/request_permission` and no
 * `fs/write_text_file` — so the permission channel this whole transport is built around
 * (defect 14's answer) was never opened, and the worker's tool use was bounded by the
 * worktree alone. With this set the same prompt gates every edit through
 * `permissions.ts` and routes the write back through the client, where `containedPath`
 * can refuse it. It is therefore part of the launch, not a preference.
 */
const OPENCODE_ASK_PERMISSIONS = JSON.stringify({ edit: "ask", bash: "ask", webfetch: "ask" });

/** Captured against these exact versions — see `src/testing/acp-transcripts/README.md`. */
const CLAUDE_CODE_ACP = "@zed-industries/claude-code-acp@0.16.2";
const CODEX_ACP = "@zed-industries/codex-acp@0.16.0";

/**
 * The targets this build can actually run.
 *
 * `opencode` was absent here until 2026-08-16 for the reason every row exists: its ACP
 * invocation was unverified, and guessing one would ship a command line no capture backs.
 * It is present now because a real session against `opencode acp` 1.18.18 was captured
 * into `acp-transcripts/`, and the capture is what the three facts below come from.
 *
 * It is the one target with **no version pin**, and that is not an oversight. The pin on
 * the other two guards `npx -y <pkg>`, which resolves at dispatch time — whatever was
 * published that morning, in the task's worktree, with the task's tools. `opencode` is a
 * binary the human installed and keeps upgrading, exactly like `claude` and `codex`, and
 * there is nothing here to pin. What that costs is that an upgrade can change the wire
 * with no edit to review, so `protocol.ts`'s schemas are the only alarm — re-capture when
 * OpenCode's own version moves.
 */
const ACP_AGENTS: Readonly<Record<string, AcpLaunch>> = {
  claude: {
    command: "npx",
    args: ["-y", CLAUDE_CODE_ACP],
    // The adapter is a shim over the same CLI, so it needs what that CLI needs — the
    // list lives in `claudeCode.ts` beside the direct launch rather than being copied,
    // since the two authenticate against the same files and the same keys.
    inherits: CLAUDE_TRANSPORT_VARS,
  },
  codex: {
    command: "npx",
    args: ["-y", CODEX_ACP],
    inherits: CODEX_TRANSPORT_VARS,
  },
  // Native: `opencode acp` is the agent's own subcommand, so there is no adapter package
  // between the two and no `npx` in the path. `honoursModel` is measured, not read off a
  // README — `session/set_model` returned `{}` for a model the session offered and
  // `-32602 model not found` for an invented one, before a token was spent, which is the
  // invented-`--model` defect closed on the agent's side of the wire.
  opencode: {
    command: "opencode",
    args: ["acp"],
    inherits: OPENCODE_TRANSPORT_VARS,
    env: { OPENCODE_PERMISSION: OPENCODE_ASK_PERMISSIONS },
    honoursModel: true,
  },
};

/** How to launch the ACP adapter for a `TransportRef.target`, or `undefined` if this
 *  build has no verified invocation for it. */
export function acpAgentCommand(target: string): AcpLaunch | undefined {
  return ACP_AGENTS[target];
}

/** The targets an error message may offer a planner. */
export function acpTargets(): readonly string[] {
  return Object.keys(ACP_AGENTS);
}

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
}

/** Captured against these exact versions — see `src/testing/acp-transcripts/README.md`. */
const CLAUDE_CODE_ACP = "@zed-industries/claude-code-acp@0.16.2";
const CODEX_ACP = "@zed-industries/codex-acp@0.16.0";

/**
 * The targets this build can actually run.
 *
 * `opencode` is deliberately absent. ROADMAP Phase 7 names it as the first
 * protocol-native ACP target that arrives "for free" once the transport exists, and free
 * still means *probed*: no `opencode` binary was on PATH when this file was written
 * (2026-08-10), so its ACP invocation is unverified. Guessing one here would ship a
 * command line no capture backs, which is the `agentCalls.ts` failure with a subprocess
 * instead of a prompt. Add the row when a session against a real OpenCode binary has been
 * captured into `acp-transcripts/`, and not before.
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

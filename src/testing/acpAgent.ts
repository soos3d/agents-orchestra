// A scripted ACP agent that is a real subprocess, because an in-process stub proves the
// wrong thing.
//
// An `AcpWorker` has to survive framing across chunk boundaries, an agent that asks the
// client to do work mid-turn, a turn that never ends, and a process that dies with the
// session half-open. None of those exist for a fake that resolves promises in the same
// event loop — so this factory hands back a `command`/`args`/`env` triple for a plain
// `.mjs` child that speaks real ndjson JSON-RPC on stdio, and the transport test spawns
// it exactly the way it spawns `claude-code-acp`.
//
// The child imports nothing from `src/` on purpose. It needs no loader, no tsx, and no
// build step, which is what lets it be spawned by `process.execPath` from any test — and
// it also means the fake cannot drift into agreeing with our parsers by sharing their
// code. Its frames are copied from the captures in `acp-transcripts/`; when a capture is
// added or an agent changes, the child is the second file to update after `protocol.ts`.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What the child does after the handshake. Every one of these is a failure some part of
 * the transport has to handle, and `happy` is the only one that is not.
 */
export type AcpScenario =
  /** Streams the final text in chunks, then `stopReason: end_turn`. */
  | "happy"
  /** Asks `session/request_permission`, then acts on the answer. */
  | "permission"
  /** Handshakes, then never answers `session/prompt` — the session timeout's test. */
  | "hang"
  /** Exits 1 after the first update, with the prompt still outstanding. */
  | "disconnect"
  /** Ends the turn with prose, so `parseWorkerReport` has something to reformat (§4.1). */
  | "prose";

export interface FakeAcpAgentOptions {
  readonly scenario: AcpScenario;
  /**
   * The agent's final message, streamed as several chunks. Make it a `WorkerReport` JSON
   * document to drive a transport test to a completed task.
   */
  readonly finalText?: string;
  /** The final message when a `permission` scenario is rejected. */
  readonly rejectedText?: string;
  /** The path the `permission` scenario asks the client to write. */
  readonly writePath?: string;
  /** A model id this agent does not have: `session/set_model` refuses it `-32602`, as
   *  OpenCode does, before the turn starts and before anything is spent. */
  readonly unknownModel?: string;
}

export interface FakeAcpAgent {
  readonly command: string;
  readonly args: readonly string[];
  /** Merge into the spawn env; the child reads its script from here, not from argv. */
  readonly env: NodeJS.ProcessEnv;
}

const CHILD = fileURLToPath(new URL("./acpAgentChild.mjs", import.meta.url));

/**
 * Describe a scripted agent. Nothing is spawned here, so a test decides the cwd,
 * the timeout, and the abort signal through `spawnDuplex` like any other worker.
 */
export function fakeAcpAgent(options: FakeAcpAgentOptions): FakeAcpAgent {
  const env: NodeJS.ProcessEnv = { FAKE_ACP_SCENARIO: options.scenario };
  if (options.finalText !== undefined) putText(env, "FAKE_ACP_FINAL_TEXT", options.finalText);
  if (options.rejectedText !== undefined) putText(env, "FAKE_ACP_REJECTED_TEXT", options.rejectedText);
  if (options.writePath !== undefined) env["FAKE_ACP_WRITE_PATH"] = options.writePath;
  if (options.unknownModel !== undefined) env["FAKE_ACP_UNKNOWN_MODEL"] = options.unknownModel;

  // The scenario rides on argv as well as the env so a failing spawn is readable in a
  // process listing rather than being a bare `node <path>`.
  return { command: process.execPath, args: [CHILD, options.scenario], env };
}

// Linux ARG_MAX is argv+env and MAX_ARG_STRLEN is 128KiB; a 400k payload in the
// env is `spawn E2BIG` on CI. Short strings stay in env so existing tests do not change.
const ENV_TEXT_LIMIT = 32_768;

function putText(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (value.length <= ENV_TEXT_LIMIT) {
    env[key] = value;
    return;
  }
  const file = join(tmpdir(), `fake-acp-${key}-${process.pid}-${randomUUID()}`);
  writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
  env[`${key}_FILE`] = file;
}

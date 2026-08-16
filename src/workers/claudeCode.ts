// Claude Code as a `cli` transport: one headless `claude -p` session in a worktree.
//
// Takes its model and timeout explicitly rather than reading a config singleton, so
// a synthesized AgentSpec (§7) decides them per task instead of the process deciding
// them once. Replacing `--dangerously-skip-permissions` with ACP's permission
// channel is Phase 7 (defect 14).
import { isEmptyUsage, type TokenUsage } from "../domain/budget.js";
import { run } from "../runtime/sh.js";
import { PROCESS_BASELINE_VARS } from "./childEnv.js";

/**
 * What `claude` needs from the environment to start and find its own credentials
 * (defect 42), beside the launch that needs it.
 *
 * The CLI authenticates from `~/.claude` on a logged-in machine, which is why `HOME`
 * carries most of the weight — but an API key or a gateway override is a legitimate
 * way to run it too, and a worker that cannot see one fails as an authentication error
 * three layers down rather than as a missing variable. `CLAUDECODE` is deliberately
 * absent and must stay absent: see the header of `acp/registry.ts`.
 */
export const CLAUDE_TRANSPORT_VARS: readonly string[] = [
  ...PROCESS_BASELINE_VARS,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

export interface CliWorkerOptions {
  model: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The child's entire environment (defect 42). Constructed by the transport from the
   *  task's granted names plus `CLAUDE_TRANSPORT_VARS`; omitted only by callers that
   *  are not running mission work, who then inherit this process's. */
  env?: NodeJS.ProcessEnv;
}

/**
 * What one CLI session produced: the worker's final message, and what it cost when
 * the CLI was willing to say.
 *
 * `usage` is optional and its absence is load-bearing (§9.5). `spendOf` in
 * `loop/dispatch.ts` counts a transport that reports nothing as one *unmeasured*
 * dispatch, and a confident `0` here would make a mission that spent real money read
 * as a free one. Absent means "this transport does not know", which is the truth for
 * `codex` (it is scraped from `--output-last-message`) and, until a session log is
 * found, for ACP (no frame carries usage).
 *
 * It carries four numbers rather than one because they are priced differently and a
 * total cannot be unmade: on a real dispatch measured here, cache reads were 95% of
 * the input, so a figure that omitted them under-reported the session by an order of
 * magnitude while looking precise.
 */
export interface CliOutcome {
  text: string;
  usage?: TokenUsage;
}

export const DEFAULT_WORKER_TIMEOUT_MS = 20 * 60_000;

/**
 * The `--output-format json` envelope, read rather than discarded.
 *
 * Pure and separately tested for the `agentCalls.ts` reason: the fixture harness
 * substitutes for this transport, so a green suite says nothing about what a real CLI
 * hands back. The two rules it exists to hold are both in the test header — an
 * unrecognised `usage` degrades to unmeasured instead of taking the message down with
 * it, and a missing one stays missing.
 *
 * The four fields match `spendOf` in `loop/agentCalls.ts` exactly, so a worker's figure
 * and an orchestrator call's figure mean the same thing and can be added. `measured`
 * stays `input + output` in both — change one definition and change the other.
 */
export function parseClaudeCodeResult(result: {
  stdout: string;
  stderr: string;
  code: number;
}): CliOutcome {
  // §12's point about flag drift applies to the output format too: the text is the
  // work, and it has to survive anything else in the envelope going strange.
  const fallback = result.stdout || result.stderr || `claude exited with code ${result.code}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { text: fallback };
  }

  const envelope = parsed as { result?: unknown; usage?: unknown };
  const text = typeof envelope.result === "string" ? envelope.result : fallback;
  const usage = readUsage(envelope.usage);

  return usage === undefined ? { text } : { text, usage };
}

/** Reads what is actually there. A usage block with no field recognisable is not a
 *  zero-cost session, it is a session we cannot price — so it returns undefined, and a
 *  field that is missing on its own stays missing rather than becoming a zero. */
function readUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;

  const read = (field: string): number | undefined => {
    const value = (usage as Record<string, unknown>)[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const found: TokenUsage = {
    ...maybe("input", read("input_tokens")),
    ...maybe("output", read("output_tokens")),
    ...maybe("cacheWrite", read("cache_creation_input_tokens")),
    ...maybe("cacheRead", read("cache_read_input_tokens")),
  };

  return isEmptyUsage(found) ? undefined : found;
}

const maybe = (key: keyof TokenUsage, value: number | undefined): TokenUsage =>
  value === undefined ? {} : { [key]: value };

export async function runClaudeCode(
  task: string,
  worktree: string,
  options: CliWorkerOptions,
): Promise<CliOutcome> {
  const result = await run(
    "claude",
    [
      "-p",
      task,
      "--model",
      options.model,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: worktree,
      timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      signal: options.signal,
      ...(options.env ? { env: options.env } : {}),
    },
  );

  return parseClaudeCodeResult(result);
}

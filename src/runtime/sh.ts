// Running a subprocess without leaking memory or orphaning it.
//
// Two changes from the original wrapper, both from §9.6: output is ring-buffered
// rather than accumulated into unbounded strings, and a timeout escalates
// SIGTERM → SIGKILL instead of going straight to SIGKILL, so a worker gets the
// chance to flush and clean up its worktree before it is destroyed.
import { spawn, type ChildProcess } from "node:child_process";
import { createRingBuffer } from "./ringBuffer.js";

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Bytes discarded from the middle of the streams, if any. */
  dropped: number;
  /**
   * Wall-clock from spawn to close. §9.5 makes wall-clock the ceiling that actually
   * binds — subscription CLIs report no tokens — so without this nothing could
   * measure the quantity a budget is enforced on.
   */
  elapsedMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Per-stream cap. Defaults to 256 KiB, which is far more than a report needs. */
  maxOutputBytes?: number;
  /** How long a worker gets to exit after SIGTERM before SIGKILL (§9.6). */
  graceMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_OUTPUT = 256 * 1024;
const DEFAULT_GRACE_MS = 2000;

export class ProcessStartError extends Error {
  readonly failure = "transport" as const;

  constructor(cmd: string, cause: NodeJS.ErrnoException) {
    // `codex not found on PATH` beats a raw ENOENT (§2a rule 5).
    const hint =
      cause.code === "ENOENT"
        ? `${cmd} not found on PATH`
        : `${cmd} could not start (${cause.code ?? cause.message})`;
    super(hint, { cause });
    this.name = "ProcessStartError";
  }
}

function terminate(child: ChildProcess, graceMs: number): void {
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  // Do not hold the event loop open waiting to escalate a process that already left.
  killer.unref?.();
  child.once("close", () => clearTimeout(killer));
}

export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = createRingBuffer(limit);
    const stderr = createRingBuffer(limit);
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate(child, graceMs);
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => terminate(child, graceMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d: Buffer) => stdout.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProcessStartError(cmd, err as NodeJS.ErrnoException));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? -1,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        dropped: stdout.dropped + stderr.dropped,
        elapsedMs: Date.now() - startedAt,
      });
    });

    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

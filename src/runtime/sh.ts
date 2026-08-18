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
  /**
   * The child's **entire** environment, not an overlay on this process's (defect 42).
   *
   * It used to be `{ ...process.env, ...opts.env }`, which made every worker inherit
   * every credential the orchestrator was started with and made "no env" the loudest
   * possible grant. Now a caller that says nothing gets the parent environment — which
   * is right for git plumbing, `doctor` probes and a project's own verify command,
   * all of which are the operator's own tools running as the operator — and a caller
   * that hands one over gets exactly that and nothing more. Merging over the parent is
   * still possible and now has to be written out (`{ ...process.env, X: "1" }`), which
   * is the point: it is a decision rather than the default.
   */
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

/**
 * Signal the child's whole process group, falling back to the pid alone.
 *
 * Signalling the pid is not signalling the process. Every transport target here forks —
 * `npx` runs the adapter as a grandchild, a login shell runs the CLI as one — and a
 * SIGTERM to the pid we spawned leaves the real work running, reparented to init, still
 * holding the stdio it inherited. A live mission is what proved it: an ACP worker was
 * "killed" at its 60s deadline and served a permission request two seconds later, while
 * `close` never fired and dispatch waited 46 minutes on a process it believed was gone.
 *
 * The negated pid is the group, which exists only because both spawns pass
 * `detached: true`. The fallback covers the two ways that can fail rather than work:
 * a platform without process groups, and a group whose last member left between the
 * SIGTERM and the SIGKILL (ESRCH).
 */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function terminate(child: ChildProcess, graceMs: number): void {
  signalTree(child, "SIGTERM");
  const killer = setTimeout(() => signalTree(child, "SIGKILL"), graceMs);
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
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so `terminate` can signal everything the target forks.
      detached: true,
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

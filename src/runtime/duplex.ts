// A subprocess that stays open, for an agent we talk to rather than run (§12).
//
// `sh.ts` spawns a command, feeds it stdin, and waits for it to finish — which is
// exactly wrong for ACP, where one JSON-RPC session lives across many requests over
// stdio and nothing ever "completes" until we decide it should. The failure this file
// exists to prevent is an orphan: a long-lived agent process that outlives the thing
// that started it, because its session had no natural end and so nothing killed it
// when the mission timed out, the human aborted, or the loop moved on. Every exit path
// therefore terminates the child the same way §9.6 does — SIGTERM, then SIGKILL after
// a grace period — and `exited` says which path was taken, since a session that timed
// out and a session a human aborted are different facts for the caller to record.
//
// The second failure is memory rather than processes, and it is defect 8 one process
// kind over: an hours-long session's stderr is unbounded diagnostic chatter, so it goes
// through the ring buffer. stdout deliberately does not — it is the protocol channel,
// it belongs to the reader, and copying it here would both duplicate every frame and
// put a cap on the thing the whole session runs on.
import { spawn } from "node:child_process";
import { createRingBuffer } from "./ringBuffer.js";
import { ProcessStartError, terminate } from "./sh.js";

export interface DuplexExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Head + tail of the child's stderr, with a marker naming what was dropped. */
  stderrTail: string;
  /** Bytes of stderr discarded from the middle. */
  stderrDropped: number;
  /** The session outlived `timeoutMs` and was terminated. */
  timedOut: boolean;
  /** The caller's `AbortSignal` fired and the session was terminated. */
  aborted: boolean;
  /** Wall-clock from spawn to close — the ceiling a budget binds on (§9.5). */
  elapsedMs: number;
}

export interface DuplexOptions {
  cwd: string;
  /** The child's **entire** environment when given, not an overlay on this process's
   *  — the same change `sh.ts` carries and for the same reason (defect 42). Omitted
   *  inherits the parent, which no worker path does. */
  env?: NodeJS.ProcessEnv;
  /** Hard ceiling on the whole session. Terminates the child; `timedOut` records it. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-session stderr cap. Defaults to 256 KiB. */
  maxStderrBytes?: number;
  /** How long the agent gets to exit after SIGTERM before SIGKILL (§9.6). */
  graceMs?: number;
}

export interface DuplexProcess {
  /** The JSON-RPC request channel. */
  readonly stdin: NodeJS.WritableStream;
  /** The JSON-RPC response channel. Nothing here buffers it; the reader owns it. */
  readonly stdout: NodeJS.ReadableStream;
  /** Undefined only when the spawn itself failed. */
  readonly pid: number | undefined;
  /** SIGTERM, then SIGKILL. Idempotent, and safe after the process has already gone. */
  kill(): Promise<void>;
  /** Resolves once the child is closed; rejects with `ProcessStartError` if it never started. */
  readonly exited: Promise<DuplexExit>;
}

const DEFAULT_MAX_STDERR = 256 * 1024;
const DEFAULT_GRACE_MS = 2000;

export function spawnDuplex(
  command: string,
  args: readonly string[],
  opts: DuplexOptions,
): DuplexProcess {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const startedAt = Date.now();

  const child = spawn(command, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so `terminate` can signal everything the target forks —
    // `npx` runs the ACP adapter as a grandchild that outlived every SIGTERM before this.
    detached: true,
  });

  const stderr = createRingBuffer(opts.maxStderrBytes ?? DEFAULT_MAX_STDERR);
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child, graceMs);
  }, opts.timeoutMs);

  const onAbort = () => {
    aborted = true;
    terminate(child, graceMs);
  };
  // An already-aborted signal never fires its listeners, so the session would run to
  // its timeout having been cancelled before it began.
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  };

  child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));

  const exited = new Promise<DuplexExit>((resolve, reject) => {
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProcessStartError(command, err as NodeJS.ErrnoException));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal,
        stderrTail: stderr.text(),
        stderrDropped: stderr.dropped,
        timedOut,
        aborted,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });

  // The caller reads the failure off `exited`; this only stops an unawaited session
  // from taking the process down with an unhandled rejection first.
  exited.catch(() => undefined);

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get pid() {
      return child.pid;
    },
    kill() {
      if (!settled) terminate(child, graceMs);
      return exited.then(
        () => undefined,
        () => undefined,
      );
    },
    exited,
  };
}

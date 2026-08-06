// Graceful shutdown (§9.6). Today Ctrl-C orphans every subprocess.
//
// SIGINT stops dispatching, lets in-flight workers finish or checkpoint, flushes the
// log, and prints the exact command to pick the mission back up. A second SIGINT
// means the human wants out now, so it stops asking nicely.
//
// This is distinct from panic (§10), which kills workers, closes browser sessions,
// and denies pending gates. Graceful drain is the wrong response to a worker on the
// wrong page in your bank; it is the right response to Ctrl-C.
export interface ShutdownHandle {
  /** Aborts when shutdown begins. Pass to `run()` so workers are told. */
  readonly signal: AbortSignal;
  readonly requested: boolean;
  /** Resolves once the drain callback has finished. */
  whenDone(): Promise<void>;
  /** Remove the process listeners — required, or tests leak handlers across cases. */
  dispose(): void;
}

export interface ShutdownOptions {
  missionId: string;
  /** Stop dispatching and let in-flight work settle. Must not throw. */
  drain(signal: string): Promise<void>;
  onMessage?(message: string): void;
  /** Injected so tests do not have to fake process signals. */
  process?: Pick<NodeJS.Process, "on" | "off">;
  exit?(code: number): void;
}

export const resumeCommand = (missionId: string): string => `orchestra resume ${missionId}`;

export function installShutdown(options: ShutdownOptions): ShutdownHandle {
  const target = options.process ?? process;
  const say = options.onMessage ?? ((message: string) => process.stderr.write(`${message}\n`));
  const controller = new AbortController();

  let requested = false;
  let done: Promise<void> = Promise.resolve();

  const handle = (signal: NodeJS.Signals) => {
    if (requested) {
      say(`\nSecond ${signal} — exiting now. Some workers may be orphaned.`);
      options.exit?.(130);
      return;
    }
    requested = true;
    controller.abort();
    say(
      `\n${signal} received. Finishing in-flight work, then stopping.\n` +
        `Resume with: ${resumeCommand(options.missionId)}`,
    );
    done = options.drain(signal).then(() => {
      say("Stopped cleanly.");
      options.exit?.(0);
    });
  };

  const onInt = () => handle("SIGINT");
  const onTerm = () => handle("SIGTERM");
  target.on("SIGINT", onInt);
  target.on("SIGTERM", onTerm);

  return {
    signal: controller.signal,
    get requested() {
      return requested;
    },
    whenDone: () => done,
    dispose: () => {
      target.off("SIGINT", onInt);
      target.off("SIGTERM", onTerm);
    },
  };
}

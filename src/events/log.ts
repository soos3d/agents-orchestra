// The append-only event log: the source of truth (§9.1). Everything else on disk
// is a projection and is safe to delete.
//
// The whole append path is deliberately synchronous. `seq` is allocated from an
// in-memory counter and advanced only after the write returns, so two concurrent
// dispatches cannot interleave a read-modify-write and produce a gap. That is not
// an accident of the current code — it is the invariant that makes gapless `seq`
// true, and `append` must never become async.
import fs from "node:fs";
import path from "node:path";
import {
  envelopeOnlySchema,
  eventSchema,
  KNOWN_EVENT_TYPES,
  SCHEMA_VERSION,
  type Event,
  type EventInput,
} from "./schema.js";

export class LogCorruptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LogCorruptionError";
  }
}

export interface EventLogOptions {
  /** Where an unknown event type reports itself. Injected so tests can assert it. */
  onWarn?: (message: string) => void;
  now?: () => string;
}

const LOG_FILE = "events.jsonl";

// The log quotes financial records and worker reports containing real business
// data (§17), so it is owner-only from the moment it is created.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function parseLine(raw: string, file: string, lineNo: number): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LogCorruptionError(
      `${file}:${lineNo} is not valid JSON: ${(err as Error).message}. ` +
        `The event log is the source of truth and cannot be repaired by guessing.`,
      { cause: err },
    );
  }
}

/**
 * Replay rules, in order:
 *   1. Unknown `v` is fatal — the meaning of an existing event may have changed.
 *   2. A gap in `seq` is fatal — corruption is loud, never an empty list.
 *   3. Unknown `type` is skipped with a warning — adding an event stays
 *      backward-compatible.
 *   4. A known type whose payload does not validate is fatal.
 */
function replay(text: string, file: string, onWarn: (message: string) => void): Event[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const events: Event[] = [];

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const parsed = parseLine(line, file, lineNo);

    const envelope = envelopeOnlySchema.safeParse(parsed);
    if (!envelope.success) {
      throw new LogCorruptionError(
        `${file}:${lineNo} is missing the event envelope (v, seq, type).`,
      );
    }

    if (envelope.data.v !== SCHEMA_VERSION) {
      throw new LogCorruptionError(
        `${file}:${lineNo} has schema version ${envelope.data.v}, this build reads ` +
          `version ${SCHEMA_VERSION}. Changing an event's meaning requires a written migration.`,
      );
    }

    const expected = index + 1;
    if (envelope.data.seq !== expected) {
      throw new LogCorruptionError(
        `${file}:${lineNo} has seq ${envelope.data.seq}, expected ${expected}. ` +
          `A gap means events were lost or reordered, and the projections cannot be trusted.`,
      );
    }

    if (!KNOWN_EVENT_TYPES.has(envelope.data.type)) {
      onWarn(
        `${file}:${lineNo} has unknown event type '${envelope.data.type}' — skipped. ` +
          `This log was probably written by a newer build.`,
      );
      return;
    }

    const event = eventSchema.safeParse(parsed);
    if (!event.success) {
      const issue = event.error.issues[0];
      throw new LogCorruptionError(
        `${file}:${lineNo} is a malformed '${envelope.data.type}' event: ` +
          `${issue?.path.join(".") || "(root)"} ${issue?.message}.`,
      );
    }

    events.push(event.data);
  });

  return events;
}

export function createEventLog(missionDir: string, options: EventLogOptions = {}) {
  const file = path.join(missionDir, LOG_FILE);
  const onWarn = options.onWarn ?? ((message: string) => process.emitWarning(message));
  const now = options.now ?? (() => new Date().toISOString());

  // Allocated lazily and then owned in memory. Reading the file to find it on every
  // append would reintroduce the read-modify-write this design exists to avoid.
  let nextSeq: number | undefined;

  function readText(): string | undefined {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new LogCorruptionError(
        `Cannot read the event log at ${file}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  function read(): Event[] {
    const text = readText();
    return text === undefined ? [] : replay(text, file, onWarn);
  }

  // A corrupt log must not be appended to: the first read validates the whole file,
  // so an unreadable history fails here rather than silently continuing from seq 1.
  function ensureSeq(): number {
    if (nextSeq === undefined) {
      const existing = read();
      nextSeq = existing.length === 0 ? 1 : existing[existing.length - 1].seq + 1;
    }
    return nextSeq;
  }

  function append(input: EventInput): Event {
    const seq = ensureSeq();
    const event = { ...input, v: SCHEMA_VERSION, seq, at: now() } as Event;

    // Validate before writing. An invalid event on disk is corruption that only
    // surfaces on the next resume, which is the worst possible time to find it.
    const checked = eventSchema.safeParse(event);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new TypeError(
        `Refusing to log a malformed '${input.type}' event: ` +
          `${issue?.path.join(".") || "(root)"} ${issue?.message}.`,
      );
    }

    fs.mkdirSync(missionDir, { recursive: true, mode: DIR_MODE });
    fs.appendFileSync(file, `${JSON.stringify(checked.data)}\n`, { mode: FILE_MODE });
    nextSeq = seq + 1;
    return checked.data;
  }

  return {
    file,
    append,
    appendAll: (inputs: readonly EventInput[]) => inputs.map(append),
    read,
    lastSeq: () => ensureSeq() - 1,
  };
}

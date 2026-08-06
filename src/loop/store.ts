// The `MissionStore` the loop actually runs against: the append-only log, plus the
// state folded from it.
//
// Events are kept in memory as well as on disk, and `state()` refolds them rather
// than mutating a cached object. That is deliberately the same shape the in-memory
// test store has, so a passing test means the real thing behaves the same way — if
// state could drift from the log here, resume would rebuild a mission that never
// existed.
import { fold, type MissionState } from "../events/fold.js";
import { createEventLog, type EventLogOptions } from "../events/log.js";
import { writeProjections } from "../events/projections.js";
import { type Event, type EventInput } from "../events/schema.js";
import { type MissionStore } from "./run.js";

export interface FileMissionStore extends MissionStore {
  readonly dir: string;
  events(): readonly Event[];
}

export interface FileStoreOptions extends EventLogOptions {
  /** Projections are derived and safe to delete, so writing them is a convenience for
   *  anything reading the mission from outside — not a correctness requirement. */
  projections?: boolean;
}

export function createFileStore(dir: string, options: FileStoreOptions = {}): FileMissionStore {
  const log = createEventLog(dir, options);
  let events: Event[] = log.read();
  let cached: MissionState | undefined;

  const refold = (): MissionState => {
    cached ??= fold(events);
    return cached;
  };

  return {
    dir,
    events: () => events,
    state: refold,
    emit(input: EventInput) {
      // Append first: the log is the source of truth, so a write that fails must
      // leave the in-memory state untouched rather than ahead of the file.
      events = [...events, log.append(input)];
      cached = undefined;
      if (options.projections !== false) writeProjections(dir, refold());
    },
  };
}

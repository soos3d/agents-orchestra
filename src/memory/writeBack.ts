// What a finished mission gives back to memory (§6), and the one impure half of the
// promotion path — `recallToLedger`'s counterpart, `promoteObservations`, decides
// *what* is promoted and this decides where it lands and who is told.
//
// It exists as its own file because it runs at a moment nothing else does: the loop
// has ended, the exit code is already decided, and nothing downstream reads what is
// written until a later mission recalls it. That is exactly the shape of a feature
// that gets built and quietly switched off (defects 12b, 23, 24), so the write is a
// call at the composition root with an event per file rather than a side effect
// buried in the loop.
//
// The refusals are warnings here even though `writeLore` throws them, and that
// inversion is deliberate: a mission that did its work must not fail on its own
// cache. Every refusal is still on the log's warning channel, because a memory layer
// that silently stores nothing is the other way to lose this.
import { type MissionState } from "../events/fold.js";
import { type EventInput } from "../events/schema.js";
import { writeLore } from "./lore.js";
import { promoteObservations } from "./recall.js";

export interface WriteBackDeps {
  state: MissionState;
  /** `<stateDir>/lore` — a sibling of `missions/`, because lore outlives any one. */
  dir: string;
  now: Date;
  emit(event: EventInput): void;
  onWarn?(message: string): void;
}

/**
 * Promote this mission's verified facts into semantic memory.
 *
 * Returns how many files were actually written: a rediscovered fact is a duplicate
 * rather than a new one, and it emits nothing, so a run whose findings were all
 * already known leaves no trail and adds no clock to reset.
 */
export function recordLearnings(deps: WriteBackDeps): number {
  const entries = promoteObservations(deps.state, deps.now);
  const base = { missionId: deps.state.mission.id, actor: "orchestrator" as const };
  let written = 0;

  for (const entry of entries) {
    try {
      const result = writeLore(deps.dir, entry, "orchestrator");
      if (!result.written) continue;
      written++;
      deps.emit({ ...base, type: "memory_written", path: result.path, loreType: entry.type });
    } catch (error) {
      deps.onWarn?.(
        `Not promoting a fact to lore: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return written;
}

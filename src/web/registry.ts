// The mission registry: what `orchestra serve` knows that a per-run server never
// needed to — which missions exist under this state dir, and each one's log.
//
// Read-only over `<stateDir>/missions/`. The registry never appends and never owns a
// store; a live mission writes through its own `createFileStore`, and the registry
// re-reads from disk, which is what makes one server safe over two lifecycles.
//
// One mission's corrupt log must not take the listing down with it: the serve page
// is how a human would notice and `forget` the corrupt one, so a mission that fails
// to read is skipped with a warning naming the file and the fix — the same call
// `readLore` made for a hand-edited fact, and for the same reason. Corruption stays
// loud where the mission itself is being resumed.
import fs from "node:fs";
import path from "node:path";
import { type MissionStatus } from "../domain/mission.js";
import { fold } from "../events/fold.js";
import { createEventLog } from "../events/log.js";
import { type Event } from "../events/schema.js";

export interface MissionSummary {
  id: string;
  goal: string;
  status: MissionStatus;
  updatedAt: string;
}

export interface MissionRegistry {
  missions(): MissionSummary[];
  /** Empty for a mission that does not exist — the caller renders "no such
   *  mission" from an empty list; only a live append path may treat that as fatal. */
  eventsFor(missionId: string): readonly Event[];
}

/** The same refusal `forgetMission` makes, because the id reaches `path.join`. */
const isMissionId = (id: string): boolean =>
  id !== "" && !id.includes("..") && !id.includes(path.sep);

export function createMissionRegistry(
  stateDir: string,
  onWarn: (message: string) => void = () => {},
): MissionRegistry {
  const missionsDir = path.join(stateDir, "missions");

  // Folding every mission on every publish would make the serve dashboard O(logs)
  // per event; the log is append-only, so its size is a sufficient fingerprint.
  const cache = new Map<string, { size: number; events: readonly Event[] }>();

  const read = (missionId: string): readonly Event[] => {
    if (!isMissionId(missionId)) return [];
    const dir = path.join(missionsDir, missionId);
    const file = path.join(dir, "events.jsonl");

    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }

    const hit = cache.get(missionId);
    if (hit && hit.size === size) return hit.events;

    try {
      const events = createEventLog(dir, { onWarn }).read();
      cache.set(missionId, { size, events });
      return events;
    } catch (error) {
      onWarn(
        `Skipping mission '${missionId}': ${(error as Error).message} ` +
          `Fix the log or delete it with 'orchestra forget ${missionId}'.`,
      );
      return [];
    }
  };

  return {
    eventsFor: read,

    missions(): MissionSummary[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(missionsDir, { withFileTypes: true });
      } catch {
        return [];
      }

      return entries
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const events = read(entry.name);
          if (events.length === 0) return [];
          try {
            const { mission } = fold(events);
            return [
              {
                id: mission.id,
                goal: mission.goal,
                status: mission.status,
                updatedAt: mission.updatedAt,
              },
            ];
          } catch (error) {
            onWarn(
              `Skipping mission '${entry.name}': ${(error as Error).message} ` +
                `Fix the log or delete it with 'orchestra forget ${entry.name}'.`,
            );
            return [];
          }
        })
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
  };
}

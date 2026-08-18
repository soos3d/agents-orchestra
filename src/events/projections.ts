// Projections: mission.json and tasks.json. Both are derived from the log and both
// are safe to delete — deleting them mid-mission and watching them rebuild with
// identical state is the only real proof that no field changes without an event.
import fs from "node:fs";
import path from "node:path";
import { DIR_MODE, writeFileAtomic } from "../config/hygiene.js";
import { type MissionState } from "./fold.js";

export const MISSION_FILE = "mission.json";
export const TASKS_FILE = "tasks.json";

// The atomic write with the message this caller wants on it: a projection is derived and
// safe to delete, so the failure a human needs named is which one could not be written.
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  try {
    writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    throw new Error(`Cannot write projection ${file}: ${(err as Error).message}`, { cause: err });
  }
}

export function writeProjections(missionDir: string, state: MissionState): void {
  writeJsonAtomic(path.join(missionDir, MISSION_FILE), state.mission);
  writeJsonAtomic(path.join(missionDir, TASKS_FILE), state.tasks);
}

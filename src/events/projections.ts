// Projections: mission.json and tasks.json. Both are derived from the log and both
// are safe to delete — deleting them mid-mission and watching them rebuild with
// identical state is the only real proof that no field changes without an event.
import fs from "node:fs";
import path from "node:path";
import { type Event } from "./schema.js";
import { fold, type MissionState } from "./fold.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const MISSION_FILE = "mission.json";
export const TASKS_FILE = "tasks.json";

// Write to a sibling temp file and rename over the target: rename is atomic, so an
// interrupted run leaves the previous projection intact rather than a truncated file.
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Cannot write projection ${file}: ${(err as Error).message}`, { cause: err });
  }
}

export function writeProjections(missionDir: string, state: MissionState): void {
  writeJsonAtomic(path.join(missionDir, MISSION_FILE), state.mission);
  writeJsonAtomic(path.join(missionDir, TASKS_FILE), state.tasks);
}

export function rebuildProjections(missionDir: string, events: readonly Event[]): MissionState {
  const state = fold(events);
  writeProjections(missionDir, state);
  return state;
}

// `.orchestra/` hygiene (§17).
//
// The directory accumulates screenshots of logged-in sessions, event-log entries
// quoting financial records, and worker reports containing customer names. All
// plaintext, all sitting next to a git repo. Cheap to get right now; a data-leak
// retrofit later.
//
// The gitignore line is re-asserted on *every* run rather than written once at init,
// because the failure this prevents is somebody deleting the line — or the state dir
// being created inside a repo that never had one.
import fs from "node:fs";
import path from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

const MARKER = "# orchestra: mission state, screenshots, and reports — never commit";

export interface GitignoreResult {
  file: string;
  entry: string;
  added: boolean;
  reason: "already-present" | "appended" | "created" | "not-in-repo";
}

/** The entry to ignore, relative to the repo root and always POSIX-shaped. */
function entryFor(repoRoot: string, stateDir: string): string | undefined {
  const relative = path.relative(repoRoot, stateDir);
  // A state directory outside the repo needs no ignore line — that is the good case.
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return `/${relative.split(path.sep).join("/")}/`;
}

export function ensureGitignored(repoRoot: string, stateDir: string): GitignoreResult {
  const file = path.join(repoRoot, ".gitignore");
  const entry = entryFor(repoRoot, stateDir);

  if (entry === undefined) {
    return { file, entry: "", added: false, reason: "not-in-repo" };
  }

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${MARKER}\n${entry}\n`);
    return { file, entry, added: true, reason: "created" };
  }

  const contents = fs.readFileSync(file, "utf8");
  const present = contents
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === entry || line === entry.replace(/^\//, "").replace(/\/$/, ""));

  if (present) return { file, entry, added: false, reason: "already-present" };

  const separator = contents.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${separator}\n${MARKER}\n${entry}\n`);
  return { file, entry, added: true, reason: "appended" };
}

/** Create a directory the mission owns, readable by nobody else. */
export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdirSync's mode is masked by umask, so it is asserted explicitly afterwards.
  fs.chmodSync(dir, DIR_MODE);
  return dir;
}

/**
 * Write a file the way every write in this system writes: to a sibling temp file, then
 * `renameSync` over the target. Rename is atomic within a filesystem, so an interrupted
 * run leaves the previous contents intact rather than a truncated file that the next
 * read will parse as corrupt.
 *
 * The mode is asserted with an explicit `chmod` after the write because `writeFileSync`'s
 * `mode` is masked by umask — a 0022 umask alone would leave a mission's financial
 * records world-readable. The temp file is removed on failure so a crashed write does not
 * leave `${file}.<pid>.tmp` beside the real one forever, and the original error is
 * rethrown untouched: callers that want a path in the message wrap this and say so.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * The architect's design note, in the mission's artifact directory (PLAN-NEXT 5.1).
 *
 * Best-effort, and that is deliberate: it returns the path it wrote and `undefined` when
 * it could not, so the caller emits `design_written` only for a file that exists. The
 * alternative — an event naming a path nothing wrote — puts a dead path into every code
 * worker's prompt, which is defect 40 one layer up.
 *
 * One name per mission, overwritten on the architect's retry, because the note that
 * belongs to a mission is the one that belongs to the criteria it was signed off on.
 */
export function writeDesignNote(artifactRoot: string, note: string): string | undefined {
  const file = path.join(artifactRoot, "design.md");
  try {
    ensurePrivateDir(artifactRoot);
    fs.writeFileSync(file, note.endsWith("\n") ? note : `${note}\n`, { mode: FILE_MODE });
    fs.chmodSync(file, FILE_MODE);
    return file;
  } catch {
    return undefined;
  }
}

export interface ForgetResult {
  missionId: string;
  removed: boolean;
  path: string;
}

/**
 * Delete everything a mission wrote. The immediate-deletion half of the retention
 * policy; the scheduled half (purge `complete` missions after N days) is Phase 6.
 */
export function forgetMission(stateDir: string, missionId: string): ForgetResult {
  if (missionId === "" || missionId.includes("..") || missionId.includes(path.sep)) {
    throw new Error(`Refusing to delete '${missionId}': not a mission id.`);
  }
  const dir = path.join(stateDir, "missions", missionId);
  const existed = fs.existsSync(dir);
  if (existed) fs.rmSync(dir, { recursive: true, force: true });
  return { missionId, removed: existed, path: dir };
}

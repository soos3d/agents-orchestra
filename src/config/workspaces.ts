// Workspaces: the directories a serve process may run a mission in (UI plan U4).
//
// `discoverConfig` was once-per-process, which made the dashboard's compose card a
// control plane over exactly one hardcoded directory — the process's cwd. A workspace
// is that discovery done once *per directory*, kept in a small registry under the
// state dir so a browser can name one without ever naming a path.
//
// Two rules are structural rather than conventional, and both are here rather than in
// the UI, because a rule the page enforces is a rule a stale tab can skip:
//
//  1. **A workspace is identified by its resolved real path.** Two names for one
//     directory are one workspace, so the one-live-mission-per-workspace cap still
//     protects the checkout it exists to protect. `~/repo`, `./repo` and a symlink to
//     it all collapse to the same id.
//  2. **Discovery is discovery, never declaration** (§2a rule 3). `probeWorkspace`
//     reports what it found — git repo or not, verify command and where it came from,
//     workers on PATH — and nothing in this file accepts any of it as input.
//
// The state dir does *not* move with the workspace. Missions stay under the serve
// process's own state dir so the registry keeps one listing and a mission stays
// addressable by id alone; a workspace supplies the repo, the worktree root, and the
// verify command, which is everything the loop actually reads a directory for.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { repoRoot } from "../git/repo.js";
import {
  discoverVerifyCommand,
  probeAgents,
  type DiscoveredConfig,
} from "./discover.js";
import { ensurePrivateDir, writeFileAtomic } from "./hygiene.js";

export const WORKSPACES_FILE = "workspaces.json";

const workspaceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  addedAt: z.string().min(1),
});

const registrySchema = z.object({ workspaces: z.array(workspaceSchema) });

export type Workspace = z.infer<typeof workspaceSchema>;

/** What discovery found for a directory, and the whole of what a human is shown
 *  before they confirm it. Every field is observed; none is settable. */
export interface WorkspaceProbe {
  /** Absolute, and resolved through symlinks where the directory already exists. */
  path: string;
  /** What the human typed, echoed back so the card can say what it resolved *from*. */
  input: string;
  id: string;
  exists: boolean;
  /** False for a path that exists and is a file — the one refusal a probe can make. */
  isDirectory: boolean;
  repoRoot?: string;
  verify?: { command: string; source: string };
  agents: readonly string[];
  /** Where this workspace's missions will be written. The serve process's, always. */
  stateDir: string;
  /** Already registered — adding it again is a no-op, and the card should say so. */
  registered: boolean;
  /** Why this cannot be added, when it cannot. */
  problem?: string;
}

/**
 * The id, derived rather than assigned.
 *
 * A hash of the real path, so the same directory reached by two names is one
 * workspace — which is what keeps the per-workspace mission cap meaning "one mission
 * per checkout" rather than "one mission per spelling". Derived also means no clock
 * and no counter, so registering is idempotent and a registry can be rebuilt from the
 * paths alone.
 */
export const workspaceId = (resolvedPath: string): string =>
  `ws-${crypto.createHash("sha256").update(resolvedPath).digest("hex").slice(0, 12)}`;

/**
 * A path a human typed, resolved to an absolute one.
 *
 * `~` is expanded because a person typing a home-relative path into a browser means
 * it, and a relative path resolves against the directory the serve process was
 * launched in — the one directory the user can see on their own terminal. Symlinks
 * are resolved only where the path exists; a directory about to be created has no
 * real path yet, so its parent's is used instead and the leaf appended.
 */
export function resolveWorkspacePath(input: string, base: string, home = os.homedir()): string {
  const expanded =
    input === "~" ? home : input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
  const absolute = path.resolve(base, expanded);

  try {
    return fs.realpathSync(absolute);
  } catch {
    // Not there yet. Resolve as much of it as does exist, so a workspace created
    // under /var on macOS is the same workspace as one added under /private/var.
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * What is true about a directory, asked of the machine rather than of the user.
 *
 * Deliberately not `discoverConfig`: that function reads `TARGET_REPO` and
 * `ORCHESTRA_STATE_DIR`, which are once-per-process overrides and would pin every
 * workspace to one repo. Per-workspace discovery is the whole point of U4, so the
 * three things a directory can tell us are asked directly.
 */
export async function probeWorkspace(
  input: string,
  base: string,
  stateDir: string,
  known: readonly Workspace[] = [],
): Promise<WorkspaceProbe> {
  const resolved = resolveWorkspacePath(input, base);
  const id = workspaceId(resolved);
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : undefined;
  const exists = stat !== undefined;
  const isDirectory = stat?.isDirectory() ?? false;

  const root = exists && isDirectory ? await repoRoot(resolved) : undefined;
  const agents = await probeAgents();

  return {
    path: resolved,
    input,
    id,
    exists,
    isDirectory,
    ...(root ? { repoRoot: root } : {}),
    ...(root ? { verify: discoverVerifyCommand(root) } : {}),
    agents,
    stateDir,
    registered: known.some((workspace) => workspace.id === id),
    ...(exists && !isDirectory
      ? { problem: "that path is a file, not a directory. Give a directory, or a new name to create." }
      : {}),
  };
}

/**
 * The registry on disk. A missing file is no workspaces rather than an error — the
 * first serve has none — and an unreadable one is reported and treated as empty, for
 * the reason `loadProfiles` does the same: losing the list must never be the thing
 * that stops a mission from being composed.
 */
export function readWorkspaces(stateDir: string, onWarn: (message: string) => void = () => {}): Workspace[] {
  const file = path.join(stateDir, WORKSPACES_FILE);
  if (!fs.existsSync(file)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    onWarn(
      `Ignoring ${file}: ${(error as Error).message} ` +
        `Fix or delete the file — a deleted registry costs nothing but re-adding the directories.`,
    );
    return [];
  }

  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    onWarn(
      `Ignoring ${file}: ${issue?.path.join(".") || "workspaces"}: ${issue?.message ?? "unrecognised"}. ` +
        `Fix or delete the file — a deleted registry costs nothing but re-adding the directories.`,
    );
    return [];
  }
  return parsed.data.workspaces;
}

/** Atomic and owner-only, like every other write in the system. */
export function writeWorkspaces(stateDir: string, workspaces: readonly Workspace[]): void {
  const dir = ensurePrivateDir(stateDir);
  const file = path.join(dir, WORKSPACES_FILE);
  try {
    writeFileAtomic(file, `${JSON.stringify({ workspaces }, null, 2)}\n`);
  } catch (error) {
    throw new Error(`Cannot write ${file}: ${(error as Error).message}`, { cause: error });
  }
}

/** Idempotent by construction, because the id is derived from the path: adding a
 *  workspace twice returns the list unchanged rather than a duplicate row. */
export function withWorkspace(
  workspaces: readonly Workspace[],
  workspace: Workspace,
): readonly Workspace[] {
  return workspaces.some((each) => each.id === workspace.id)
    ? workspaces
    : workspaces.concat([workspace]);
}

/** A registered directory, and the filesystem roots a mission composed in it would
 *  have been scoped to: the directory itself, and its repo root when it has one. */
export interface WorkspaceRoots {
  id: string;
  roots: readonly string[];
}

/**
 * Which workspace a mission belongs to, decided from the mission's own log (UI plan
 * U6).
 *
 * Resuming from the browser needs a directory, and the log does not record one: it
 * records the envelope, whose `fsRoots` is the repo root or the cwd the mission was
 * composed against (`defaultEnvelope`). That is a fact a human approved rather than a
 * field this feature invented, so it is what the match is made on — no event type
 * changes, and a mission written by an older version resolves the same way.
 *
 * Returning `undefined` is a real answer and the caller must refuse rather than guess:
 * a mission scoped to a directory this serve process has never been shown would
 * otherwise be resumed in the wrong checkout, which is the one mistake worse than
 * making somebody open a terminal.
 */
export function workspaceForRoots(
  fsRoots: readonly string[],
  candidates: readonly WorkspaceRoots[],
): string | undefined {
  const wanted = new Set(fsRoots);
  return candidates.find((candidate) => candidate.roots.some((root) => wanted.has(root)))?.id;
}

/**
 * The config a mission in this workspace runs under.
 *
 * Everything a directory can answer comes from the directory; everything about *this
 * process* — the state dir, the model, the concurrency cap, the gateway — comes from
 * the serve process's own config. `worktreeRoot` is derived per workspace rather than
 * carried over, because a worktree is a checkout of one repo and cannot be shared
 * across two.
 */
export async function configForWorkspace(
  base: DiscoveredConfig,
  dir: string,
): Promise<DiscoveredConfig> {
  const root = await repoRoot(dir);
  const anchor = root ?? dir;

  return {
    ...base,
    cwd: dir,
    ...(root ? { repoRoot: root } : { repoRoot: undefined }),
    worktreeRoot: path.join(anchor, "..", ".orchestra-worktrees"),
    verify: root ? discoverVerifyCommand(root) : undefined,
  };
}

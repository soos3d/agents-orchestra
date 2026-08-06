// Config is discovered, not declared (§2a rule 3).
//
// The old `config.ts` threw without `TARGET_REPO`, which is exactly backwards: the
// repo is whatever you are standing in, the verification command is written in the
// project's own manifest, and the available agents are whatever is on PATH. Zero
// required environment variables on the happy path; env vars only ever override.
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../git/repo.js";
import { run } from "../runtime/sh.js";

export interface DiscoveredConfig {
  cwd: string;
  /** Undefined outside a git repo — a research or computer mission does not need one. */
  repoRoot?: string;
  stateDir: string;
  worktreeRoot: string;
  verify?: { command: string; source: string };
  agents: string[];
  orchestratorModel: string;
  maxConcurrency: number;
}

interface Candidate {
  file: string;
  command: string;
  /** Only counts if the manifest actually defines it. */
  requires?: (contents: string) => boolean;
}

// Ordered by how specific the signal is. A `test` script in package.json is a
// stronger statement of "this is how you know it is green" than a bare Makefile.
const CANDIDATES: Candidate[] = [
  {
    file: "package.json",
    command: "npm test",
    requires: (raw) => {
      try {
        return typeof JSON.parse(raw)?.scripts?.test === "string";
      } catch {
        return false;
      }
    },
  },
  { file: "Makefile", command: "make check", requires: (raw) => /^check\s*:/m.test(raw) },
  { file: "Makefile", command: "make test", requires: (raw) => /^test\s*:/m.test(raw) },
  { file: "pyproject.toml", command: "pytest -q" },
  { file: "Cargo.toml", command: "cargo test" },
  { file: "go.mod", command: "go test ./..." },
];

export function discoverVerifyCommand(root: string): DiscoveredConfig["verify"] {
  for (const candidate of CANDIDATES) {
    const file = path.join(root, candidate.file);
    if (!fs.existsSync(file)) continue;
    if (candidate.requires && !candidate.requires(fs.readFileSync(file, "utf8"))) continue;
    return { command: candidate.command, source: candidate.file };
  }
  return undefined;
}

const KNOWN_AGENTS = ["claude", "codex"] as const;

export async function probeAgents(): Promise<string[]> {
  const found = await Promise.all(
    KNOWN_AGENTS.map(async (agent): Promise<string | undefined> => {
      const result = await run("which", [agent], { timeoutMs: 5000 }).catch(() => undefined);
      return result?.code === 0 ? agent : undefined;
    }),
  );
  return found.filter((agent): agent is string => agent !== undefined);
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export async function discoverConfig(cwd = process.cwd()): Promise<DiscoveredConfig> {
  const root = process.env.TARGET_REPO
    ? path.resolve(process.env.TARGET_REPO)
    : await repoRoot(cwd);

  // State lives beside the repo, not inside it, so a mission's screenshots and
  // reports are never one `git add -A` away from being committed (§17).
  const base = root ?? cwd;
  const stateDir = process.env.ORCHESTRA_STATE_DIR
    ? path.resolve(process.env.ORCHESTRA_STATE_DIR)
    : path.join(base, ".orchestra");

  return {
    cwd,
    repoRoot: root,
    stateDir,
    worktreeRoot: process.env.WORKTREE_ROOT
      ? path.resolve(process.env.WORKTREE_ROOT)
      : path.join(base, "..", ".orchestra-worktrees"),
    verify: root ? discoverVerifyCommand(root) : undefined,
    agents: await probeAgents(),
    orchestratorModel: process.env.ORCHESTRATOR_MODEL || "fable",
    maxConcurrency: num(process.env.MAX_CONCURRENCY, 4),
  };
}

export const missionDir = (stateDir: string, missionId: string): string =>
  path.join(stateDir, "missions", missionId);

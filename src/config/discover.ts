// Config is discovered, not declared (§2a rule 3).
//
// The old `config.ts` threw without `TARGET_REPO`, which is exactly backwards: the
// repo is whatever you are standing in, the verification command is written in the
// project's own manifest, and the available agents are whatever is on PATH. Zero
// required environment variables on the happy path; env vars only ever override.
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../git/repo.js";
import { PROVIDERS } from "../providers/openaiCompatible.js";
import { CONTAINER_BACKENDS } from "../runtime/contained.js";
import { run } from "../runtime/sh.js";

export interface DiscoveredConfig {
  cwd: string;
  /** Undefined outside a git repo — a research or computer mission does not need one. */
  repoRoot?: string;
  stateDir: string;
  worktreeRoot: string;
  verify?: { command: string; source: string };
  agents: string[];
  /**
   * Container backends whose daemon answered (PLAN-NEXT 3.3).
   *
   * Optional for `providerKeys`' reason: one producer, `discoverConfig`, which always
   * sets it and is asserted to in `discover.test.ts`; required would have meant editing
   * every config literal in the suite to say "none". Absent reads as none everywhere.
   */
  containers?: string[];
  /** `ORCHESTRA_CONTAINER_IMAGE`. Absent means containment is unavailable however many
   *  backends answered — there is no default image and there must not be one. */
  containerImage?: string;
  orchestratorModel: string;
  maxConcurrency: number;
  /** An OpenClaw Gateway to mirror the inbox to, if the user runs one (§2). Never
   *  required; refused unless loopback (§17). */
  gatewayUrl?: string;
  /**
   * API keys by provider name, for the providers that have one set (PLAN-NEXT 2.2).
   *
   * Read here because this is one of the two places `process.env` is read at all, and
   * that is not becoming three: `providers/openaiCompatible.ts` knows the variable
   * *names* and never the values, and `probeProviders` is handed what it needs. A
   * provider with no key is absent from this record rather than present and empty —
   * unconfigured is a configuration, and a blank string would be a key that fails
   * authentication instead of a provider nobody asked for.
   *
   * Optional for the reason `gatewayUrl` is: a machine with no provider configured is
   * the normal case, and every reader treats absent as "no providers". `discoverConfig`
   * always sets it, which is what `discover.test.ts` asserts — there is one producer,
   * so this is not the optional-`Deps` trap.
   */
  providerKeys?: Record<string, string>;
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

/** `opencode` joined the list on 2026-08-16, when a session against a real binary was
 *  captured and it became a launchable `acp` target rather than a reported extra
 *  (`workers/acp/registry.ts`). It has no `cli` launcher — see `CLI_TARGETS`. */
const KNOWN_AGENTS = ["claude", "codex", "opencode"] as const;

async function probe(names: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    names.map(async (agent): Promise<string | undefined> => {
      const result = await run("which", [agent], { timeoutMs: 5000 }).catch(() => undefined);
      return result?.code === 0 ? agent : undefined;
    }),
  );
  return found.filter((agent): agent is string => agent !== undefined);
}

export const probeAgents = (): Promise<string[]> => probe(KNOWN_AGENTS);

/**
 * Which container backends can actually start a container right now (PLAN-NEXT 3.3).
 *
 * **`which docker` is not the question, and answering it would rebuild defect 21.** The
 * CLI is installed on every machine whose Docker Desktop is closed, and a mission staffed
 * against a backend that is present-but-not-running dies at dispatch — every task, each
 * burning its retry and taking a replan with it. So the probe asks the daemon.
 *
 * `version --format {{.Server.Version}}` rather than `info`, which is a real trap and not
 * a preference: with the daemon stopped, `docker info` prints "Cannot connect to the
 * Docker daemon" and **exits 0**. `version` exits 1, and the non-empty stdout check is
 * the belt to that brace.
 *
 * A podman with no service running reads as absent here. That is a false negative rather
 * than a wrong offer, which is the direction this codebase errs in everywhere — empty
 * means nothing is offered, and `podman machine start` fixes it.
 */
export async function probeContainers(): Promise<string[]> {
  const found = await Promise.all(
    CONTAINER_BACKENDS.map(async (backend): Promise<string | undefined> => {
      const result = await run(backend, ["version", "--format", "{{.Server.Version}}"], {
        timeoutMs: 15_000,
      }).catch(() => undefined);
      return result?.code === 0 && result.stdout.trim() !== "" ? backend : undefined;
    }),
  );
  return found.filter((backend): backend is string => backend !== undefined);
}

/**
 * Which model providers this machine has a key for, by provider name (PLAN-NEXT 2.2).
 *
 * Pure over an environment rather than reading `process.env` itself, so what a machine
 * offers is assertable without mutating the process — the habit `availableTransports`
 * follows for PATH. A provider whose variable is unset or blank is absent from the
 * result: `probeProviders` skips it, `doctor` reports it as not configured, and nothing
 * about a mission changes, which is the whole "no key present, nothing changes"
 * requirement.
 */
export function readProviderKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(PROVIDERS).flatMap(([name, provider]) => {
      const value = env[provider.keyEnv];
      return value === undefined || value === "" ? [] : [[name, value] as const];
    }),
  );
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
    containers: await probeContainers(),
    // No default, deliberately: an image has to contain the agent CLI and none has been
    // verified for this project, so inventing a name here would be a menu entry nobody
    // probed (`runtime/contained.ts`, and the `MODELS_BY_VENDOR.openai` discipline).
    ...(process.env.ORCHESTRA_CONTAINER_IMAGE
      ? { containerImage: process.env.ORCHESTRA_CONTAINER_IMAGE }
      : {}),
    // An alias rather than a pinned id, so the default follows the latest build the
    // SDK resolves it to. §14 notes nothing in the design depends on a specific
    // model; `ORCHESTRATOR_MODEL` is the override when it does.
    orchestratorModel: process.env.ORCHESTRATOR_MODEL || "opus",
    maxConcurrency: num(process.env.MAX_CONCURRENCY, 4),
    providerKeys: readProviderKeys(process.env),
    // The phone mirror's gateway, when one is configured at all (§2). Carried as
    // config so `doctor` can refuse a non-loopback URL before anything trusts it.
    ...(process.env.ORCHESTRA_GATEWAY_URL ? { gatewayUrl: process.env.ORCHESTRA_GATEWAY_URL } : {}),
  };
}

/**
 * The mission's own orchestrator model laid over the process's, for the six decision
 * points.
 *
 * `createCalls` takes a `DiscoveredConfig` and reads `orchestratorModel` off it, which
 * is what makes a per-mission override this small: one substitution at the two roots
 * that build the calls (`runCommand`, `resumeCommand`). `undefined` returns the config
 * untouched rather than writing the default back over it, so "nothing was chosen" and
 * "the default was chosen" stay different facts — the same reason `spend` keeps absent
 * usage absent instead of zero (§9.5).
 *
 * `PROGRESS_MODEL` is deliberately not affected. It is a small judgment called every
 * round on a cheaper model by design (§3), and a human choosing `opus` for planning is
 * not asking for the round-by-round check to cost five times more.
 */
export const withOrchestratorModel = (
  config: DiscoveredConfig,
  model: string | undefined,
): DiscoveredConfig => (model === undefined ? config : { ...config, orchestratorModel: model });

export const missionDir = (stateDir: string, missionId: string): string =>
  path.join(stateDir, "missions", missionId);

/**
 * Where a task's outputs belong (P2), and the answer to a collision the system had
 * no legal resolution for: a judge rubric obliges an artifact (defect 27) and a
 * non-`code` worker has nowhere to write one, because writing into the checkout is
 * now refused (defect 41). One directory per task, under the mission's own state.
 *
 * `.orchestra/` is gitignored and re-asserted every run, so a write here is invisible
 * to `detectRepoEscape` by construction — the escape check does not have to know this
 * directory exists.
 *
 * The id guard is `forgetMission`'s, for the same reason: a task id reaches here from
 * a plan a model wrote, and `..` in one would put a mission's artifacts anywhere on
 * the disk.
 */
export const artifactDir = (stateDir: string, missionId: string, taskId: string): string =>
  taskArtifactDir(artifactRoot(stateDir, missionId), taskId);

/** The mission's half of it: what a composition root computes once and hands the loop. */
export const artifactRoot = (stateDir: string, missionId: string): string =>
  path.join(missionDir(stateDir, missionId), "artifacts");

/**
 * The task's half, guarded — and it is the half `dispatch` calls, which is why the
 * guard lives here rather than only in `artifactDir`. A task id is written by a model
 * and joined onto a path; `..` in one would put a mission's artifacts anywhere on the
 * disk.
 */
export function taskArtifactDir(root: string, taskId: string): string {
  if (taskId === "" || taskId.includes("..") || taskId.includes(path.sep)) {
    throw new Error(
      `Refusing to build an artifact directory for '${taskId}': not a task id. ` +
        `A task id is a plain name with no path separators.`,
    );
  }
  return path.join(root, taskId);
}

/** Semantic memory is cross-mission (§6), so it is a sibling of `missions/` rather
 *  than something inside one — a mission deleted by `orchestra forget` must not take
 *  the environment's accumulated lore with it. */
export const loreDir = (stateDir: string): string => path.join(stateDir, "lore");

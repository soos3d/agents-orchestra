// `orchestra doctor` (§2a rule 4).
//
// One command that reports what is installed, authed, and missing — each with the
// specific fix. Never a wall of setup documentation, and never a raw ENOENT: a check
// that cannot tell you what to type next has not helped.
import fs from "node:fs";
import path from "node:path";
import { SCANNERS } from "../domain/artifacts.js";
import {
  type ModelCard,
  loadModelCards,
  localProvidersDir,
  providersDir,
  staffableCards,
} from "../providers/modelCard.js";
import { runnableAcpTargets } from "../workers/availability.js";
import { type DiscoveredConfig } from "./discover.js";
import { readRepoKb, type RepoKb } from "./kb.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  /** The exact thing to type. Absent only when the check passed. */
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  ready: boolean;
}

const MIN_NODE_MAJOR = 20;

function checkNode(version: string): Check {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", level: "ok", detail: version }
    : {
        name: "node",
        level: "fail",
        detail: `${version}, need ${MIN_NODE_MAJOR}+`,
        fix: "install a newer Node — https://nodejs.org, or `nvm install 22`",
      };
}

function checkRepo(config: DiscoveredConfig): Check {
  if (config.repoRoot) {
    return { name: "repo", level: "ok", detail: `${config.repoRoot} (detected from cwd)` };
  }
  return {
    name: "repo",
    level: "warn",
    // Not a failure: research and computer-use missions have no repo at all.
    detail: `${config.cwd} is not a git repo — code tasks will be unavailable`,
    fix: "run from inside a repo, or `git init`, if this mission writes code",
  };
}

function checkVerify(config: DiscoveredConfig): Check {
  if (config.verify) {
    return {
      name: "verification",
      level: "ok",
      detail: `${config.verify.command} (from ${config.verify.source})`,
    };
  }
  return {
    name: "verification",
    level: "warn",
    detail: "no test command found",
    fix: "add a `test` script to package.json, or a `check:` target to your Makefile",
  };
}

function checkAgents(config: DiscoveredConfig): Check {
  if (config.agents.length > 0) {
    return { name: "workers", level: "ok", detail: config.agents.join(", ") };
  }
  return {
    name: "workers",
    level: "fail",
    detail: "no coding agent on PATH",
    fix: "npm i -g @anthropic-ai/claude-code && claude   # log in once, then quit",
  };
}

/**
 * What can run over ACP on this machine (§12), which is the question synthesis is
 * actually asked at staffing time — `availableTransports` computes the offer and this
 * line is the same computation made visible.
 *
 * A warning rather than a failure when nothing qualifies: `cli` is the fallback path and
 * a mission runs without ACP. The `workers` check has already gone red in that case, so
 * this never fires alone.
 */
function checkAcp(config: DiscoveredConfig): Check {
  const targets = runnableAcpTargets(config);
  if (targets.length > 0) {
    // `opencode` is its own adapter and is not fetched — the note is about the two
    // that are, so it names them rather than claiming npx for all three.
    const npx = targets.filter((target) => target !== "opencode");
    const how = npx.length > 0 ? ` (${npx.join(", ")} adapters fetched by npx)` : "";
    return { name: "acp", level: "ok", detail: `${targets.join(", ")}${how}` };
  }
  return {
    name: "acp",
    level: "warn",
    detail: "no agent with a pinned ACP adapter on PATH — workers fall back to the cli transport",
    fix: "npm i -g @anthropic-ai/claude-code && claude   # log in once, then quit",
  };
}

/**
 * Model providers: which have a key, and how many of their cards a probe has answered
 * for (PLAN-NEXT 2.3).
 *
 * The line reports the *narrowing*, which is the fact a mission depends on: a card with
 * no transcript is not on any menu, exactly as an ACP target with no binary is not. Never
 * a failure — no provider configured is the normal case and changes nothing about a
 * mission — but a configured provider whose cards are all unverified is a warning, because
 * that is a key somebody set expecting models to appear.
 */
export function checkProviders(
  cards: readonly ModelCard[],
  keys: Readonly<Record<string, string>>,
  verified: readonly ModelCard[],
): Check {
  const configured = Object.keys(keys).sort();
  if (configured.length === 0 && cards.length === 0) {
    return { name: "providers", level: "ok", detail: "none configured — model cards are optional" };
  }

  if (verified.length > 0) {
    return {
      name: "providers",
      level: "ok",
      detail:
        `${configured.join(", ") || "no key"}: ${verified.length} of ${cards.length} ` +
        `card${cards.length === 1 ? "" : "s"} verified`,
    };
  }

  return {
    name: "providers",
    level: "warn",
    detail:
      configured.length === 0
        ? `${cards.length} model card${cards.length === 1 ? "" : "s"} on disk and no ` +
          `provider key set — none are offered`
        : `${configured.join(", ")} configured, no card verified — none are offered`,
    fix:
      cards.length === 0
        ? "write a card into <stateDir>/providers/<provider>.json, then re-run 'orchestra doctor'"
        : "set the provider's API key and re-run 'orchestra doctor' — it probes each card once",
  };
}

/**
 * Whether this machine can run a worker inside a container (PLAN-NEXT 3.3).
 *
 * Two halves that fail differently and are fixed differently, so the line says which one
 * is missing: a daemon that is not answering is `docker desktop start`, and a daemon with
 * no image named is `ORCHESTRA_CONTAINER_IMAGE`. Reporting "containment unavailable" for
 * both would send someone to restart a daemon that is already running.
 *
 * Never a failure. Containment is opt-in per mission and no mission composed today asks
 * for one; a machine without it runs exactly as every machine ran before this existed.
 * The refusal that matters happens at synthesis, on the mission that did ask.
 */
/**
 * Whether a specialist scanner could run here (PLAN-NEXT 6.3).
 *
 * Never a failure, and never a warning either: a scanner is opt-in per mission and no
 * mission composed today asks for one, so a machine without it runs exactly as every
 * machine ran before this existed. The line exists so that somebody who *did* grant one
 * and had the criterion refused can see which half is missing without reading the source.
 */
export function checkScanners(config: DiscoveredConfig): Check {
  const found = config.scanners ?? [];
  return {
    name: "scanners",
    level: "ok",
    detail:
      found.length === 0
        ? `none on PATH — a 'scanner' check would be refused when the outcome spec is written`
        : `${found.join(", ")} ready; a mission's envelope still has to grant one by name`,
    fix:
      found.length === 0
        ? `npm i -g ${SCANNERS.join(" ")} if you want to compose a mission with a scanner gate`
        : "grant it in the mission's envelope to use it",
  };
}

/**
 * Whether the repository map exists and which commit it describes (PLAN-NEXT 8.1).
 *
 * Read from the cache rather than built here, so `doctor` stays the diagnostic it is —
 * `orchestra doctor` builds the map before it renders the report, and this line is what
 * that build made true. Never a failure and never a warning: a mission with no map plans
 * exactly as every mission planned before the map existed, and a repository is not
 * required to have one — `checkRepo` has already said so when there is no repo at all.
 */
export function checkKb(config: DiscoveredConfig, kb?: RepoKb): Check {
  if (!config.repoRoot) return { name: "repo map", level: "ok", detail: "no repo to index" };
  if (!kb) {
    return {
      name: "repo map",
      level: "ok",
      detail: "not built — research and the architect plan without a file map",
      fix: "run 'orchestra doctor' from inside the repo, or start a mission (it builds one)",
    };
  }
  return {
    name: "repo map",
    level: "ok",
    detail: `${kb.index.length} chars at ${kb.head.slice(0, 7)} — rebuilt when HEAD moves`,
  };
}

export function checkContainment(config: DiscoveredConfig): Check {
  const backends = config.containers ?? [];

  if (backends.length === 0) {
    return {
      name: "containment",
      level: "ok",
      detail: "no container backend answering — missions run on this machine",
      fix: "start Docker or Podman if you want to compose a mission with containment",
    };
  }

  if (!config.containerImage) {
    return {
      name: "containment",
      level: "warn",
      detail: `${backends.join(", ")} ready, but no worker image is set — containment is unavailable`,
      // Named rather than suggested: no image with an agent CLI in it has been verified
      // for this project, and printing one here would be a recommendation nobody probed.
      fix: "export ORCHESTRA_CONTAINER_IMAGE=<an image with your agent CLI installed and logged in>",
    };
  }

  return {
    name: "containment",
    level: "ok",
    detail: `${backends[0]} running ${config.containerImage}`,
  };
}

function checkStateDir(config: DiscoveredConfig): Check {
  const parent = config.stateDir;
  try {
    fs.accessSync(fs.existsSync(parent) ? parent : ".", fs.constants.W_OK);
    return { name: "state", level: "ok", detail: parent };
  } catch {
    return {
      name: "state",
      level: "fail",
      detail: `${parent} is not writable`,
      fix: `chmod u+w ${parent}, or set ORCHESTRA_STATE_DIR to somewhere writable`,
    };
  }
}

// Reported rather than repaired: `doctor` is a diagnostic and must not write to the
// repo. `orchestra run` and `orchestra resume` re-assert the line themselves (§17).
function checkIgnored(config: DiscoveredConfig): Check {
  if (!config.repoRoot) return { name: "gitignore", level: "ok", detail: "no repo to ignore into" };

  const inside = !path.relative(config.repoRoot, config.stateDir).startsWith("..");
  if (!inside) {
    return { name: "gitignore", level: "ok", detail: "state lives outside the repo" };
  }

  const file = path.join(config.repoRoot, ".gitignore");
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const name = path.basename(config.stateDir);
  const ignored = contents.split("\n").some((line) => line.trim().replace(/^\/|\/$/g, "") === name);

  return ignored
    ? { name: "gitignore", level: "ok", detail: `${name}/ is ignored` }
    : {
        name: "gitignore",
        level: "warn",
        // A warning rather than a failure: the next run fixes it. But a mission that
        // has already written screenshots is one `git add -A` from committing them.
        detail: `${name}/ is not in .gitignore — it holds screenshots and worker reports`,
        fix: "the next `orchestra run` adds it, or add it yourself now",
      };
}

export function doctor(
  config: DiscoveredConfig,
  nodeVersion: string = process.version,
): DoctorReport {
  const cards = loadModelCards([providersDir(), localProvidersDir(config.stateDir)]);
  const checks = [
    checkNode(nodeVersion),
    checkRepo(config),
    checkVerify(config),
    checkAgents(config),
    checkAcp(config),
    checkProviders(cards, config.providerKeys ?? {}, staffableCards(config.stateDir)),
    checkContainment(config),
    checkScanners(config),
    checkKb(config, readRepoKb(config.stateDir)),
    checkStateDir(config),
    checkIgnored(config),
  ];
  return { checks, ready: checks.every((check) => check.level !== "fail") };
}

const SYMBOL: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatReport(report: DoctorReport): string {
  const lines = report.checks.flatMap((check) => {
    const head = `${SYMBOL[check.level]} ${check.name.padEnd(13)} ${check.detail}`;
    return check.fix ? [head, `                → ${check.fix}`] : [head];
  });
  lines.push("");
  lines.push(report.ready ? "Ready." : "Not ready — fix the ✗ lines above.");
  return lines.join("\n");
}

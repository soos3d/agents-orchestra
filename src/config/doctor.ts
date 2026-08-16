// `orchestra doctor` (§2a rule 4).
//
// One command that reports what is installed, authed, and missing — each with the
// specific fix. Never a wall of setup documentation, and never a raw ENOENT: a check
// that cannot tell you what to type next has not helped.
import fs from "node:fs";
import path from "node:path";
import { runnableAcpTargets } from "../workers/availability.js";
import { type DiscoveredConfig } from "./discover.js";

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

/** Hosts that keep the gate on this machine. Everything else is refused — §17's
 *  rule is bind to loopback and refuse a non-loopback Gateway, not authenticate it. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function checkChannel(gatewayUrl?: string): Check {
  if (!gatewayUrl) {
    // The default, and a passing one: no mirror is a configuration, not a gap (§2).
    return { name: "channel", level: "ok", detail: "no mirror configured — inbox on the local dashboard" };
  }

  let host: string;
  try {
    host = new URL(gatewayUrl).hostname;
  } catch {
    return {
      name: "channel",
      level: "fail",
      detail: `ORCHESTRA_GATEWAY_URL '${gatewayUrl}' is not a URL`,
      fix: "set it to the Gateway's loopback address, e.g. ws://127.0.0.1:18789, or unset it",
    };
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      name: "channel",
      level: "fail",
      detail: `${gatewayUrl} is not loopback — a remote Gateway is refused (§17)`,
      fix: "run the Gateway on this machine and use ws://127.0.0.1:<port>, or unset ORCHESTRA_GATEWAY_URL",
    };
  }

  return {
    name: "channel",
    level: "warn",
    detail: `${gatewayUrl} configured; the OpenClaw carrier is pending its spike — no mirror yet`,
    fix: "nothing to type — the local dashboard carries the inbox until the carrier lands",
  };
}

export function doctor(
  config: DiscoveredConfig,
  nodeVersion: string = process.version,
): DoctorReport {
  const checks = [
    checkNode(nodeVersion),
    checkRepo(config),
    checkVerify(config),
    checkAgents(config),
    checkAcp(config),
    checkStateDir(config),
    checkIgnored(config),
    checkChannel(config.gatewayUrl),
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

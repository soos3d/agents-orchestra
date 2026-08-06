// `orchestra run "<goal>"` — the mission, from the terminal.
//
// The app is the primary interface (§2b) and lands in Phase 3. The terminal is not
// scaffolding to throw away though: `--unattended` keeps it a supported mode forever,
// and `--plan-only` is the CI gate.
//
// Two rules are enforced here rather than left to habit. `--unattended` needs an
// explicit `--force` (§17: it must never become the habitual default), and a rejected
// criterion exits non-zero so a pipeline notices.
import path from "node:path";
import { type Budget } from "../domain/budget.js";
import { type Envelope } from "../domain/envelope.js";
import { type Estimate } from "../domain/mission.js";
import { type Task } from "../domain/task.js";
import { type MissionState } from "../events/fold.js";
import { createMergeQueue } from "../git/mergeQueue.js";
import { currentBranch } from "../git/repo.js";
import { type Calls } from "../loop/calls.js";
import { dispatch, type DispatchOutcome } from "../loop/dispatch.js";
import { prepareMission } from "../loop/prepare.js";
import { runLoop } from "../loop/run.js";
import { createFileStore } from "../loop/store.js";
import { createCriterionChecker, createVerifier } from "../loop/verify.js";
import { type Lease } from "../scheduler/leases.js";
import { createCliTransport } from "../workers/transport.js";
import { missionDir, type DiscoveredConfig } from "../config/discover.js";
import { type Io } from "./main.js";

const DEFAULT_BUDGET_MINUTES = 240;

export interface RunOptions {
  goal: string;
  planOnly: boolean;
  unattended: boolean;
  force: boolean;
  budgetMinutes: number;
}

export type ParsedRun = { ok: true; options: RunOptions } | { ok: false; message: string };

export function parseRunArgs(argv: readonly string[]): ParsedRun {
  const goals: string[] = [];
  const flags = new Set<string>();
  let budgetMinutes = DEFAULT_BUDGET_MINUTES;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--budget") {
      const minutes = Number(argv[++i]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { ok: false, message: "--budget takes a number of minutes, e.g. --budget 90." };
      }
      budgetMinutes = minutes;
      continue;
    }
    if (arg.startsWith("--")) {
      flags.add(arg);
      continue;
    }
    goals.push(arg);
  }

  const goal = goals.join(" ").trim();
  if (!goal) return { ok: false, message: 'Usage: orchestra run "<goal>" [--plan-only] [--budget <minutes>]' };

  const unknown = [...flags].find(
    (flag) => !["--plan-only", "--unattended", "--force"].includes(flag),
  );
  if (unknown) return { ok: false, message: `Unknown flag '${unknown}'.` };

  const unattended = flags.has("--unattended");
  // §7 couples the two deliberately: the easy path to skipping sign-off should be a
  // mission whose criteria a human already approved. `--saved` is Phase 5, so until
  // then the explicit `--force` is what stands in for that decision.
  if (unattended && !flags.has("--force")) {
    return {
      ok: false,
      message:
        "--unattended skips sign-off, so it needs --force (or, from Phase 5, --saved).\n" +
        "A first run of anything deserves a look at the plan.",
    };
  }

  return {
    ok: true,
    options: {
      goal,
      planOnly: flags.has("--plan-only"),
      unattended,
      force: flags.has("--force"),
      budgetMinutes,
    },
  };
}

/** Readable, sortable, and unique enough for one machine: the timestamp orders them
 *  and the slug is what a human recognises in `.orchestra/missions/`. */
export function newMissionId(goal: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "mission";
  return `${stamp}-${slug}`;
}

/** The envelope a terminal run declares. The compose screen (§13) is where a human
 *  sets this in Phase 3; until then it is the narrowest thing that can still do code
 *  work — the repo, no network, and no browser. */
export function defaultEnvelope(config: DiscoveredConfig, budget: Budget): Envelope {
  return {
    toolClasses: ["fs.read", "fs.write", "shell.run"],
    domains: [],
    fsRoots: [config.repoRoot ?? config.cwd],
    network: "none",
    maxSpend: budget,
    approval: "local",
  };
}

export interface RunDeps {
  createCalls(config: DiscoveredConfig): Calls;
  now?: () => Date;
}

export async function runMission(
  options: RunOptions,
  config: DiscoveredConfig,
  io: Io,
  deps: RunDeps,
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const missionId = newMissionId(options.goal, now());
  const dir = missionDir(config.stateDir, missionId);
  const budget: Budget = { wallMs: options.budgetMinutes * 60_000 };

  // Built before the mission exists: a machine that cannot reach a model should not
  // leave a mission directory behind that only ever held one event.
  const calls = deps.createCalls(config);

  const store = createFileStore(dir);
  store.emit({
    type: "mission_created",
    missionId,
    actor: "human",
    goal: options.goal,
    envelope: defaultEnvelope(config, budget),
    budget,
    unattended: options.unattended,
  });

  io.out(`${missionId}: ${options.goal}`);

  const prepared = await prepareMission({
    store,
    calls,
    planOnly: options.planOnly,
    unattended: options.unattended,
  });

  if (!prepared.ok) {
    io.err(prepared.reason);
    for (const rejection of prepared.rejected ?? []) {
      io.err(`  rejected: ${rejection.criterion} — ${rejection.reason}`);
    }
    return 1;
  }

  printPlan(prepared.criteria, prepared.plan, prepared.estimate, io);

  if (options.planOnly) {
    io.out("");
    io.out(`--plan-only: nothing dispatched. Resume with 'orchestra resume ${missionId}'.`);
    return 0;
  }

  const result = await runLoop(await loopDeps(store, calls, config));
  io.out("");
  io.out(`${missionId}: ${result.status} after ${result.rounds} rounds — ${result.reason}`);
  return result.status === "complete" ? 0 : 1;
}

async function loopDeps(
  store: ReturnType<typeof createFileStore>,
  calls: Calls,
  config: DiscoveredConfig,
) {
  const repo = config.repoRoot;
  const code = repo
    ? {
        repo,
        worktreeRoot: config.worktreeRoot,
        into: await currentBranch(repo),
        mergeQueue: createMergeQueue(repo),
      }
    : undefined;

  const transport = createCliTransport();
  const verify = createVerifier({ calls });

  return {
    store,
    calls,
    cwd: repo ?? config.cwd,
    checkCriterion: createCriterionChecker({ calls }),
    dispatch: (task: Task, state: MissionState): Promise<DispatchOutcome> =>
      dispatch(task, {
        emit: store.emit,
        transport,
        verify,
        held: heldLeases(state),
        ...(code ? { code } : {}),
        cwd: repo ?? config.cwd,
      }),
  };
}

const heldLeases = (state: MissionState): Lease[] =>
  Object.entries(state.leases).map(([taskId, owns]) => ({ taskId, owns }));

function printPlan(
  criteria: readonly { id: string; statement: string; check: { kind: string } }[],
  plan: readonly { id: string; goal: string; worker: string; dependsOn: string[] }[],
  estimate: Estimate,
  io: Io,
): void {
  io.out("");
  io.out("CRITERIA");
  for (const criterion of criteria) {
    io.out(`  ${criterion.id}  ${criterion.statement}`);
    io.out(`      check ▸ ${criterion.check.kind}`);
  }

  io.out("");
  io.out("PLAN");
  for (const task of plan) {
    const after = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : "";
    io.out(`  ${task.id}  [${task.worker}] ${task.goal}${after}`);
  }

  io.out("");
  // Measured and unmeasured are reported separately (§9.5): a single confident token
  // number that omits every CLI worker reads as a cheap mission.
  const cliTasks = plan.filter((task) => task.worker === "code").length;
  io.out(
    `ESTIMATE  ${estimate.taskCount} tasks · ~${Math.round(estimate.wallMs / 60_000)} min · ` +
      `${estimate.expectedGates} gates`,
  );
  io.out(
    `          ~${Math.round(estimate.tokens / 1000)}k tokens measured, ` +
      `${cliTasks} CLI runs unmeasured`,
  );
}

export const missionPath = (config: DiscoveredConfig, missionId: string): string =>
  path.join(config.stateDir, "missions", missionId);

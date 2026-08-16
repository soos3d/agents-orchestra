// What this *machine* can run, as opposed to what this *build* ships (§7, defect 21).
//
// `AVAILABLE_TRANSPORTS` answers the first question and nothing answers the second, and
// the difference is the whole of defect 21 one layer out. Synthesis is told which
// transports it may pick and a spec outside that list fails at validation rather than at
// dispatch — which is only worth anything if the list describes reality. Offering `acp`
// on a laptop with no `claude` and no `codex` on PATH reproduces the defect exactly: the
// planner staffs every task with a transport that cannot start, each one dies at
// dispatch, burns its typed retry, takes a replan with it, and the mission escalates at
// the reset cap having produced nothing.
//
// So the offer is computed from the discovered config, and computed here — a pure
// function over the probe results, so what a real mission offers a model is assertable
// with no PATH, no subprocess, and no model (the `agentCalls.ts` habit, applied before
// the fact rather than after).
//
// **`npx` is deliberately not a prerequisite in this calculation.** The ACP adapters are
// fetched by `npx` at dispatch (`acp/registry.ts`), so npx is a dependency in the literal
// sense — but it ships with Node, and `doctor` already fails a Node older than 20. A
// second check for it would report a state that cannot exist without the node line
// already being red. The *real* prerequisite is the underlying agent CLI: the adapter is
// a protocol shim over `claude` or `codex`, and it is those that have to be installed and
// authed. That is what is probed.
import { acpTargets } from "./acp/registry.js";
import { AVAILABLE_TRANSPORTS, CLI_TARGETS } from "./transport.js";

/** Everything the availability question needs: the agent CLIs found on PATH
 *  (`discoverConfig().agents`). Narrowed to this rather than taking a
 *  `DiscoveredConfig`, so `workers/` does not learn about `config/`. */
export interface ProbedAgents {
  readonly agents: readonly string[];
}

/**
 * The ACP targets this machine can actually launch: a target with a pinned adapter in
 * the registry *and* its underlying CLI on PATH.
 *
 * Both halves matter and they fail differently. A target the registry does not know has
 * no verified invocation and must not be guessed at; a target whose CLI is missing has a
 * command line that would spawn and then fail to authenticate.
 */
export function runnableAcpTargets(probe: ProbedAgents): string[] {
  const present = new Set(probe.agents);
  return acpTargets().filter((target) => present.has(target));
}

/**
 * The transports to offer synthesis on this machine, in the order `AVAILABLE_TRANSPORTS`
 * lists them so the error messages and the prompt read the same way twice.
 *
 * `cli` needs one of the coding CLIs; `acp` needs one whose adapter is pinned. On a
 * machine with neither this returns an empty list, and that is the honest answer —
 * `doctor` already fails the `workers` line for it, and a mission staffed against an
 * empty offer fails at validation with the reason named rather than at dispatch with a
 * spawn error.
 */
export function availableTransports(probe: ProbedAgents): string[] {
  // Not "any agent on PATH": `opencode` is probed like the others and has no `cli`
  // launcher, so a machine holding only it would otherwise be offered a `cli` transport
  // with no target behind it — defect 21 rebuilt out of the fix for defect 21.
  const hasCli = CLI_TARGETS.some((target) => probe.agents.includes(target));
  const hasAcp = runnableAcpTargets(probe).length > 0;

  return AVAILABLE_TRANSPORTS.filter((id) => {
    if (id === "cli") return hasCli;
    if (id === "acp") return hasAcp;
    // A transport with no probe of its own is offered whenever the build ships it —
    // `chrome-mcp` (Phase 8) will want a row here rather than a silent default.
    return true;
  });
}

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
import { type Envelope } from "../domain/envelope.js";
import { currentUser, type Containment } from "../runtime/contained.js";
import { acpTargets } from "./acp/registry.js";
import { buildWorkerEnv } from "./childEnv.js";
import { AVAILABLE_TRANSPORTS, CLI_TARGETS } from "./transport.js";

/** Everything the availability question needs: the agent CLIs found on PATH
 *  (`discoverConfig().agents`). Narrowed to this rather than taking a
 *  `DiscoveredConfig`, so `workers/` does not learn about `config/`. */
export interface ProbedAgents {
  readonly agents: readonly string[];
  /** Container backends whose daemon answered (`discoverConfig().containers`). Absent
   *  is a config built before containment existed, and reads as none. */
  readonly containers?: readonly string[];
  /** `ORCHESTRA_CONTAINER_IMAGE`, when set. There is no default and there must not be:
   *  an image has to hold the agent CLI, logged in, and none has ever been verified for
   *  this project (`runtime/contained.ts`). */
  readonly containerImage?: string;
}

/**
 * What the *backend CLI* needs to reach its own daemon — not the worker, and not the
 * container.
 *
 * Beside the launch, like `CLAUDE_TRANSPORT_VARS`, and for a sharper reason than
 * symmetry: the client's socket address is how this machine is administered, and a
 * worker that learned it by being sandboxed could ask the daemon for a second container
 * without one. It goes to the client only, never through `--env`.
 */
export const CONTAINER_CLIENT_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  // Podman's equivalents, and where a rootless one keeps its socket.
  "CONTAINER_HOST",
  "CONTAINERS_CONF",
  "XDG_RUNTIME_DIR",
];

/**
 * The container backends this machine can actually start work in, which needs *both*
 * halves: a daemon answering and an image to run.
 *
 * Empty means containment is unavailable, and unlike `models` that is not "unknown" —
 * a backend is running or it is not. A mission whose envelope demands containment is
 * refused at validation against this list rather than discovering it at dispatch
 * (`UnavailableContainmentError`, defect 21's shape one layer down).
 */
export function availableContainment(probe: ProbedAgents): string[] {
  return probe.containerImage ? [...(probe.containers ?? [])] : [];
}

/**
 * The specialist scanners this mission may actually name in its outcome spec
 * (PLAN-NEXT 6.3) — what the envelope granted, narrowed to what this machine answered
 * for.
 *
 * Both halves, and neither alone. The grant without the probe staffs a criterion against
 * a binary that is not there, which is defect 21 in the checking layer instead of the
 * dispatch one; the probe without the grant runs an AI agent with shell access over the
 * repository because it happened to be installed, and deepsec's own documentation puts a
 * large repository at hundreds of dollars. An empty answer refuses the variant at
 * `writeOutcomeSpec`, which is the earliest place a mission can be told.
 */
export function availableScanners(
  envelope: Pick<Envelope, "scanners">,
  probed: readonly string[] = [],
): string[] {
  return envelope.scanners.filter((scanner) => probed.includes(scanner));
}

/**
 * How a worker on this mission is contained, or `undefined` for the missions that are
 * not — which is every mission whose envelope says `"none"`.
 *
 * Built at the composition root from the folded envelope, never from a spec: a task
 * cannot choose to be let out (`inspectContainment`), and computing it per task would be
 * one more place for the two answers to disagree.
 */
export function containmentFor(
  envelope: Pick<Envelope, "containment">,
  probe: ProbedAgents,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Containment | undefined {
  if (envelope.containment !== "container") return undefined;

  const backend = availableContainment(probe)[0];
  if (backend === undefined || probe.containerImage === undefined) {
    // Throwing rather than returning `undefined`, and this is the whole reason the
    // function is shaped this way: `undefined` means "not contained", so a machine that
    // cannot contain would silently run the mission on itself — the envelope's one hard
    // promise broken, with nothing in the log saying so. Synthesis refuses this mission
    // long before here; what reaches this line is a mission staffed on a machine that
    // could contain and resumed on one that cannot.
    throw new Error(
      `This mission's envelope requires every worker to run inside a container, and ` +
        `this machine cannot start one ` +
        `(${probe.containers?.length ? "no ORCHESTRA_CONTAINER_IMAGE set" : "no container backend answering"}). ` +
        `Run 'orchestra doctor', fix the line it names, and resume — refusing to run is ` +
        `the only alternative to running this mission uncontained.`,
    );
  }

  const user = currentUser();
  return {
    backend,
    image: probe.containerImage,
    ...(user ? { user } : {}),
    clientVars: buildWorkerEnv({ parent: parentEnv, transportVars: CONTAINER_CLIENT_VARS }),
  };
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

  return AVAILABLE_TRANSPORTS.filter((id) =>
    id === "cli" ? hasCli : id === "acp" ? hasAcp : false,
  );
}

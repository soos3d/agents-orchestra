// Running a worker inside a disposable container, without the layer above knowing.
//
// `sh.ts` spawns a command in a directory with a constructed environment, and that is
// the whole of a worker's isolation today: the CLI holds `--dangerously-skip-permissions`
// or an ACP grant, and everything else on the machine — the operator's ssh keys, an
// unrelated project's checkout, the open internet — is one `Bash` call away. The envelope
// bounds what a worker may *ask for*; nothing bounded what it could *reach*.
//
// This is the third runtime beside `sh.ts` and `duplex.ts`, and it is deliberately a
// *wrapper* rather than a second spawner: it rewrites `(cmd, args)` into the backend's
// argv and hands the result to `run()`. One spawn implementation keeps the ring buffer,
// the SIGTERM→SIGKILL escalation and the abort plumbing in one place, and means a
// contained worker times out the same way an uncontained one does.
//
// Three rules are load-bearing and none is guessable from "run it in Docker":
//
//   - **The mount path is the same inside and out.** `-v /w/task-3:/w/task-3`, never a
//     tidy `/workspace`. Every path the orchestrator already holds — the worktree it
//     will `git status`, the `artifactDir` it wrote into the worker's prompt, the
//     `owns` globs it checks afterwards — is a host path, and remapping it would make
//     `detectEscape` and `repoEscape` compare two different trees while both looked
//     right. Identity is what makes containment invisible above this file.
//   - **Values never reach the argv.** `--env NAME` (no `=`) tells the backend to copy
//     the value from *its own* environment, so the backend CLI is spawned with the
//     worker's constructed environment and the container receives exactly those names.
//     `--env NAME=VALUE` would put `ANTHROPIC_API_KEY` into `ps` output on a shared
//     machine, which is a worse leak than the one containment is here to close.
//   - **A file written in the container must be owned by the operator.** On Linux a
//     root-in-container process leaves root-owned files in the mounted worktree, and
//     then `git` cannot stage them and `removeWorktree` cannot delete them — a merge
//     that fails on permissions after the work was done correctly. `--user uid:gid` is
//     passed whenever the platform has one.
//
// Network is deny-by-default (`--network none`) with one opt-in: the name of a network
// the operator created themselves. Docker has no per-host allowlist to express "the npm
// registry and nothing else", so the honest primitive is a named network the operator
// scoped, not a domain list this file would pretend to enforce.
import { run, type RunOptions, type RunResult } from "./sh.js";

/** The backends this runtime knows how to drive. Both take the same flags for
 *  everything used here, which is why one argv builder serves both — and why a third
 *  backend needs a capture rather than an entry. */
export const CONTAINER_BACKENDS: readonly string[] = ["docker", "podman"];

export interface Containment {
  /** `docker` or `podman`, as probed. Not validated here: `availability.ts` narrows to
   *  what this machine answered for, and a name that reaches this far is a wiring bug
   *  that should fail loudly at spawn with `ProcessStartError`. */
  readonly backend: string;
  /**
   * The image to run the worker in.
   *
   * There is no default and there must not be: an image has to contain the agent CLI,
   * logged in, and no such image has been verified for this project. Inventing a name
   * here would be a menu entry nobody probed — the `MODELS_BY_VENDOR.openai` discipline
   * one subsystem over. It comes from `ORCHESTRA_CONTAINER_IMAGE`.
   */
  readonly image: string;
  /** A network the operator created and scoped. Absent means `--network none`, which is
   *  the default and the point. */
  readonly network?: string;
  /** `uid:gid` for the container process. Absent on platforms with no such thing. */
  readonly user?: string;
  /** What the *backend CLI* needs to find its daemon — `DOCKER_HOST`, `CONTAINER_HOST`.
   *  Beside the launch, like `CLAUDE_TRANSPORT_VARS`, and deliberately separate from the
   *  worker's own environment: the client's socket address is not the container's
   *  business, and a worker must not learn it by being contained. */
  readonly clientVars?: NodeJS.ProcessEnv;
}

export interface ContainedRun {
  /** The worker's working directory, mounted read-write at the same path inside. */
  readonly cwd: string;
  /**
   * Every other directory this launch needs mounted, at the same paths.
   *
   * The artifact directory (P2) is the usual one. `runCodex` adds a second, and the
   * reason is worth naming because it is the shape of bug containment invites: that
   * transport reads its result back out of a `--output-last-message` file, and a file
   * written inside a container to a path nobody mounted is simply gone — the scrape
   * would fall through to stdout and every contained codex worker would quietly deliver
   * a worse answer than an uncontained one. A list rather than one named field so the
   * launch that needs a directory is the thing that asks for it.
   *
   * Nothing else is mounted: not `$HOME`, not the repo the worktree came from.
   */
  readonly mounts?: readonly string[];
}

/**
 * A bind mount whose source and destination are the same path.
 *
 * `--mount` rather than `-v` on purpose: `-v` is colon-delimited, so a directory whose
 * name contains a colon silently becomes three fields and mounts something else. This is
 * the "every scanner has to know what it is inside of" trap in argv form, and the
 * defence is the same one `parseCommand` learned — refuse the input that cannot be
 * expressed, loudly, instead of encoding it wrong. `--mount` is comma-delimited and
 * `key=value`, so a comma or an `=` in the path is the case to refuse.
 */
export function bindMount(dir: string): string {
  if (/[,=]/.test(dir)) {
    throw new Error(
      `Cannot mount '${dir}' into a container: a ',' or '=' in the path cannot be ` +
        `expressed in a --mount argument. Move the worktree root somewhere without ` +
        `them (WORKTREE_ROOT), or run this mission with containment 'none'.`,
    );
  }
  return `type=bind,src=${dir},dst=${dir}`;
}

/**
 * The exact command line, so the flags are assertable without a daemon.
 *
 * Pure for the reason `codexArgs` is pure: the suite cannot see below the spawn, and
 * every argument that decides whether a worker is actually contained — the network, the
 * mounts, the user — is decided here.
 */
export function containerArgv(
  containment: Containment,
  where: ContainedRun,
  envNames: readonly string[],
  cmd: string,
  args: readonly string[],
): string[] {
  const mounts = [...new Set([where.cwd, ...(where.mounts ?? [])])];

  return [
    "run",
    // Disposable: the container is the task's, and it goes when the task does.
    "--rm",
    // The worker is fed its prompt on stdin by `run()`; without this the child sees a
    // closed stdin and a CLI that reads one hangs or exits empty.
    "-i",
    // Deny by default. A named network is the operator's own decision, made once, on a
    // network they scoped — never a domain list this file would claim to enforce.
    "--network",
    containment.network ?? "none",
    // An image that is not already local would otherwise be fetched over the network at
    // dispatch, by the one feature whose whole purpose is that the worker has none.
    "--pull=never",
    ...(containment.user ? ["--user", containment.user] : []),
    ...mounts.flatMap((dir) => ["--mount", bindMount(dir)]),
    "--workdir",
    where.cwd,
    // Names only — the values ride in the backend CLI's own environment. See the header.
    ...envNames.flatMap((name) => ["--env", name]),
    // `--entrypoint` rather than trusting the image to have none. An image with its own
    // `ENTRYPOINT` — which is most of them — treats everything after the image name as
    // *arguments to that entrypoint*, so `image claude -p …` runs the image's own
    // program and hands it `claude` as an argument. It does not fail cleanly: whatever
    // the image was built to run starts, does something unrelated, and the worker's
    // report is that program's output. This makes the command the command.
    "--entrypoint",
    cmd,
    containment.image,
    ...args,
  ];
}

/**
 * `uid:gid` for this process, or undefined where the platform has no such notion.
 *
 * Impure and therefore separate from `containerArgv`, which a test has to be able to
 * pin without knowing who is running it.
 */
export function currentUser(): string | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
}

/**
 * The command to actually spawn, for either spawner.
 *
 * `sh.ts` and `duplex.ts` take the same three things — a command, its arguments and an
 * environment — so containment is one rewrite of that triple and both runtimes get it
 * from here. Written as a function returning the triple rather than as two wrappers
 * because the alternative is what this codebase keeps paying for: a second copy of a
 * rule, correct on the day it was written, that stops matching the first one the moment
 * either is corrected. A `cli` worker contained and an `acp` worker not is not a smaller
 * feature, it is a sandbox with a door in it.
 */
export interface ContainedCommand {
  readonly cmd: string;
  readonly args: string[];
  /** The backend CLI's environment: the worker's values, for `--env NAME` to copy, plus
   *  what the client needs to reach its daemon. Never the parent's. */
  readonly env: NodeJS.ProcessEnv;
}

export function containedCommand(
  containment: Containment,
  where: ContainedRun,
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ContainedCommand {
  return {
    cmd: containment.backend,
    args: containerArgv(containment, where, Object.keys(env), cmd, args),
    env: { ...env, ...(containment.clientVars ?? {}) },
  };
}

/**
 * Same contract as `run()`: a command, its arguments, and the options a worker runs
 * under — with the container between them.
 *
 * `opts.env` keeps the meaning it has everywhere else (defect 42): the child's *entire*
 * environment, constructed by `buildWorkerEnv`, never an overlay. Here it is handed to
 * the backend CLI so that `--env NAME` can copy each value across, and the container is
 * given exactly those names. Omitting it contains a worker with no environment at all,
 * which is the honest reading of "nothing was granted" — and never the parent's, since
 * inheriting `process.env` into a sandbox would undo the point of both features.
 */
export function runContained(
  containment: Containment,
  where: ContainedRun,
  cmd: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const launch = containedCommand(containment, where, cmd, args, opts.env ?? {});
  // `cwd` is the container's, not the backend CLI's — the CLI is a client and runs
  // wherever the orchestrator is. Passing the worktree through would make a deleted
  // worktree a spawn failure of the client rather than a failure of the worker.
  const { cwd: _clientCwd, ...clientOpts } = opts;

  return run(launch.cmd, launch.args, { ...clientOpts, env: launch.env });
}

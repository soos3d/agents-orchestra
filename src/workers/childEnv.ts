// What a worker's process is allowed to see of the machine it runs on (defect 42).
//
// Both spawn paths used to compose the child environment as `{ ...process.env,
// ...opts.env }`, which meant every worker — including a `research` task holding
// nothing but `Read` — started with every variable the orchestrator was started with:
// the operator's cloud credentials, an unrelated app's database URL, whatever a shell
// profile exports. The envelope bounded what a worker could *do* and said nothing
// about what it could *read*, so nothing was scoping any of it.
//
// The fix is construction rather than filtration, and the distinction is the whole
// point. A filter is a deny-list wearing an allow-list's clothes: it starts from
// everything and is correct only while nobody adds a variable it forgot. This builds
// an empty record and copies in exactly two sets of names — what the transport needs
// to start at all, and what this task's envelope granted it — so a variable nobody
// named is absent because it was never there, not because a rule caught it.
//
// Two smaller rules, both learned from `acp/registry.ts`'s `CLAUDECODE` strip:
//
//   - An allowed name the parent does not have stays *absent*. Inventing `""` for it
//     is worse than missing: a CLI that checks `if (VAR)` behaves the same either way,
//     and one that checks `if ("VAR" in env)` takes the wrong branch with no error.
//   - `undefined` values in the parent are holes, not entries. `child_process` uses a
//     present-and-`undefined` key to mean "remove this", and copying one across would
//     carry that meaning into an environment that has nothing to remove it from.

/**
 * The variables any child process needs to be a working process on this machine,
 * regardless of what it then does.
 *
 * Deliberately generous, because the failure mode on the narrow side is silent and
 * expensive: a worker that cannot resolve `npx`, cannot find its own config under
 * `$HOME`, or cannot reach the network through the corporate proxy fails as a broken
 * task rather than as a missing variable. Nothing here is a secret of the mission's —
 * these are the shape of the machine, and a worker learns all of it from `uname` and a
 * directory listing anyway.
 *
 * Per-transport credentials are *not* here. They live beside the launch that needs
 * them (`claudeCode.ts`, `codex.ts`, `acp/registry.ts`), so adding an adapter cannot
 * quietly widen what every other worker sees.
 */
export const PROCESS_BASELINE_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // Corporate networks. Absent from a laptop and load-bearing on a work machine, which
  // is exactly the kind of variable a narrow baseline breaks someone else's setup on.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Where a unix tool looks for its own config and cache when it is not `$HOME`.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // Windows' equivalents of PATH-and-HOME. The shipped binary runs there too, and a
  // child with no `SystemRoot` does not start at all.
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "windir",
];

export interface WorkerEnvInput {
  /** The environment this process was started with — `process.env` in production,
   *  a literal in a test. Injected rather than read here so what a worker receives is
   *  assertable without spawning anything. */
  readonly parent: NodeJS.ProcessEnv;
  /** Variable names the transport needs to start and authenticate. Beside the launch. */
  readonly transportVars?: readonly string[];
  /** Variable names this task's envelope granted it (`AgentSpec.env`, already checked
   *  against `Envelope.env` at synthesis). */
  readonly allowed?: readonly string[];
  /** Values this launch sets outright rather than passing through, applied last. */
  readonly literals?: Readonly<Record<string, string>>;
}

/**
 * The child's entire environment, built from nothing.
 *
 * Returns a fresh record every call and never mutates `parent`: the result is handed
 * straight to `spawn`, and a shared object one worker could edit is a second worker's
 * environment changing under it.
 */
export function buildWorkerEnv(input: WorkerEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const name of [...(input.transportVars ?? []), ...(input.allowed ?? [])]) {
    const value = input.parent[name];
    // Absent stays absent — see the header. `undefined` in the parent is a hole.
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(input.literals ?? {})) {
    env[name] = value;
  }

  return env;
}

// Keeping a granted credential out of the log and out of the artifacts (PLAN-NEXT 7.3).
//
// `Envelope.env` grants a worker a variable by name and `buildWorkerEnv` puts the value
// in its environment (defect 42). From there the value is one `echo` away from the
// worker's own report, and a report becomes a `worker_report` event, a summary in a
// failure message, and a `check.txt` beside the work — three files a human pastes into a
// bug report. The value is a string this process already holds at dispatch, so scrubbing
// it is a substring replacement and not a search for what a secret looks like.
//
// **Exact-value match only, and that is the whole design.** Every scanner over model
// output in this codebase that tried to be clever got it wrong on correct work — a `=>`
// inside a quoted string read as a redirect (34), a fence inside a JSON string (38), a
// UTF-8 sequence split across a chunk (37), a backslash inside double quotes (44). A
// regex for "looks like an API key" is that mistake with a worse failure mode: it
// silently rewrites a worker's correct output, and the mission then fails a criterion
// while quoting mangled evidence. So nothing here matches a shape. If the value is not
// in the text byte for byte, the text is returned unchanged — identity, not a rewrite.
//
// Best-effort, like the `keepEvidence` path it sits on: it is a second line behind the
// envelope, which is what actually decides whether a worker ever sees a value at all.

/** A granted variable and the value this machine holds for it. The name travels with
 *  the value so the replacement can say which variable was cut — the name is already in
 *  `Envelope.env` and on the log, so naming it leaks nothing and saves the next reader
 *  wondering what the marker used to be. */
export interface Secret {
  readonly name: string;
  readonly value: string;
}

/**
 * Below this, a value is left alone. A granted variable whose value is `1`, `true`, `y`
 * or a two-letter locale is not a credential, and replacing every occurrence of `1` in a
 * worker's report would destroy the evidence this function exists to keep readable.
 *
 * Chosen rather than derived: no credential worth protecting is seven characters, and a
 * threshold is the one place where "do not mangle correct output" and "never leak" pull
 * against each other. `LOG_LEVEL=debug` is the case that proves it — granted, five
 * characters, and a word that appears in half the reports a worker writes.
 */
export const MIN_REDACTED_LENGTH = 8;

/**
 * The granted variables this machine actually has a value for.
 *
 * `parent` is injected rather than read here for `buildWorkerEnv`'s reason: what a
 * worker is given has to be assertable without spawning anything, and so does what is
 * scrubbed out of what it says. A name the machine does not hold contributes nothing —
 * there is no value to find in the text.
 */
export function grantedSecrets(
  parent: NodeJS.ProcessEnv,
  names: readonly string[],
): Secret[] {
  const secrets: Secret[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const value = parent[name];
    if (value === undefined || value.length < MIN_REDACTED_LENGTH) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    secrets.push({ name, value });
  }

  return secrets;
}

/**
 * The same environment with every granted variable removed.
 *
 * For a child this process starts on its *own* behalf rather than a worker's — the
 * scanner is the only one today. `buildWorkerEnv` constructs a worker's environment from
 * an allowlist and that is the right rule for a worker, but a scanner drives its own
 * coding agent and needs the operator's whole environment to find its credentials and its
 * config, so a list of names for it would be a list nobody can write correctly and a
 * scanner that silently cannot start. Withholding is what is decidable here: the mission's
 * granted values are exactly the strings this process knows are secret, and a security
 * scan has no business reading the key it is looking for.
 *
 * A filter, not a construct, and it is weaker on purpose — the operator's own credentials
 * still reach the scanner, because they are what it runs on.
 */
export function withoutSecrets(
  parent: NodeJS.ProcessEnv,
  secrets: readonly Secret[],
): NodeJS.ProcessEnv {
  if (secrets.length === 0) return parent;

  const withheld = new Set(secrets.map((secret) => secret.name));
  return Object.fromEntries(
    Object.entries(parent).filter(([name]) => !withheld.has(name)),
  ) as NodeJS.ProcessEnv;
}

/**
 * Replace every exact occurrence of each value with a marker naming its variable.
 *
 * `split`/`join` rather than `String.replace`, and it is not a style choice twice over:
 * a value containing `.` or `?` would be a pattern rather than a string if this took a
 * regex, and a value containing `$&` would be re-inserted by `replace`'s own
 * substitution syntax — which would leak exactly the value being removed.
 *
 * Longest first, so a value that contains another (an account id inside a token) does
 * not leave the shorter one's marker embedded in the longer one's remains.
 */
export function redact(text: string, secrets: readonly Secret[]): string {
  if (secrets.length === 0) return text;

  const ordered = [...secrets].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const secret of ordered) {
    if (!out.includes(secret.value)) continue;
    out = out.split(secret.value).join(`[redacted:${secret.name}]`);
  }
  return out;
}

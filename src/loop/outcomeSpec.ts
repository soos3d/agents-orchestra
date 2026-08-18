// The single most important validation in the system (§4).
//
// A criterion the runtime cannot evaluate means the progress ledger can never
// legitimately set `isRequestSatisfied`, so the mission runs to its reset cap having
// done everything right. Every internal check reports success; nothing reports the
// contract was unverifiable.
//
// "Vague" is not a property code can read off a sentence. What it can read is whether
// the criterion carries a check that will ever produce an answer, and that is the
// operational definition used here: no check, a malformed one, or `kind: 'none'`.
import { needsShell, parseCommand, type ParsedCommand } from "../runtime/command.js";
import { criterionSchema, type Criterion } from "../domain/ledger.js";

const CONSOLE_LOG = "console.log(";
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const INLINE_FLAGS = ["--eval=", "--print="];
/** Anything that can leave the process with a non-zero status, however indirectly. */
const CAN_EXIT_NON_ZERO = /process\s*\.\s*(exit|exitCode|abort)|\bthrow\b|\bassert\b/;
/** A printed verdict, bare or quoted. `falsey` is not one — the word boundaries matter. */
const VERDICT_LITERAL = /\b(true|false)\b/i;

export interface SpecRejection {
  /** The criterion as proposed, quoted so the retry knows which one to fix. */
  criterion: string;
  reason: string;
}

export type SpecResult =
  | { ok: true; criteria: Criterion[] }
  | { ok: false; rejected: SpecRejection[] };

/**
 * Proposals arrive from a model, so the input is whatever it returned.
 *
 * `scanners` is the specialist gates this mission may name (PLAN-NEXT 6.3): the
 * intersection of what its envelope granted and what this machine answered for, computed
 * at the composition root. Empty is the default and every mission before 6.3, so a
 * `scanner` check is refused here unless somebody granted it — which is what makes "opt-in
 * per mission, never default" a property of the code rather than of a prompt. Refused
 * *here* and not silently skipped for the reason `kind: "none"` is refused here: a check
 * that does not run is a criterion the mission can never legitimately report as met, and
 * skipping it would report one it never looked at as clean.
 */
export function writeOutcomeSpec(
  proposed: readonly unknown[],
  scanners: readonly string[] = [],
): SpecResult {
  if (proposed.length === 0) {
    return {
      ok: false,
      rejected: [
        {
          criterion: "(empty)",
          reason:
            "An outcome spec with no criteria has nothing to verify, so the mission could " +
            "never finish. State at least one criterion with a check.",
        },
      ],
    };
  }

  const criteria: Criterion[] = [];
  const rejected: SpecRejection[] = [];
  const seen = new Set<string>();

  for (const candidate of proposed) {
    const parsed = criterionSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      rejected.push({
        criterion: describe(candidate),
        reason:
          `${issue?.path.join(".") || "(root)"} ${issue?.message}. Every criterion needs an id, ` +
          `a statement, and a check that says how we will know.`,
      });
      continue;
    }

    const criterion = parsed.data;
    if (criterion.check.kind === "none") {
      rejected.push({
        criterion: criterion.statement,
        reason:
          `Its check is 'none', so it can never be evaluated and the mission could never ` +
          `legitimately report success. Give it a command to run or a rubric to judge.`,
      });
      continue;
    }

    // The same question as `kind: 'none'`, one field deeper. `runtime/command.ts` is a
    // tokenizer and not a shell, so `runCommand` refuses a check carrying `&&`, a pipe or
    // a redirect *when it fires* — after sign-off has frozen it into the contract, with the
    // work done and correct. A live mission wrote `test -f index.html && grep -q '<script'`
    // twice with the authoring prompt already forbidding it, so the prompt is not the
    // enforcement. Refusing it here turns a criterion that could never be met into a
    // send-back the author can fix, which is what `inspect()` does for an invented model.
    //
    // `needsShell` and not a regex over the string: it walks the same quote and escape
    // states the parser does, so `grep -q 'a && b' file` stays an argument. A regex here
    // would be defect 34 in the validator, failing correct work.
    if (criterion.check.kind === "command" && needsShell(criterion.check.command)) {
      rejected.push({
        criterion: criterion.statement,
        reason:
          `Its command needs a shell (\`${criterion.check.command}\`), and checks run as one ` +
          `program with arguments — no pipes, no '&&', no redirects, no '$()', no globs. It ` +
          `would be refused every time it ran, so the criterion could never be met however ` +
          `good the work was. Split it into one criterion per command, or use a judge rubric.`,
      });
      continue;
    }

    // The same question again, one layer past "will it run": will it ever say no. A real
    // mission recorded `criterion_checked` with `met: true` and `checkOutput: "exit 0\nfalse"` —
    // the check's own script printed `false`. The criteria had been authored as
    // `node -e "console.log(cond ? 'true' : 'false')"`, and `runCommand` grades on the exit
    // code and never reads the output, so four of that mission's six command criteria could
    // not fail. That is `kind: 'none'` wearing a command.
    //
    // This gate cannot execute the check, so the exit code is not knowable here. The shape
    // is: a `node -e`/`node -p` body that prints a true/false verdict and carries nothing
    // that could make the process leave with a non-zero status. Anything else is accepted,
    // deliberately — a false refusal fails correct work, which is defects 34, 37, 38 and 44,
    // four scanners over model output that every one of them got wrong in that direction.
    if (criterion.check.kind === "command" && printsItsVerdictInstead(criterion.check.command)) {
      rejected.push({
        criterion: criterion.statement,
        reason:
          `Its command prints its verdict instead of exiting on it ` +
          `(\`${criterion.check.command}\`). A check is graded on its exit code and its output ` +
          `is never read, so this one is recorded as met however the work turns out — a real ` +
          `mission logged 'exit 0' against a script that printed 'false'. Make the decision the ` +
          `exit status: end the body with \`process.exit(ok ? 0 : 1)\`, throw, or assert. Use a ` +
          `judge rubric if the answer is not a status.`,
      });
      continue;
    }

    if (criterion.check.kind === "scanner" && !scanners.includes(criterion.check.scanner)) {
      rejected.push({
        criterion: criterion.statement,
        reason:
          `Its check runs the '${criterion.check.scanner}' scanner, which this mission ` +
          `cannot use: ` +
          (scanners.length === 0
            ? `no scanner is available. A scan is granted per mission and costs real money ` +
              `per file, so nothing runs one unless the envelope names it and the binary is ` +
              `on PATH — check 'orchestra doctor'.`
            : `only ${scanners.join(", ")} ${scanners.length === 1 ? "is" : "are"} available.`) +
          ` Give the criterion a command to run or a rubric to judge instead.`,
      });
      continue;
    }

    if (seen.has(criterion.id)) {
      rejected.push({
        criterion: criterion.statement,
        reason: `Criterion id '${criterion.id}' is used twice. Give each one a distinct id.`,
      });
      continue;
    }

    seen.add(criterion.id);
    criteria.push(criterion);
  }

  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, criteria };
}

/**
 * Whether a `node -e`/`node -p` check decides in its output rather than in its exit status.
 *
 * Conservative on purpose, and the bar is *certainty*: this returns true only for a body
 * that prints a `true`/`false` verdict and contains no `process.exit`, no `process.exitCode`,
 * no `throw` and no `assert` — nothing that could produce a non-zero status. A body that
 * merely logs progress, one that asserts, one whose program is not `node`, and every command
 * this tokenizer cannot parse are all accepted, because refusing a correct check costs a
 * mission its criteria while quoting work that was right (defect 44).
 *
 * `parseCommand` does the shell-level quoting rather than a regex over the raw string, for
 * `needsShell`'s reason: the body arrives quoted, and a scanner that does not know what it is
 * inside of reads the check's own argument as syntax.
 */
function printsItsVerdictInstead(command: string): boolean {
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(command);
  } catch {
    // Unbalanced quotes. `runCommand` refuses it with the better message, and guessing at a
    // string the tokenizer could not read is how a scanner fails correct work.
    return false;
  }

  const evaluated = evaluatedBody(parsed);
  if (evaluated === undefined) return false;
  // Searched over the raw body, comments and string contents included: a match there is a
  // false *exemption*, which costs nothing, where a miss would be a false refusal.
  if (CAN_EXIT_NON_ZERO.test(evaluated.body)) return false;

  return evaluated.printed.some((expression) => VERDICT_LITERAL.test(expression));
}

/** `-p` prints its whole expression; `-e` prints whatever it hands `console.log`. */
function evaluatedBody(parsed: ParsedCommand): { body: string; printed: string[] } | undefined {
  if (parsed.cmd.split("/").pop() !== "node") return undefined;

  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i]!;
    const inline = INLINE_FLAGS.find((flag) => arg.startsWith(flag));
    const body = inline ? arg.slice(inline.length) : EVAL_FLAGS.has(arg) ? parsed.args[i + 1] : undefined;
    if (body === undefined) continue;

    const printsWholeBody = arg.startsWith("-p") || arg.startsWith("--print");
    return { body, printed: printsWholeBody ? [body] : loggedExpressions(body) };
  }
  return undefined;
}

/**
 * The arguments of every top-level `console.log(...)` in a JavaScript body.
 *
 * Quote-aware for the third time in this codebase and for the third time because of the
 * same bug: a `)` inside `console.log("a )")` closes nothing, and a `console.log` inside a
 * string is text. An unbalanced call returns what was found so far rather than a guess.
 */
function loggedExpressions(body: string): string[] {
  const found: string[] = [];
  let quote: string | undefined;

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (quote !== undefined) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (!body.startsWith(CONSOLE_LOG, i)) continue;

    const open = i + CONSOLE_LOG.length;
    const close = closingParen(body, open);
    if (close === undefined) return found;
    found.push(body.slice(open, close));
    i = close;
  }
  return found;
}

/** The index of the `)` closing a call whose `(` was just consumed, or undefined. */
function closingParen(body: string, from: number): number | undefined {
  let depth = 1;
  let quote: string | undefined;

  for (let i = from; i < body.length; i++) {
    const char = body[i]!;
    if (quote !== undefined) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i;
  }
  return undefined;
}

function describe(candidate: unknown): string {
  if (candidate && typeof candidate === "object" && "statement" in candidate) {
    return String((candidate as { statement: unknown }).statement);
  }
  return JSON.stringify(candidate) ?? String(candidate);
}

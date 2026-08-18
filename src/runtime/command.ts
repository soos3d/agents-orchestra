// Turning a `VerifySpec` command string into argv.
//
// The old code did `command.split(" ")`, which breaks on the first quoted argument —
// `npm test -- --grep "health endpoint"` became six arguments, three of them wrong,
// and the verification then failed for a reason that had nothing to do with the work.
//
// This is deliberately not a shell. There is no globbing, no substitution, no pipes:
// a verification command runs a program with arguments, and anything that needs a
// shell should say so by invoking one.
export interface ParsedCommand {
  cmd: string;
  args: string[];
}

const SHELL_METACHARACTERS = /[|&;<>$`(){}[\]]/;

/**
 * The characters a backslash may escape *inside double quotes*, and the whole of defect
 * 44 (2026-08-16).
 *
 * POSIX is specific here and the intuitive reading is wrong: within double quotes a
 * backslash is an ordinary character unless the next one is `$`, a backtick, `"`, `\`, or
 * a newline. Everywhere else it stays literal. This tokenizer treated it as a general
 * escape, so it silently *deleted* the backslash before every other character — and the
 * argument that reaches the program is then not the one the command said.
 *
 * It cost a real mission three criteria. A verification command carried the regex
 * `r'-?\d+\.?\d*'` inside a `python3 -c "…"` argument; what ran was `r'-?d+.?d*'`, which
 * matches nothing. The script under test was correct, printed `5.0`, and three criteria
 * came back `false` with an assertion error quoting its own correct output. Nothing
 * failed loudly, and the same command pasted into a shell passed.
 *
 * This is the trap the codebase already names twice — a scanner has to know what it is
 * inside of. `needsShell` read a `=>` inside a quoted string as a redirect (defect 34);
 * `extractJsonObject` stopped at a fence inside a JSON string (defect 38). Both failed on
 * correct work. This is the third, and it is the quietest of them.
 */
const ESCAPABLE_IN_DOUBLE_QUOTES = new Set(['"', "\\", "$", "`", "\n"]);

/**
 * Whether a backslash at this position escapes the character after it.
 *
 * Shared by both walkers below rather than written twice, because they are documented as
 * walking the same quote and escape states — and two copies of a rule this
 * counter-intuitive would drift the moment one of them was corrected.
 */
function escapesNext(quote: '"' | "'" | undefined, next: string | undefined): boolean {
  if (next === undefined) return false;
  // Single quotes are literal all the way through, backslashes included.
  if (quote === "'") return false;
  if (quote === '"') return ESCAPABLE_IN_DOUBLE_QUOTES.has(next);
  return true;
}

export function parseCommand(command: string): ParsedCommand {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      started = true;
      continue;
    }
    if (quote !== undefined && char === quote) {
      quote = undefined;
      continue;
    }
    // A backslash that escapes something consumes the next character; one that does not
    // falls through below and is kept, which is the half that was missing (defect 44).
    if (char === "\\" && escapesNext(quote, command[i + 1])) {
      current += command[++i];
      started = true;
      continue;
    }
    if (quote === undefined && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== undefined) {
    throw new SyntaxError(`Unbalanced ${quote} quote in command: ${command}`);
  }
  if (started) tokens.push(current);

  const [cmd, ...args] = tokens;
  if (!cmd) throw new SyntaxError(`Empty command: ${JSON.stringify(command)}`);

  return { cmd, args };
}

/**
 * Whether a command needs a shell to mean what it says. Callers use this to fail
 * with an actionable message rather than silently running `npm test | tee log` as a
 * program called `npm` with a literal `|` argument.
 *
 * Quote-aware, and that is defect 34: a raw regex over the whole string read the
 * `=>` inside `node -e "m => m.clamp"` as a redirect and refused a command that
 * runs fine as a program with arguments. Metacharacters only mean shell when they
 * appear outside quotes, so this walks the same quote/escape states parseCommand
 * does. An unbalanced quote returns true — parseCommand will refuse it with the
 * better message either way.
 */
export function needsShell(command: string): boolean {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== undefined && char === quote) {
      quote = undefined;
      continue;
    }
    if (char === "\\" && escapesNext(quote, command[i + 1])) {
      i++;
      continue;
    }
    if (quote === undefined && SHELL_METACHARACTERS.test(char)) return true;
  }
  return quote !== undefined;
}

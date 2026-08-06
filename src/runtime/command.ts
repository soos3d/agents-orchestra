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
    // Backslash escapes only outside single quotes, matching POSIX closely enough
    // that a copied command line behaves the way it looks.
    if (char === "\\" && quote !== "'" && i + 1 < command.length) {
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
 */
export function needsShell(command: string): boolean {
  return SHELL_METACHARACTERS.test(command);
}

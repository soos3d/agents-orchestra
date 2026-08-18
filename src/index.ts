#!/usr/bin/env node
import { main } from "./cli/main.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Failure messages carry the fix (§2a rule 5), so the message is what a human
    // reads — the stack only when they ask for it.
    process.stderr.write(`${(err as Error).message}\n`);
    if (process.env.ORCHESTRA_DEBUG) process.stderr.write(`${(err as Error).stack}\n`);
    process.exitCode = 1;
  });

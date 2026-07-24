// Tiny promise wrapper around child_process for running CLIs (git, claude, codex).
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Command timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(" ")}`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

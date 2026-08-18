// A throwaway git repo for tests. Worktrees, merge serialization, and base-sha
// pinning are only meaningfully testable against real git — a fake would encode the
// same assumptions the defects came from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../git/repo.js";

export interface TestRepo {
  path: string;
  worktreeRoot: string;
  write(file: string, contents: string): Promise<void>;
  commit(message: string): Promise<string>;
  writeAndCommit(file: string, contents: string, message?: string): Promise<string>;
  head(): Promise<string>;
  cleanup(): void;
}

export async function makeRepo(prefix = "orchestra-git-"): Promise<TestRepo> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);

  await git(repo, ["init", "-b", "main"]);
  // Local config only: a test must not depend on, or touch, the machine's git identity.
  await git(repo, ["config", "user.email", "test@fable.local"]);
  await git(repo, ["config", "user.name", "Fable Test"]);

  const api: TestRepo = {
    path: repo,
    worktreeRoot: path.join(root, "worktrees"),

    async write(file, contents) {
      const target = path.join(repo, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    },

    async commit(message) {
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-m", message]);
      return api.head();
    },

    async writeAndCommit(file, contents, message = `write ${file}`) {
      await api.write(file, contents);
      return api.commit(message);
    },

    head: () => git(repo, ["rev-parse", "HEAD"]),

    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };

  await api.writeAndCommit("README.md", "# test\n", "initial");
  return api;
}

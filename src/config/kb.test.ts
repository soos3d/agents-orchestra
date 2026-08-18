// The failure modes: a map of the wrong commit, a map that eats the prompt budget, and a
// cache whose absence costs a mission.
//
// The first is what the HEAD key exists for — an index built two commits ago describes
// files the architect will be told are there and are not. The second is `rosterIndex`'s
// lesson one menu along: research and architect pay for this on every mission. The third
// is the rule that makes the whole thing safe to delete: `<stateDir>/kb/` is a cache, so
// removing it, corrupting it, or running outside a repository has to degrade to the empty
// string rather than raise.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { makeRepo, type TestRepo } from "../testing/gitRepo.js";
import { KB_INDEX_BUDGET, ensureRepoKb, kbFile, readRepoKb, repoIndex } from "./kb.js";

const tmpDirs: string[] = [];
const repos: TestRepo[] = [];

const aStateDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-kb-"));
  tmpDirs.push(dir);
  return dir;
};

const aRepo = async (): Promise<TestRepo> => {
  const repo = await makeRepo("orchestra-kb-repo-");
  repos.push(repo);
  return repo;
};

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  while (repos.length > 0) repos.pop()!.cleanup();
});

describe("repoIndex", () => {
  test("groups tracked files by directory, biggest first", () => {
    const index = repoIndex("abc1234def", ["README.md", "src/a.ts", "src/b.ts", "docs/x.md"]);

    assert.match(index, /HEAD abc1234 — 4 tracked files/);
    assert.match(index, /- src\/ \(2 files\)/);
    assert.match(index, /- docs\/ \(1 file\)/);
    assert.match(index, /- \(repository root\) \(1 file\)/);
    assert.ok(index.indexOf("src/") < index.indexOf("docs/"), "the biggest directory leads");
  });

  // An empty answer means "no map" everywhere it is read, exactly as an empty roster
  // renders to nothing rather than to a menu with no rows.
  test("an empty repository renders to nothing at all", () => {
    assert.equal(repoIndex("abc1234", []), "");
  });

  test("quotes the opening of the top-level docs", () => {
    const index = repoIndex("abc1234", ["README.md"], [{ name: "README.md", text: "# orchestra\n" }]);

    assert.match(index, /### README\.md/);
    assert.match(index, /# orchestra/);
  });

  // Every research and architect call pays for this. A repository with a thousand
  // directories must cost the same as one with ten.
  test("stays inside the budget and says what it dropped", () => {
    const files = Array.from({ length: 2000 }, (_, i) => `pkg${i}/index.ts`);

    const index = repoIndex("abc1234", files, [
      { name: "README.md", text: "x".repeat(5000) },
      { name: "CLAUDE.md", text: "y".repeat(5000) },
    ]);

    assert.ok(
      index.length <= KB_INDEX_BUDGET,
      `the index is ${index.length} chars, past the ${KB_INDEX_BUDGET} budget`,
    );
    assert.match(index, /further directories omitted for length/);
  });
});

describe("ensureRepoKb", () => {
  test("builds an index and caches it under the state dir", async () => {
    const repo = await aRepo();
    await repo.writeAndCommit("src/loop/run.ts", "export const x = 1;\n");
    const stateDir = aStateDir();

    const index = await ensureRepoKb(stateDir, repo.path);

    assert.match(index, /- src\/loop\/ \(1 file\)/);
    assert.match(index, /### README\.md/);
    const cached = readRepoKb(stateDir);
    assert.equal(cached?.head, await repo.head());
    assert.equal(cached?.index, index);
    // The cache holds mission-adjacent text like everything else under `<stateDir>`.
    assert.equal(fs.statSync(kbFile(stateDir)).mode & 0o777, 0o600);
  });

  test("HEAD moving is what invalidates it", async () => {
    const repo = await aRepo();
    const stateDir = aStateDir();
    await ensureRepoKb(stateDir, repo.path);
    const first = readRepoKb(stateDir)!;

    await repo.writeAndCommit("src/added.ts", "export const y = 2;\n");
    const second = await ensureRepoKb(stateDir, repo.path);

    assert.notEqual(readRepoKb(stateDir)!.head, first.head);
    assert.match(second, /- src\/ \(1 file\)/);
  });

  // The other direction, or "invalidated by HEAD moving" is unpinned: a repository that
  // has not moved must not be re-walked, and the way to see that from outside is that a
  // file written without a commit does not appear.
  test("an unmoved HEAD is served from the cache", async () => {
    const repo = await aRepo();
    const stateDir = aStateDir();
    await ensureRepoKb(stateDir, repo.path);

    await repo.write("src/uncommitted.ts", "export const z = 3;\n");
    const again = await ensureRepoKb(stateDir, repo.path);

    assert.doesNotMatch(again, /src\//);
  });

  test("deleting the cache is safe — it rebuilds", async () => {
    const repo = await aRepo();
    const stateDir = aStateDir();
    const first = await ensureRepoKb(stateDir, repo.path);

    fs.rmSync(path.dirname(kbFile(stateDir)), { recursive: true, force: true });

    assert.equal(await ensureRepoKb(stateDir, repo.path), first);
  });

  test("a corrupt cache warns and rebuilds rather than raising", async () => {
    const repo = await aRepo();
    const stateDir = aStateDir();
    await ensureRepoKb(stateDir, repo.path);
    fs.writeFileSync(kbFile(stateDir), "{ not json");
    const warnings: string[] = [];

    const index = await ensureRepoKb(stateDir, repo.path, (message) => warnings.push(message));

    assert.match(index, /Repository map at HEAD/);
    assert.equal(warnings.length, 1);
  });

  // A research mission, a computer-use mission, and `orchestra doctor` outside a repo all
  // land here. None of them may fail over a map.
  test("no repo is no map, not an error", async () => {
    assert.equal(await ensureRepoKb(aStateDir()), "");
  });

  test("a repository with no commits is no map either", async () => {
    const stateDir = aStateDir();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-kb-empty-"));
    tmpDirs.push(bare);
    const { git } = await import("../git/repo.js");
    await git(bare, ["init", "-b", "main"]);

    assert.equal(await ensureRepoKb(stateDir, bare), "");
    assert.equal(fs.existsSync(kbFile(stateDir)), false);
  });
});

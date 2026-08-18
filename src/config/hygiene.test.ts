// §17. `.orchestra/` accumulates screenshots of logged-in sessions and worker
// reports quoting real records, in the clear, next to a git repo. The gitignore line
// is re-asserted every run precisely because the failure mode is somebody deleting it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { ensureGitignored, ensurePrivateDir, forgetMission } from "./hygiene.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-hygiene-"));
let repo: string;
let caseNo = 0;

beforeEach(() => {
  repo = path.join(tmpRoot, `case-${++caseNo}`);
  fs.mkdirSync(repo, { recursive: true });
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const gitignore = () => fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
const stateDir = () => path.join(repo, ".orchestra");

describe("ensureGitignored", () => {
  test("creates .gitignore when the repo has none", () => {
    const result = ensureGitignored(repo, stateDir());

    assert.equal(result.reason, "created");
    assert.match(gitignore(), /^\/\.orchestra\/$/m);
  });

  test("appends to an existing .gitignore without disturbing it", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\ndist\n");

    ensureGitignored(repo, stateDir());

    assert.match(gitignore(), /node_modules/);
    assert.match(gitignore(), /^\/\.orchestra\/$/m);
  });

  test("is idempotent — a second run changes nothing", () => {
    ensureGitignored(repo, stateDir());
    const first = gitignore();

    const second = ensureGitignored(repo, stateDir());

    assert.equal(second.reason, "already-present");
    assert.equal(gitignore(), first);
  });

  // The case the whole "every run, not at init" rule exists for.
  test("re-adds the entry after somebody deletes the line", () => {
    ensureGitignored(repo, stateDir());
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");

    const result = ensureGitignored(repo, stateDir());

    assert.equal(result.added, true);
    assert.match(gitignore(), /\.orchestra/);
  });

  test("recognises an entry written without slashes", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), ".orchestra\n");

    assert.equal(ensureGitignored(repo, stateDir()).reason, "already-present");
  });

  test("handles a .gitignore with no trailing newline", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "dist");

    ensureGitignored(repo, stateDir());

    assert.match(gitignore(), /^dist$/m);
    assert.match(gitignore(), /^\/\.orchestra\/$/m);
  });

  // State outside the repo needs no ignore line, which is the good case, not a gap.
  test("writes nothing when the state dir lives outside the repo", () => {
    const result = ensureGitignored(repo, path.join(tmpRoot, "elsewhere"));

    assert.equal(result.reason, "not-in-repo");
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
  });
});

describe("ensurePrivateDir", () => {
  test("creates the directory owner-only regardless of umask", () => {
    const dir = ensurePrivateDir(path.join(repo, ".orchestra", "missions", "m1"));

    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  test("tightens an existing directory that was created loosely", () => {
    const dir = path.join(repo, "loose");
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });

    ensurePrivateDir(dir);

    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
});

describe("forgetMission", () => {
  test("deletes everything a mission wrote", () => {
    const dir = ensurePrivateDir(path.join(stateDir(), "missions", "m1"));
    fs.writeFileSync(path.join(dir, "events.jsonl"), "{}\n");

    const result = forgetMission(stateDir(), "m1");

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(dir), false);
  });

  test("says so plainly when there is nothing stored", () => {
    assert.equal(forgetMission(stateDir(), "never-existed").removed, false);
  });

  // `orchestra forget ../../..` must not be a recursive delete of the user's disk.
  test("refuses a mission id that is really a path", () => {
    assert.throws(() => forgetMission(stateDir(), "../.."), /not a mission id/);
    assert.throws(() => forgetMission(stateDir(), "a/b"), /not a mission id/);
    assert.throws(() => forgetMission(stateDir(), ""), /not a mission id/);
  });
});

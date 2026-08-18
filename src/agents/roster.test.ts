// The failure mode: a roster that is wrong in a way nothing notices until a worker
// runs with a system prompt nobody wrote.
//
// Every test here is about a file somebody hand-edited or hand-added, because that is
// what a roster is — markdown on disk, shipped with the package and extended per
// machine. A malformed entry names its file; an unknown worker kind is refused rather
// than defaulted; a local entry shadows a bundled one by name so a machine can correct
// what shipped; and a description over budget fails loudly, because the index is the
// one thing every synthesize call pays for and it must not grow by accident.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  DESCRIPTION_BUDGET,
  loadRoster,
  parseRosterEntry,
  rosterDir,
} from "./roster.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-roster-"));
let dir: string;
let caseNo = 0;

beforeEach(() => {
  dir = path.join(tmpRoot, `case-${++caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const entry = (over: Record<string, string> = {}): string => {
  const meta = {
    name: "code-reviewer",
    description: "Reviews a diff for correctness, security, and maintainability.",
    worker: "review",
    suggests: "fs.read",
    ...over,
  };
  return [
    "---",
    ...Object.entries(meta)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    "You are a code reviewer. Read the diff and report what is wrong.",
    "",
  ].join("\n");
};

describe("parseRosterEntry", () => {
  test("reads the frontmatter and keeps the body verbatim", () => {
    const result = parseRosterEntry(entry());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.entry.name, "code-reviewer");
    assert.equal(result.entry.worker, "review");
    assert.deepEqual(result.entry.suggests, ["fs.read"]);
    assert.match(result.entry.body, /^You are a code reviewer\./);
    // The body is what a worker is told, so a stray frontmatter line leaking into it
    // would ship `worker: review` to the model as if it were an instruction.
    assert.ok(!result.entry.body.includes("worker:"));
  });

  test("splits `suggests` on commas so a class list is one line", () => {
    const result = parseRosterEntry(entry({ suggests: "fs.read, fs.write, shell.run" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entry.suggests, ["fs.read", "fs.write", "shell.run"]);
  });

  test("a worker kind the system does not have is refused, not defaulted", () => {
    const result = parseRosterEntry(entry({ worker: "marketer" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problem, /worker/);
  });

  test("a description over budget is refused, because the index is paid for per call", () => {
    const result = parseRosterEntry(entry({ description: "x".repeat(DESCRIPTION_BUDGET + 1) }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problem, new RegExp(String(DESCRIPTION_BUDGET)));
  });

  test("an entry with no body is refused — there is nothing for a worker to be told", () => {
    const result = parseRosterEntry(`---\nname: a\ndescription: b\nworker: code\n---\n\n   \n`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problem, /body/i);
  });

  test("a file with no frontmatter names the fix rather than failing obscurely", () => {
    const result = parseRosterEntry("# Just a heading\n\nsome prose\n");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problem, /---/);
  });
});

describe("loadRoster", () => {
  test("reads every .md file in name order", () => {
    fs.writeFileSync(path.join(dir, "b.md"), entry({ name: "b-agent" }));
    fs.writeFileSync(path.join(dir, "a.md"), entry({ name: "a-agent" }));
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");

    const loaded = loadRoster([dir]);
    assert.deepEqual(
      loaded.map((one) => one.name),
      ["a-agent", "b-agent"],
    );
  });

  test("a later directory shadows an earlier one by name", () => {
    const bundled = path.join(dir, "bundled");
    const local = path.join(dir, "local");
    fs.mkdirSync(bundled);
    fs.mkdirSync(local);
    fs.writeFileSync(path.join(bundled, "r.md"), entry({ description: "the shipped one" }));
    fs.writeFileSync(path.join(local, "r.md"), entry({ description: "the corrected one" }));

    const loaded = loadRoster([bundled, local]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.description, "the corrected one");
  });

  test("an unparseable entry is skipped with a warning naming its file", () => {
    fs.writeFileSync(path.join(dir, "good.md"), entry({ name: "good" }));
    fs.writeFileSync(path.join(dir, "broken.md"), "no frontmatter here");

    const warnings: string[] = [];
    const loaded = loadRoster([dir], (message) => warnings.push(message));

    assert.deepEqual(
      loaded.map((one) => one.name),
      ["good"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /broken\.md/);
  });

  test("a missing directory is an empty roster rather than an error", () => {
    assert.deepEqual(loadRoster([path.join(dir, "nope")]), []);
  });
});

describe("rosterDir", () => {
  test("resolves the shipped roster to a directory that exists", () => {
    // The bundled roster ships with the package, so unlike a user directory an
    // absent one is a packaging bug and must not read as "no roster".
    assert.equal(fs.existsSync(rosterDir()), true);
  });
});

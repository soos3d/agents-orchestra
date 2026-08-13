// The run receipt: a real mission's `events.jsonl`, committed, folded, and asserted.
//
// Every other test in this suite builds its own log, which proves the reducer against
// logs the reducer's author imagined. This one is the opposite — a log a real mission
// wrote against a real model, kept exactly as it was written. It answers a question
// nothing else here can: does `fold` still produce the same mission from a log this
// version of the code did not write?
//
// It is also the honest version of a demo. A screenshot of a green run proves nothing
// a reader can check; a log they can fold themselves does. No hash chain and no
// signature — the file is in git, and git is the tamper-evidence.
//
// The mission: "survey this repository's JavaScript conventions and write a short
// conventions report", run unattended against a scratch repo on 2026-08-13. It is the
// run that proved P2's artifact directory and defect 41's repo-escape check. One
// substitution was made before committing — the scratch directory's absolute path,
// which is about the laptop and not about the mission.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { fold } from "../../events/fold.js";
import { createEventLog } from "../../events/log.js";

const receipt = path.join(path.dirname(fileURLToPath(import.meta.url)), "survey-conventions.jsonl");

// Read through the real log rather than by parsing the file here, so the receipt is
// held to the four replay rules a resumed mission is held to (§9.1).
const missionDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-receipt-"));
fs.copyFileSync(receipt, path.join(missionDir, "events.jsonl"));
after(() => fs.rmSync(missionDir, { recursive: true, force: true }));

const events = createEventLog(missionDir).read();

describe("the run receipt", () => {
  test("replays under the four replay rules, with no gap in seq", () => {
    assert.equal(events.length, 55);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
  });

  test("folds to the mission that actually ran", () => {
    const state = fold(events);

    assert.equal(state.mission.id, "20260813T002547Z-survey-this-repository-s-javascr");
    assert.equal(state.mission.ledger.criteria.length, 7);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0]?.status, "done");
  });

  // Six of seven, and the seventh failed on its merits: the criterion asked for two
  // source files with exports and the scratch repo has one. The replan then proposed
  // amending it, which is where the mission parked — `--unattended` does not approve
  // its own contract change (§3).
  test("carries the verdicts the mission reached, including the one that failed", () => {
    const { criteria } = fold(events).mission.ledger;

    assert.equal(criteria.filter((criterion) => criterion.met === true).length, 6);
    assert.equal(
      criteria.find((criterion) => criterion.met === false)?.id,
      "export-patterns-documented",
    );
  });

  // P2, on a real mission rather than in a fixture: the worker had no worktree, was
  // given one directory, and wrote its report inside it. Defect 41's check ran over
  // the same dispatch and correctly did not fire — a `repo_escaped` here would mean
  // the artifact directory was not where the worker actually wrote.
  test("the non-code worker wrote into its artifact directory and escaped nothing", () => {
    const state = fold(events);

    assert.equal(state.tasks[0]?.agentSpec.outputPath, "report.md");
    assert.match(
      state.tasks[0]?.artifacts[0]?.kind === "document" ? state.tasks[0].artifacts[0].path : "",
      /artifacts\/t1-survey-and-report\/report\.md$/,
    );
    assert.equal(
      events.some((event) => event.type === "repo_escaped"),
      false,
    );
  });

  // A projection is derived, so folding twice must give the same answer — the property
  // "delete the projections mid-mission and they rebuild identically" rests on it.
  test("folds deterministically", () => {
    assert.deepEqual(fold(events), fold(events));
  });
});

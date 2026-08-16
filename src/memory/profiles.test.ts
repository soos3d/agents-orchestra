// The failure mode: a procedural memory that a half-finished hand edit can take the
// mission down with.
//
// A saved profile is markdown a human reads and edits (§7), so the tests that matter
// are the ones about a file somebody touched: a mangled payload names the file rather
// than failing obscurely, an unreadable profile is skipped with a warning rather than
// raising, and a missing directory is "no prior art" rather than an error. Plus the
// name-hygiene defence a saved mission has, for the same reason: a profile name reaches
// the filesystem.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  loadProfiles,
  parseProfile,
  profilesDir,
  renderProfile,
  saveProfile,
  type Profile,
} from "./profiles.js";
import { anAgentSpec } from "../testing/fixtures.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-profiles-"));
let stateDir: string;
let caseNo = 0;

beforeEach(() => {
  stateDir = path.join(tmpRoot, `case-${++caseNo}`);
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const aProfile = (patch: Partial<Profile> = {}): Profile => ({
  name: "invoice-reconciler",
  spec: anAgentSpec({ role: "invoice-reconciler" }),
  promotedFrom: { missionId: "m1", taskId: "t4" },
  promotedAt: "2026-08-09T10:00:00.000Z",
  ...patch,
});

describe("saved agent profiles", () => {
  describe("rendering", () => {
    test("round trips through markdown", () => {
      const profile = aProfile();

      const parsed = parseProfile(renderProfile(profile));

      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.ok && parsed.profile, profile);
    });

    test("is readable prose as well as a machine payload", () => {
      const markdown = renderProfile(aProfile());

      assert.match(markdown, /# invoice-reconciler/);
      assert.match(markdown, /m1/);
      assert.match(markdown, /t4/);
      // The system prompt is the part a human would actually want to edit.
      assert.match(markdown, /Do not touch anything else/);
    });

    test("a mangled payload block fails with the fix rather than a zod path", () => {
      const parsed = parseProfile("# bent\n\n```json\n{ not json\n```\n");

      assert.equal(parsed.ok, false);
      assert.match(parsed.ok ? "" : parsed.problem, /orchestra promote/);
    });

    test("a file with no payload block at all says what is missing", () => {
      const parsed = parseProfile("# invoice-reconciler\n\njust prose\n");

      assert.equal(parsed.ok, false);
      assert.match(parsed.ok ? "" : parsed.problem, /json/);
    });
  });

  describe("saveProfile", () => {
    test("writes owner-only, atomically, under profiles/", () => {
      const file = saveProfile(stateDir, aProfile());

      assert.equal(file, path.join(profilesDir(stateDir), "invoice-reconciler.md"));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(profilesDir(stateDir)).mode & 0o777, 0o700);
      assert.deepEqual(fs.readdirSync(profilesDir(stateDir)), ["invoice-reconciler.md"]);
    });

    test("what it wrote is what loadProfiles reads back", () => {
      saveProfile(stateDir, aProfile());

      assert.deepEqual(loadProfiles(stateDir), [aProfile()]);
    });

    // Defect 42. Those names were checked against the envelope of the mission that
    // promoted them, and the missions offered this profile have their own — narrower,
    // older, or about something else. A grant riding across on a name is a grant no
    // human made, which is the same argument `offer.ts` makes about tools.
    test("drops the environment variables the promoted spec was granted", () => {
      const promoted = aProfile({ spec: anAgentSpec({ env: ["XERO_TOKEN"] }) });

      const file = saveProfile(stateDir, promoted);

      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /XERO_TOKEN/);
      assert.equal(loadProfiles(stateDir)[0]?.spec.env, undefined);
      // And the caller's own object is untouched — the strip is a copy, not a mutation.
      assert.deepEqual(promoted.spec.env, ["XERO_TOKEN"]);
    });

    test("refuses a name that is really a path", () => {
      for (const name of ["../escape", "a/b", "a\\b", ""]) {
        assert.throws(() => saveProfile(stateDir, aProfile({ name })), /not a profile name/);
      }
    });
  });

  describe("loadProfiles", () => {
    // The first mission on a machine has no prior art, and that is the normal case.
    test("a missing directory is no prior art rather than an error", () => {
      assert.deepEqual(loadProfiles(stateDir), []);
    });

    // Markdown a human can edit is the feature (§6), so a half-finished edit costs one
    // profile and never the mission.
    test("an unreadable profile is skipped with a warning naming the file", () => {
      saveProfile(stateDir, aProfile());
      fs.writeFileSync(path.join(profilesDir(stateDir), "bent.md"), "# bent\n\nno payload\n");
      const warnings: string[] = [];

      const profiles = loadProfiles(stateDir, (message) => warnings.push(message));

      assert.deepEqual(
        profiles.map((profile) => profile.name),
        ["invoice-reconciler"],
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /bent\.md/);
    });

    test("reads every profile in the directory, in a stable order", () => {
      saveProfile(stateDir, aProfile({ name: "beta" }));
      saveProfile(stateDir, aProfile({ name: "alpha" }));

      assert.deepEqual(
        loadProfiles(stateDir).map((profile) => profile.name),
        ["alpha", "beta"],
      );
    });
  });
});

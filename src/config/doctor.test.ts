// The providers line reports a *narrowing*, which is the only fact a mission depends on:
// a card with no probe transcript is on no menu, exactly as an ACP target with no binary
// is on none. The case worth catching is the middle one — a key set, cards on disk, and
// nothing verified — because that is somebody who configured a provider and would
// otherwise see a passing report with no models in it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ModelCard } from "../providers/modelCard.js";
import { checkContainment, checkKb, checkProviders, formatReport, type DoctorReport } from "./doctor.js";

const card = (id: string): ModelCard => ({
  id,
  provider: "nebius",
  access: "api-key",
  tier: "worker",
  contextK: 128,
  costInPer1M: 0.13,
  costOutPer1M: 0.4,
  verifiedBy: `probes/${id}.json`,
});

describe("checkProviders", () => {

  test("no provider and no card is a pass, not a gap", () => {
    const check = checkProviders([], {}, []);
    assert.equal(check.level, "ok");
    assert.equal(check.fix, undefined);
  });

  test("a key set and nothing verified warns with what to type", () => {
    const check = checkProviders([card("a")], { nebius: "k" }, []);
    assert.equal(check.level, "warn");
    assert.match(check.detail, /none are offered/);
    assert.ok(check.fix);
  });

  test("cards on disk with no key say so rather than blaming the probe", () => {
    const check = checkProviders([card("a")], {}, []);
    assert.equal(check.level, "warn");
    assert.match(check.detail, /no provider key set/);
  });

  test("a verified card reports the narrowing it survived", () => {
    const check = checkProviders([card("a"), card("b")], { nebius: "k" }, [card("a")]);
    assert.equal(check.level, "ok");
    assert.match(check.detail, /1 of 2 cards verified/);
  });
});

// PLAN-NEXT 3.3. Two halves fail differently and a single "containment unavailable"
// would send someone to restart a daemon that is already running.
describe("checkContainment", () => {
  const base = {
    cwd: "/repo",
    stateDir: "/state",
    worktreeRoot: "/wt",
    agents: [],
    orchestratorModel: "opus",
  };

  test("no backend is not a failure — containment is opt-in per mission", () => {
    const check = checkContainment({ ...base, containers: [] });
    assert.equal(check.level, "ok");
    assert.match(check.detail, /run on this machine/);
  });

  test("a backend with no image warns, and names the variable rather than an image", () => {
    const check = checkContainment({ ...base, containers: ["docker"] });
    assert.equal(check.level, "warn");
    assert.match(check.fix ?? "", /ORCHESTRA_CONTAINER_IMAGE/);
    // No image is ever suggested: none has been verified to hold an agent CLI.
    assert.equal(/docker\.io|ubuntu|alpine|node:/.test(check.fix ?? ""), false);
  });

  test("both halves present reports what a worker would actually run in", () => {
    const check = checkContainment({ ...base, containers: ["docker"], containerImage: "org/worker" });
    assert.equal(check.level, "ok");
    assert.match(check.detail, /docker running org\/worker/);
  });
});

// The map is a cache, so every one of its absences is a normal state and none of them may
// stop a mission: no repo, no build yet, and a directory somebody deleted all land here.
describe("checkKb", () => {
  const base = {
    cwd: "/repo",
    stateDir: "/state",
    worktreeRoot: "/wt",
    agents: [],
    orchestratorModel: "opus",
  };

  test("no repository is nothing to index", () => {
    const check = checkKb(base);
    assert.equal(check.level, "ok");
    assert.match(check.detail, /no repo to index/);
  });

  test("an unbuilt map passes and says what to type", () => {
    const check = checkKb({ ...base, repoRoot: "/repo" });
    assert.equal(check.level, "ok");
    assert.ok(check.fix);
  });

  test("a built map reports the commit it describes", () => {
    const check = checkKb({ ...base, repoRoot: "/repo" }, { head: "abc1234def", index: "- src/" });
    assert.equal(check.level, "ok");
    assert.match(check.detail, /abc1234/);
    assert.match(check.detail, /HEAD moves/);
  });
});

// The two-pool lead-in: capped workers vs probed factory cards, printed before any
// check so a person reading doctor for the first time sees both menus and that
// judge is not on either.
describe("formatReport lead-in", () => {
  const empty: DoctorReport = {
    checks: [{ name: "node", level: "ok", detail: "v22" }],
    ready: true,
    agents: [],
    factoryCards: [],
  };

  test("names both pools and that judge is not staffable, before the check list", () => {
    const text = formatReport({
      ...empty,
      agents: ["claude", "opencode"],
      factoryCards: [card("a"), { ...card("b"), tier: "fast" }],
    });
    const lines = text.split("\n");

    assert.equal(lines[0], "Workers on PATH (capped): claude, opencode");
    assert.equal(lines[1], "Factory cards probed: 2 (fast, worker)");
    assert.equal(lines[2], "Judge is local and not staffable.");
    assert.match(lines[3] ?? "", /✓ node/);
  });

  test("empty pools say none rather than inventing a menu", () => {
    const lines = formatReport(empty).split("\n");

    assert.equal(lines[0], "Workers on PATH (capped): none");
    assert.equal(lines[1], "Factory cards probed: 0 (none)");
    assert.equal(lines[2], "Judge is local and not staffable.");
  });
});

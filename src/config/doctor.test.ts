// The channel check is a security check wearing a diagnostic's clothes: §17's rule
// is that a non-loopback Gateway is refused, not authenticated, and `doctor` is
// where a bad URL is caught before anything trusts it. The failure mode under test
// is the confident misconfiguration — a Gateway on another machine that would carry
// payment gates off this one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ModelCard } from "../providers/modelCard.js";
import { checkChannel, checkContainment, checkKb, checkProviders } from "./doctor.js";

describe("checkChannel", () => {
  test("no mirror is the default and passes", () => {
    assert.equal(checkChannel(undefined).level, "ok");
  });

  test("a loopback gateway is accepted, with the honest caveat", () => {
    for (const url of ["ws://127.0.0.1:18789", "ws://localhost:18789", "http://[::1]:18789"]) {
      const check = checkChannel(url);
      assert.notEqual(check.level, "fail", url);
    }
  });

  test("a non-loopback gateway fails with the fix named", () => {
    for (const url of ["ws://192.168.1.20:18789", "wss://gateway.example.com", "ws://127.0.0.1.evil.com:1"]) {
      const check = checkChannel(url);
      assert.equal(check.level, "fail", url);
      assert.ok(check.fix);
    }
  });

  test("a string that is not a URL fails rather than passing by accident", () => {
    assert.equal(checkChannel("not a url").level, "fail");
  });
});

// The providers line reports a *narrowing*, which is the only fact a mission depends on:
// a card with no probe transcript is on no menu, exactly as an ACP target with no binary
// is on none. The case worth catching is the middle one — a key set, cards on disk, and
// nothing verified — because that is somebody who configured a provider and would
// otherwise see a passing report with no models in it.
describe("checkProviders", () => {
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
    maxConcurrency: 4,
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
    maxConcurrency: 4,
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

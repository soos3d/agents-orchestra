// The channel check is a security check wearing a diagnostic's clothes: §17's rule
// is that a non-loopback Gateway is refused, not authenticated, and `doctor` is
// where a bad URL is caught before anything trusts it. The failure mode under test
// is the confident misconfiguration — a Gateway on another machine that would carry
// payment gates off this one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkChannel } from "./doctor.js";

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

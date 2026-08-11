// The failure mode under test: a live agent widening its own grant mid-run, or a
// human being asked to approve something they already approved at sign-off.
//
// Both are failures, and they pull in opposite directions — which is why this decision
// is a pure function with a test rather than a branch inside a message handler.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anAgentSpec } from "../../testing/fixtures.js";
import { decidePermission } from "./permissions.js";

const readOnly = anAgentSpec({ tools: ["Read", "Glob", "Grep"] });

describe("the acp permission decision", () => {
  test("allows a tool the spec was granted by name", () => {
    assert.equal(decidePermission(readOnly, { tool: "Grep", detail: "grep -n foo src" }), "allow");
  });

  // The unit of approval is the class (§4.0): the envelope is written in classes, and
  // the names on the spec are synthesis narrowing that class for readability. An agent
  // that holds `Read` holds `fs.read`, and asking about `Glob` is a gate on a
  // capability the human already granted — gate fatigue for nothing (§11).
  test("allows a sibling of a class the spec demonstrably holds", () => {
    const spec = anAgentSpec({ tools: ["Read"] });

    assert.equal(decidePermission(spec, { tool: "Glob", detail: "src/**/*.ts" }), "allow");
  });

  // The other direction, and the one that matters: a different class is a different
  // capability, and nothing here may widen it (§7).
  test("asks about a tool outside the grant", () => {
    assert.equal(decidePermission(readOnly, { tool: "Write", detail: "src/clamp.ts" }), "ask");
    assert.equal(decidePermission(readOnly, { tool: "Bash", detail: "rm -rf /" }), "ask");
  });

  // Never auto-denied. §7 reserves widening for a human, and a refusal we invent here
  // is a decision taken away from them — the mission would fail without them ever
  // hearing that a narrower envelope was the reason.
  test("asks about a tool the catalogue does not ship rather than refusing it", () => {
    assert.equal(decidePermission(readOnly, { tool: "Frobnicate", detail: "" }), "ask");
  });

  // A class id is not a tool name, and `AgentSpec.tools` is `z.array(z.string())` on
  // purpose, so both are representable and neither may be confused for the other.
  test("a class id offered as a tool name is unknown, not a grant", () => {
    const spec = anAgentSpec({ tools: ["fs.write"] });

    assert.equal(decidePermission(spec, { tool: "fs.write", detail: "" }), "ask");
    assert.equal(decidePermission(spec, { tool: "Write", detail: "src/clamp.ts" }), "ask");
  });

  test("a spec granted nothing gets asked about everything", () => {
    const spec = anAgentSpec({ tools: [] });

    assert.equal(decidePermission(spec, { tool: "Read", detail: "package.json" }), "ask");
  });

  // A class the catalogue declares with no tools (§7's Phase 8 placeholders) grants no
  // capability at all, so nothing can be allowed through it by holding it.
  test("an empty class cannot be held, so it cannot allow anything", () => {
    const spec = anAgentSpec({ tools: ["browser.read"] });

    assert.equal(decidePermission(spec, { tool: "browser.read", detail: "" }), "ask");
  });
});

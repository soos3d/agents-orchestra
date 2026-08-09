// The failure mode under test: a capability class that resolves to nothing anybody
// can check.
//
// The envelope's whole security claim is that synthesis "draws only from the envelope
// and can never widen it" (§7). That claim needs a function mapping a class to tools
// and a function mapping a tool back to its class — without the second one, a model
// can return any string in `AgentSpec.tools` and no containment check has anything to
// compare it against.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classOf,
  describeClasses,
  resolveClasses,
  TOOL_CATALOGUE,
  DEFAULT_TOOL_CLASSES,
} from "./toolCatalogue.js";

describe("the tool catalogue", () => {
  test("resolves a class to the tools it grants", () => {
    assert.deepEqual(resolveClasses(["fs.read"]), ["Read", "Glob", "Grep"]);
  });

  test("unions several classes without repeating a tool", () => {
    const granted = resolveClasses(["fs.read", "fs.read", "shell.run"]);
    assert.deepEqual(granted, ["Read", "Glob", "Grep", "Bash"]);
  });

  // The envelope is a human's document. An unrecognised line in it narrows the grant
  // rather than widening it, and never throws — a typo should cost capability, not the
  // mission.
  test("a class nobody authored grants nothing", () => {
    assert.deepEqual(resolveClasses(["fs.wirte"]), []);
    assert.deepEqual(resolveClasses([]), []);
  });

  // §11's classes exist in the design and their tools land in Phase 8. Resolving to
  // nothing is the honest answer; resolving to an error would make an envelope that
  // names the future unrepresentable.
  test("a class whose tools are not built yet grants nothing rather than failing", () => {
    assert.deepEqual(resolveClasses(["browser.commit"]), []);
  });

  test("maps a tool back to its class, which is what containment is checked on", () => {
    assert.equal(classOf("Bash"), "shell.run");
    assert.equal(classOf("Edit"), "fs.write");
  });

  // Not "unclassified" — not ours. A synthesized agent naming it is asking for
  // something we do not ship, and that has to be refusable.
  test("a tool we do not ship has no class", () => {
    assert.equal(classOf("Frobnicate"), undefined);
    assert.equal(classOf("read"), undefined);
  });

  test("round-trips: every tool in the catalogue maps back to the class that granted it", () => {
    for (const entry of TOOL_CATALOGUE) {
      for (const tool of entry.tools) {
        assert.equal(classOf(tool), entry.id, `${tool} should belong to ${entry.id}`);
      }
    }
  });

  test("no tool is granted by two classes, or containment would depend on lookup order", () => {
    const all = TOOL_CATALOGUE.flatMap((entry) => entry.tools);
    assert.equal(all.length, new Set(all).size);
  });

  test("the default envelope's classes are all ones the catalogue can resolve", () => {
    assert.ok(resolveClasses(DEFAULT_TOOL_CLASSES).length > 0);
    for (const id of DEFAULT_TOOL_CLASSES) {
      assert.ok(
        TOOL_CATALOGUE.some((entry) => entry.id === id),
        `${id} is granted by default but is not in the catalogue`,
      );
    }
  });

  test("describes a class in one line, and skips one it does not know", () => {
    assert.deepEqual(describeClasses(["shell.run"]), [
      "shell.run → Bash (run commands in the task's working directory)",
    ]);
    assert.deepEqual(describeClasses(["nope"]), []);
  });
});

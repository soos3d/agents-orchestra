// The failure mode under test: a contributor clones, runs `npm run dev`, and gets a
// dashboard whose only script 404s — a blank page whose cause is one line in a
// console nobody opens. The page used to be a string and could not be absent; it is
// a built artefact now and can be, so the resolution has to be right in two layouts
// and the failure has to name the command that fixes it (§2a rule 5).
//
// Both layouts are asserted here because a running process can only ever demonstrate
// one of them: shipped, this module is `dist/web/assets.js`; from source it is
// `src/web/assets.ts`, and the bundle it wants is in neither's own directory.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundlePathFrom, MissingBundleError, readBundle } from "./assets.js";

const urlFor = (...segments: string[]): string =>
  pathToFileURL(path.join("/tmp", "orchestra", ...segments)).href;

describe("bundlePathFrom", () => {
  test("shipped, the bundle is this module's sibling", () => {
    assert.equal(
      bundlePathFrom(urlFor("dist", "web", "assets.js")),
      path.join("/tmp", "orchestra", "dist", "web", "app.js"),
    );
  });

  test("from source, the bundle is still the built one in dist", () => {
    assert.equal(
      bundlePathFrom(urlFor("src", "web", "assets.ts")),
      path.join("/tmp", "orchestra", "dist", "web", "app.js"),
    );
  });

  // Guessing at an unknown layout would produce exactly the silent blank page this
  // module exists to prevent.
  test("refuses a layout nobody has built, and says what it expected", () => {
    assert.throws(
      () => bundlePathFrom(urlFor("build", "web", "assets.js")),
      (error: Error) => error.message.includes("dist/web or src/web"),
    );
  });
});

describe("readBundle", () => {
  test("a missing bundle names the command that builds it", () => {
    let thrown: unknown;
    try {
      readBundle(urlFor("dist", "web", "assets.js"));
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof MissingBundleError);
    assert.ok(thrown.message.includes("npm run build"), "the message does not say what to type");
    assert.ok(thrown.message.includes("app.js"), "the message does not say what is missing");
  });
});

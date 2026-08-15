// The failure mode under test: the display face ships in the repo and not in the
// package, so every install outside this checkout renders the wordmark in whatever
// system face the fallback stack lands on — and nobody notices, because the page is
// never broken, only wrong.
//
// Two halves. The path is resolved from a module URL, exactly as the bundle's is, so
// the layout it expects is assertable without a running server. And the file is really
// there, which is the half that catches a `package.json` `files` list that forgot
// `assets`.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { FONT_ROUTE, fontPathFrom, readFont } from "./fonts.js";

describe("fontPathFrom", () => {
  test("finds the same assets directory from the built layout and from source", () => {
    // The whole reason this is one line rather than `bundlePathFrom`'s branch: the
    // font is package data, so it does not move when the code is compiled.
    assert.equal(
      fontPathFrom("file:///x/dist/web/fonts.js"),
      "/x/assets/ChakraPetch-SemiBold.woff2",
    );
    assert.equal(
      fontPathFrom("file:///x/src/web/fonts.ts"),
      "/x/assets/ChakraPetch-SemiBold.woff2",
    );
  });

  test("the route is a path the server can compare against", () => {
    assert.match(FONT_ROUTE, /^\/[a-z0-9.]+$/);
  });
});

describe("readFont", () => {
  test("the vendored face is present and is a woff2", () => {
    const bytes = readFont(import.meta.url);
    assert.ok(bytes, `no display face at ${fontPathFrom(import.meta.url)} — it must ship in assets/`);
    // wOF2, the file signature. A truncated or LFS-pointer download passes a size
    // check and fails here.
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2");
  });

  test("the licence ships beside it, which the OFL requires", () => {
    const licence = fontPathFrom(import.meta.url).replace(/[^/]+$/, "OFL.txt");
    assert.ok(fs.existsSync(licence), `the SIL Open Font License must ship at ${licence}`);
  });

  test("a layout with no font is a fallback, not a crash", () => {
    assert.equal(readFont("file:///nowhere/dist/web/fonts.js"), null);
  });
});

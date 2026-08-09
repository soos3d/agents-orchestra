// The failure mode under test: the page is client-side JavaScript carried inside
// TypeScript template literals, and a fragment that picks up a backtick or a
// dollar-brace does not fail the build — it silently truncates or interpolates the
// page, and the first sign is a blank dashboard on a live mission. The composition
// is also asserted whole: the ids the wire fragment binds must exist in the markup,
// or the script throws on load and every screen dies with it.
import assert from "node:assert/strict";
import test from "node:test";
import { pageProjection } from "./page/projection.js";
import { pageScreens } from "./page/screens.js";
import { pageStyle } from "./page/style.js";
import { pageWire } from "./page/wire.js";
import { shellHtml } from "./shell.html.js";

const fragments = {
  pageProjection,
  pageScreens,
  pageStyle,
  pageWire,
};

test("no fragment contains a backtick or template interpolation", () => {
  for (const [name, fragment] of Object.entries(fragments)) {
    assert.ok(!fragment.includes("`"), `${name} contains a backtick`);
    assert.ok(!fragment.includes("${"), `${name} contains a template interpolation`);
  }
});

test("the composed page carries every id the script binds", () => {
  const html = shellHtml();
  // The elements the wire and render fragments reach for unconditionally.
  for (const id of ["goal", "bar", "screen", "note", "send-note", "panic", "log"]) {
    assert.ok(html.includes(`id="${id}"`), `missing element #${id}`);
  }
});

test("the composed page is one document with one script", () => {
  const html = shellHtml();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.equal(html.match(/<script>/g)?.length, 1);
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  assert.ok(html.trimEnd().endsWith("</html>"));
});

test("the screens cover the board, the strip, and the provenance panel", () => {
  // Phase 6's three additions, asserted by the functions that draw them existing in
  // the shipped script — the cheapest tripwire against a fragment edit dropping one.
  const html = shellHtml();
  for (const fn of ["renderBoard", "renderStrip", "renderWhy", "renderInbox", "renderSignoff"]) {
    assert.ok(html.includes(`function ${fn}(`), `page no longer defines ${fn}`);
  }
});

// The failure mode under test: the shell is the one thing the browser loads before
// any JavaScript runs, so a skeleton that has lost its mount point or its script tag
// is a permanently blank dashboard with nothing in the console to explain it.
//
// This file used to guard something else. The page was client JavaScript carried in
// TypeScript template literals, and a fragment that picked up a backtick or a
// dollar-brace silently truncated or interpolated it — the assertions here were the
// only thing standing between that and a blank screen on a live mission. The bundle
// removed the template literals, so that guard is gone with the hazard it existed
// for, and the screen assertions it also carried moved to `app/screens.test.tsx`,
// where they can test what a view actually renders instead of whether a string
// appears somewhere in a script.
import assert from "node:assert/strict";
import test from "node:test";
import { BUNDLE_ROUTE } from "./assets.js";
import { shellHtml } from "./shell.html.js";

test("the shell carries the mount point the bundle renders into", () => {
  assert.ok(shellHtml().includes('id="app"'));
});

test("the shell loads the bundle as a module, and by the route the server serves", () => {
  const html = shellHtml();

  assert.ok(html.includes(`<script type="module" src="${BUNDLE_ROUTE}"></script>`));
  // One script, and it is external. An inline one would need `script-src
  // 'unsafe-inline'` back, which is the directive the bundle bought us out of.
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.ok(!html.includes("<script>"));
});

test("the shell is one whole document", () => {
  const html = shellHtml();

  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));
});

// Not decoration: the browser paints this before the socket opens, and a mission that
// is slow to connect should say so rather than showing an empty page.
test("the shell says something before any script has run", () => {
  assert.ok(shellHtml().includes("connecting…"));
});

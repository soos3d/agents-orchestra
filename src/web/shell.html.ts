// The dashboard page, composed from string fragments.
//
// A string rather than a bundle because §2a allows one process and no build step
// beyond `tsc`: a Vite dev server or a committed React bundle both buy component
// structure these screens do not need, and both put a second toolchain between a
// clone and a working `orchestra run`. Phase 6 grew the page to a board and a
// provenance panel and the trade still held — what changed is that the page now
// lives in `page/` as four fragments (style, projection, screens, wire), because a
// thousand-line template literal is what the file-size rule exists to prevent.
//
// The page renders from events and holds no state the log does not. The second
// reducer it computes is named and contained in `page/projection.ts`.
import { pageProjection } from "./page/projection.js";
import { pageScreens } from "./page/screens.js";
import { pageStyle } from "./page/style.js";
import { pageWire } from "./page/wire.js";

export function shellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fable-orchestra</title>
<style>${pageStyle}</style>
</head>
<body>
<main>
  <h1 id="goal">connecting…</h1>
  <div class="bar" id="bar"></div>
  <div id="screen"></div>
  <div id="mission-extras">
    <h2>Note — steers the mission, never blocks it</h2>
    <div class="row">
      <input id="note" placeholder="e.g. stop using the staging database">
      <button id="send-note">send</button>
      <button id="pause" title="drain in-flight work and park — reversible">pause</button>
      <button id="panic" title="stop dispatching now — worktrees are left intact">panic</button>
    </div>
    <h2>Timeline</h2>
    <div class="log" id="log"></div>
  </div>
</main>
<script>
(() => {
  "use strict";
${pageProjection}
${pageScreens}
${pageWire}
})();
</script>
</body>
</html>`;
}

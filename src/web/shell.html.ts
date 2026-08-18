// The dashboard page: a document skeleton and one script tag.
//
// It was four string fragments concatenated into an inline `<script>`, which bought
// §2a's no-build-step constraint at the price of carrying client JavaScript inside
// TypeScript template literals — where a stray backtick silently truncated the page.
// The bundle replaces that. The constraint it was protecting is unharmed: the build
// is the *maintainer's*, `npm i -g @soos3d/orchestra` is unchanged, and a user still
// runs one binary and one process with no dev server and no services.
//
// What the trade bought, beyond the look: `script-src 'self'` instead of
// `'unsafe-inline'`, and a page whose reducer is typechecked against the real event
// union rather than being untyped JavaScript in a string.
import { BUNDLE_ROUTE } from "./assets.js";
import { FONT_ROUTE } from "./fonts.js";
import { pageStyle } from "./style.js";

export function shellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control</title>
<link rel="preload" href="${FONT_ROUTE}" as="font" type="font/woff2" crossorigin>
<style>${pageStyle}</style>
</head>
<body>
<main id="app"><h1>connecting…</h1></main>
<script type="module" src="${BUNDLE_ROUTE}"></script>
</body>
</html>`;
}

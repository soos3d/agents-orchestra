// Where the display face is, and what to say when it is not there.
//
// The page has one bundled typeface and it is served from this process, never fetched
// from a font CDN. That is the same rule the bundle follows and it is not about speed:
// `default-src 'none'` is a claim that no third party is inside a surface where a human
// approves work, and a stylesheet that reaches for fonts.gstatic.com quietly makes that
// claim false. The CSP gains `font-src 'self'` and nothing wider.
//
// The resolution mirrors `assets.ts` deliberately, and is simpler than it: the font is
// package data rather than a build output, so it sits at `<pkg>/assets/` and both
// layouts — shipped `dist/web/fonts.js` and from-source `src/web/fonts.ts` — reach it
// by the same two hops up. If that ever stops being true, this becomes `bundlePathFrom`
// and grows the same branch.
//
// A missing font is not a missing bundle: the page still works, in the fallback stack.
// So the route answers 404 and the server warns, rather than the read throwing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one font the page loads. Also the request path, so the two cannot drift. */
export const FONT_ROUTE = "/display.woff2";

/** The vendored file. Latin subset, one weight — see NOTICE for the licence. */
const FONT_FILE = "ChakraPetch-SemiBold.woff2";

/** The display face's path, given the URL of a module sitting in `web/`. */
export function fontPathFrom(moduleUrl: string): string {
  const webDir = path.dirname(fileURLToPath(moduleUrl));
  return path.join(path.dirname(path.dirname(webDir)), "assets", FONT_FILE);
}

/** The font bytes, or null when the file is not there — the page holds without it. */
export function readFont(moduleUrl: string): Buffer | null {
  try {
    return fs.readFileSync(fontPathFrom(moduleUrl));
  } catch {
    return null;
  }
}

// Where the dashboard bundle is, and what to say when it is not there.
//
// The page stopped being a string in this file's own commit, which trades one
// problem for another: a string is always present, and a built artefact can be
// missing. It is missing in exactly one situation and it is the common one — a
// contributor runs `npm run dev` from source, having never run `npm run build`,
// and `tsx` happily serves a page whose only script 404s. A blank dashboard with a
// console error is the worst possible report of that, so the read throws instead,
// and the message names the command (§2a rule 5).
//
// The resolution is pure and lives here rather than inline in `server.ts`, because
// the two layouts it has to handle cannot both be exercised from one running
// process: shipped, this module is `dist/web/assets.js` and the bundle is its
// sibling; from source it is `src/web/assets.ts` and the bundle is two directories
// up in `dist/`. A test can hand it either URL; a running server can only ever
// demonstrate one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one script the page loads. Also the request path, so the two cannot drift. */
export const BUNDLE_ROUTE = "/app.js";

export class MissingBundleError extends Error {
  constructor(readonly bundlePath: string) {
    super(
      `The dashboard bundle is missing at ${bundlePath}.\n` +
        "Run `npm run build` (or `npm run build:web` for just the page) and start again.",
    );
    this.name = "MissingBundleError";
  }
}

/**
 * The built bundle's path, given the URL of a module sitting in `web/`.
 *
 * Shipped: `<x>/dist/web/assets.js` → `<x>/dist/web/app.js`.
 * From source: `<x>/src/web/assets.ts` → `<x>/dist/web/app.js`.
 *
 * Anything else is a layout nobody has built, and guessing at one would produce the
 * blank page this module exists to prevent — so it says so instead.
 */
export function bundlePathFrom(moduleUrl: string): string {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  const parent = path.basename(path.dirname(dir));

  if (parent === "dist") return path.join(dir, "app.js");
  if (parent === "src") return path.join(path.dirname(path.dirname(dir)), "dist", "web", "app.js");

  throw new Error(
    `Cannot locate the dashboard bundle from '${dir}' — expected this module to live in dist/web or src/web.\n` +
      "If the build layout changed, update bundlePathFrom in src/web/assets.ts to match.",
  );
}

/** Read on every request rather than cached at startup, so `npm run build:web --watch`
 *  is useful without restarting the server. One file read per page load, on loopback. */
export function readBundle(moduleUrl: string): string {
  const bundlePath = bundlePathFrom(moduleUrl);
  try {
    return fs.readFileSync(bundlePath, "utf8");
  } catch {
    throw new MissingBundleError(bundlePath);
  }
}

/** What the bundle route answers with, and what the terminal should be told. */
export interface BundleResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Present when something is wrong the operator has to fix. */
  readonly warn?: string;
}

/**
 * The bundle route's whole decision, as a value.
 *
 * It is here rather than inline in `server.ts` for the reason that file's own header
 * gives: `server.ts` sits below the fixture harness, so a branch inside its request
 * handler is a branch a green suite says nothing about — and the branch that mattered
 * was the failing one. A missing bundle is the common first-run mistake, and answering
 * `200 ""` or a bare 404 turns it into a blank page whose cause is one line in a
 * console nobody opens.
 *
 * 503 rather than 404: the route exists and the artefact does not yet, which is a
 * server that is not ready — and it is the status that stops a proxy or a browser
 * caching the emptiness. `no-store` for the same reason the served bundle carries it:
 * the next request may come after `npm run build:web --watch` has fixed this.
 */
export function bundleResponse(read: () => string): BundleResponse {
  let bundle: string;
  try {
    bundle = read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      body: message,
      // On the wire and on the terminal both (§2a rule 5): whoever is looking at the
      // blank tab and whoever is looking at the server log are often not the same person.
      warn: message,
    };
  }

  return {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
    body: bundle,
  };
}

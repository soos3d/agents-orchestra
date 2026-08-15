// The failure mode under test: a CSS comment that ends the stylesheet.
//
// `pageStyle` is a TypeScript template literal, so a backtick anywhere inside it
// closes the string and a `${` opens an interpolation. Both are ordinary things to
// type in a comment — naming `tokens.ts` or `briefing()` in backticks the way every
// other comment in this codebase does — and both fail as a *parse error several lines
// later*, which reads as a broken edit rather than as a stray character.
//
// This has cost four separate debugging detours. `shell.test.ts` used to guard the
// same hazard for the page and retired when JSX removed it there; the stylesheet is
// still a string and still needs the guard.
//
// The check is the whole test: no backtick, and no `${` that is not one of the token
// interpolations this file is built from — which is why the assertion runs over the
// *source*, not the rendered string.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { FONT_ROUTE } from "./fonts.js";
import { pageStyle } from "./style.js";
import { tokens } from "./tokens.js";

const source = (): string =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "style.ts"), "utf8");

/** The template literal's body: everything between the first backtick after
 *  `pageStyle = ` and the last backtick in the file. */
function literalBody(text: string): string {
  const opened = text.indexOf("`", text.indexOf("export const pageStyle"));
  const closed = text.lastIndexOf("`");
  assert.ok(opened !== -1 && closed > opened, "pageStyle is no longer a template literal");
  return text.slice(opened + 1, closed);
}

describe("the stylesheet source", () => {
  test("contains no backtick, which would end the string mid-comment", () => {
    assert.equal(
      literalBody(source()).includes("`"),
      false,
      "a backtick inside pageStyle ends the template literal — write the name without backticks",
    );
  });

  test("interpolates nothing but design tokens", () => {
    const names = Object.keys(tokens);

    for (const match of literalBody(source()).matchAll(/\$\{([^}]*)\}/g)) {
      const expression = match[1]!.trim();
      assert.match(
        expression,
        /^tokens\.[A-Za-z0-9]+$/,
        `pageStyle interpolates '${expression}' — only tokens.ts values belong in the stylesheet`,
      );
      assert.ok(
        names.includes(expression.slice("tokens.".length)),
        `pageStyle reads '${expression}', which tokens.ts does not define`,
      );
    }
  });

  test("renders every custom property it declares with a real value", () => {
    // `undefined` is what a renamed token produces, and it fails silently: the browser
    // drops the declaration and the page loses a colour rather than an element.
    assert.equal(pageStyle.includes("undefined"), false);
    assert.equal(/--[a-z0-9-]+:\s*;/.test(pageStyle), false, "a custom property is declared empty");
  });

  // The one thing in here that cannot be interpolated and still has to agree with a
  // constant: the rule above forbids any ${} that is not a token, so the @font-face
  // carries the route as a literal. If FONT_ROUTE moves, the page silently renders in
  // the fallback face — which looks like a design choice rather than a broken URL.
  test("loads the display face from the route the server actually serves", () => {
    assert.ok(
      pageStyle.includes(`url("${FONT_ROUTE}")`),
      `the @font-face does not point at ${FONT_ROUTE} — the display face will not load`,
    );
  });

  // The page fetches nothing from anywhere: `default-src 'none'` says so and this is
  // the surface that would quietly break it, since a font CDN is one paste away.
  test("references no external origin", () => {
    assert.equal(/url\(\s*["']?https?:/.test(pageStyle), false);
  });
});

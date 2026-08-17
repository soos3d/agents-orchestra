// The failure mode under test: text nobody can read on the screen where somebody
// approves a payment.
//
// This is not hypothetical and it is not a matter of taste. The first draft of this
// palette set the `check ▸ judge: …` line — the sentence that says how a criterion is
// verified, which is the whole content of a sign-off — at 2.2:1 against its own
// panel. It looked fine on the machine it was designed on. WCAG AA for text this size
// is 4.5:1, and the gap between "looks fine" and "is legible" is exactly what a
// threshold is for.
//
// The rule is deliberately strict: *every* text colour against *every* surface it
// could sit on, rather than only the pairs someone remembered to check.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tokens, type TokenName } from "./tokens.js";

/** Every surface a person reads text on. */
const SURFACES = [
  "abyss",
  "deep",
  "void",
  "sink",
  "panel",
  "raise",
  "attnBg",
  "runBg",
  "hover",
] as const satisfies readonly TokenName[];

/** Every colour used to draw text or a meaningful mark. `faint` is in here on purpose:
 *  it sets criterion ids and the `check ▸ …` line, which are content, not chrome. */
const TEXT_COLOURS = [
  "core",
  "ink",
  "ink2",
  "dim",
  "faint",
  "live",
  "met",
  "attn",
  "fail",
] as const satisfies readonly TokenName[];

const channel = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

/** WCAG relative luminance. The threshold lives in the suite rather than in `src`: the
 *  palette is what ships, and these two functions exist only to assert it. */
function luminance(hex: string): number {
  const int = Number.parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => channel(v / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** WCAG AA for body text. The page sets labels at 10–11px, which is smaller than the
 *  large-text exemption, so nothing here qualifies for the lower 3:1 bar. */
const AA = 4.5;

describe("contrastRatio", () => {
  test("agrees with the two ratios everyone knows", () => {
    assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
    assert.equal(contrastRatio("#123456", "#123456"), 1);
  });

  test("is symmetric — a foreground and a background are the same pair", () => {
    assert.equal(
      contrastRatio(tokens.ink, tokens.panel).toFixed(4),
      contrastRatio(tokens.panel, tokens.ink).toFixed(4),
    );
  });

  test("luminance is ordered the way the palette's hierarchy claims", () => {
    // If this ever inverts, "dim" is brighter than "ink-2" and the visual hierarchy
    // on every screen is upside down.
    assert.ok(luminance(tokens.ink) > luminance(tokens.ink2));
    assert.ok(luminance(tokens.ink2) > luminance(tokens.dim));
    assert.ok(luminance(tokens.dim) > luminance(tokens.faint));
    assert.ok(luminance(tokens.faint) > luminance(tokens.panel));
  });
});

describe("every text colour on every surface", () => {
  for (const surface of SURFACES) {
    for (const colour of TEXT_COLOURS) {
      test(`${colour} on ${surface} clears AA`, () => {
        const ratio = contrastRatio(tokens[colour], tokens[surface]);
        assert.ok(
          ratio >= AA,
          `${colour} (${tokens[colour]}) on ${surface} (${tokens[surface]}) is ${ratio.toFixed(2)}:1, below ${AA}:1`,
        );
      });
    }
  }
});

// The accent is load-bearing in a second way: `button.primary` puts the darkest ground
// *on* the accent rather than beside it, and that pair has to work in reverse.
test("the primary button's ink reads on the accent it sits on", () => {
  assert.ok(contrastRatio(tokens.void, tokens.live) >= AA);
});

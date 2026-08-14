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
import { contrastRatio, luminance, SURFACES, TEXT_COLOURS, tokens } from "./tokens.js";

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

// The palette, as data rather than as literals inside a stylesheet string.
//
// Data because of what this surface is. A human approves a payment gate here, and the
// line they read before clicking is the one describing what a criterion checks — set,
// in the first draft of this design, at 2.2:1 against its own panel. That is not a
// taste failure, it is a legibility failure on the sentence that matters most, and
// "we eyeballed it in a dark room" is not a control.
//
// So the colours live here and `tokens.test.ts` asserts the ratios. A future edit that
// dims a label past the threshold fails the suite instead of shipping.
//
// Roles, darkest ground to brightest ink. Every text colour is checked against every
// surface it is actually used on; ordering here is the hierarchy on the page.
export const tokens = {
  /* the field: what is behind everything, and the one place the page is not teal.
     A near-black ground with a single cyan accent is the look every dark dashboard
     defaults into. The bloom fades from `deep` — blue-violet — into `abyss`, so the
     instruments read as cyan *on* something rather than as the only colour present. */
  abyss: "#03050b",
  deep: "#0a0d1e",

  /* grounds — blue-biased rather than neutral; a pure grey reads as unchosen */
  void: "#070a0e",
  sink: "#0a0f14",
  panel: "#0d1319",
  raise: "#121a22",
  attnBg: "#16120a",
  /* a running task's ground, and the hover ground shared by buttons and inputs */
  runBg: "#0c1820",
  hover: "#111b23",

  /* hairlines and light — never carry text, so they are exempt from the contrast rule.
     `thread` draws an edge between two orrery nodes and `bloom` is the halo around a
     panel or a core; both are ambience, which is why they are desaturated and why
     neither is allowed to reach the strength of `live`. */
  line: "#1c2a35",
  line2: "#2a3d4c",
  liveD: "#1c6d7a",
  attnD: "#6b4f18",
  failD: "#6d2429",
  thread: "#1b3a52",
  bloom: "#2a6f8c",

  /* ink */
  ink: "#cfe3ee",
  ink2: "#93aabb",
  dim: "#8299aa",
  faint: "#74899b",

  /* the hottest point of the core, and nothing else. It is brighter than `ink` on
     purpose — the core is the one thing on the page allowed to look like a light
     source rather than like a surface. */
  core: "#eaf9fd",

  /* the one accent, and the semantics kept off it */
  live: "#4fd6e8",
  met: "#5fcf9e",
  attn: "#f0a830",
  fail: "#ff5a63",
} as const;

export type TokenName = keyof typeof tokens;

/** Every surface a person reads text on. */
export const SURFACES = [
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
export const TEXT_COLOURS = [
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

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const int = Number.parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => channel(v / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

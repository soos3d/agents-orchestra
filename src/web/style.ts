// The dashboard's stylesheet, and the whole of its design system.
//
// Inline in the shell rather than a second asset, deliberately. `style-src
// 'unsafe-inline'` is a far weaker grant than the script one the bundle bought us out
// of — no user content reaches this string, the server composes all of it — and a
// linked stylesheet would paint an unstyled frame first. On an instrument panel that
// flash is the whole impression.
//
// **Single theme, by commitment.** This is a panel you read at hour four of a run, not
// a document, so it does not follow the host's light mode: every colour is painted
// explicitly and the page holds on any ground. That is a choice, not an omission.
//
// **One accent.** `--live` (cyan) means *running*, and nothing else is allowed to use
// it. `--met`, `--attn` and `--fail` are semantic and stay off the accent, so a glow
// always means one thing. `--fail` is rationed to panic and failure — a surface that
// approves payments cannot afford cheap alarm colour.
//
// **Glow is state, never decoration.** Only a running task scans and only a live dot
// pulses, so movement at the edge of vision means something actually changed. All of
// it stops under `prefers-reduced-motion`.
import { tokens } from "./tokens.js";

export const pageStyle = `
  :root {
    /* Every colour here comes from tokens.ts, where tokens.test.ts asserts that
       each text colour clears WCAG AA on each surface. Do not inline a hex below —
       an untested colour is how the check line ended up at 2.2:1. */
    --void: ${tokens.void};
    --sink: ${tokens.sink};
    --panel: ${tokens.panel};
    --raise: ${tokens.raise};
    --run-bg: ${tokens.runBg};
    --hover-bg: ${tokens.hover};
    --line: ${tokens.line};
    --line-2: ${tokens.line2};

    --ink: ${tokens.ink};
    --ink-2: ${tokens.ink2};
    --dim: ${tokens.dim};
    --faint: ${tokens.faint};

    --live: ${tokens.live};
    --live-d: ${tokens.liveD};
    --met: ${tokens.met};
    --attn: ${tokens.attn};
    --attn-d: ${tokens.attnD};
    --attn-bg: ${tokens.attnBg};
    --fail: ${tokens.fail};
    --fail-d: ${tokens.failD};

    --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;

    /* The HUD's one shape: a notched corner, cut rather than rounded. */
    --notch: polygon(0 9px, 9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%);
    --notch-sm: polygon(0 6px, 6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%);

    /* One motion duration. Anything outside it is a decision to argue for. */
    --quick: .16s;
  }

  * { box-sizing: border-box; }

  html { background: var(--void); }

  body {
    margin: 0;
    padding: 1.6rem 1.5rem 3rem;
    color: var(--ink);
    font: 14px/1.55 var(--sans);
    -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(1100px 620px at 20% -12%, #0f1c25 0%, transparent 62%),
      repeating-linear-gradient(0deg, rgba(79,214,232,.028) 0 1px, transparent 1px 44px),
      repeating-linear-gradient(90deg, rgba(79,214,232,.028) 0 1px, transparent 1px 44px),
      var(--void);
    background-attachment: fixed;
  }

  main { max-width: 74rem; margin: 0 auto; }

  /* ── type ────────────────────────────────────────────────── */

  h1 {
    font: 400 19px/1.35 var(--sans);
    margin: 0 0 .9rem;
    max-width: 54ch;
    text-wrap: balance;
  }

  /* Section labels are the HUD's voice: monospace, tracked, quiet. */
  h2 {
    font: 600 10px/1 var(--mono);
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 1.9rem 0 .65rem;
  }

  h3 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font: 600 10px/1 var(--mono);
    letter-spacing: .16em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 0 0 .6rem;
    padding-bottom: .45rem;
    border-bottom: 1px solid var(--line);
  }

  code, pre, .mono { font-family: var(--mono); font-size: .86em; }

  /* Wherever digits line up, they line up. */
  .bar, .strip, .log, .task .meta, h3 { font-variant-numeric: tabular-nums; }

  ul { margin: .2rem 0; padding-left: 1.1rem; }
  li { margin: .3rem 0; }

  /* ── the status bar ──────────────────────────────────────── */

  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: .4rem 1.4rem;
    font: 11px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--faint);
    border-bottom: 1px solid var(--line);
    padding-bottom: 1rem;
  }
  .bar strong { color: var(--live); font-weight: 600; }

  /* ── panels ──────────────────────────────────────────────── */

  /* The hairline is an inset shadow, not a border, because clip-path cuts a border
     off along with the corner it removes. The shadow is clipped the same way, which
     leaves the four straight edges drawn and the diagonal bare — and a bare diagonal
     is what makes the corner read as *cut* rather than bevelled. Every notched
     surface here uses that pair. Do not reintroduce a border alongside a clip-path. */
  .card {
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line);
    clip-path: var(--notch);
    padding: .95rem 1.1rem;
    margin-bottom: .6rem;
  }

  .card.warn {
    background: var(--attn-bg);
    box-shadow: inset 0 0 0 1px var(--attn-d);
  }
  .card.warn > strong {
    display: block;
    font: 600 10px/1 var(--mono);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--attn);
    margin-bottom: .5rem;
  }

  .scroll { overflow-x: auto; }

  /* ── semantic colour ─────────────────────────────────────── */

  .ok { color: var(--met); }
  .bad { color: var(--fail); }
  .quiet { color: var(--faint); }
  .id { color: var(--faint); font-family: var(--mono); font-size: .86em; letter-spacing: .06em; }

  /* ── criteria ────────────────────────────────────────────── */

  .crit { margin: 0 0 .85rem; line-height: 1.5; }
  .crit:last-child { margin-bottom: 0; }
  .check {
    color: var(--faint);
    font: 11px/1.45 var(--mono);
    word-break: break-word;
  }

  /* ── the ledger strip ────────────────────────────────────── */

  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: .35rem 1.3rem;
    font: 11px/1.6 var(--mono);
    letter-spacing: .06em;
    color: var(--dim);
    margin: .2rem 0 .4rem;
  }

  /* ── the board ───────────────────────────────────────────── */

  .board {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: .55rem;
    align-items: start;
  }
  .col { min-width: 0; }

  .task {
    position: relative;
    overflow: hidden;
    padding: .6rem .7rem;
    margin-bottom: .45rem;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ink-2);
    cursor: pointer;
    word-break: break-word;
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line);
    clip-path: var(--notch-sm);
    transition: box-shadow var(--quick), background var(--quick);
  }
  .task:hover { box-shadow: inset 0 0 0 1px var(--line-2); background: var(--raise); }
  .task:focus-visible { outline: 2px solid var(--live); outline-offset: 1px; }
  .task .meta {
    margin-top: .4rem;
    font: 10px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--faint);
  }

  /* Glow is state. A running task is the only thing on the board that moves. */
  .task-running {
    box-shadow: inset 0 0 0 1px var(--live-d);
    background: var(--run-bg);
    color: var(--ink);
  }
  .task-running::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, rgba(79,214,232,.13), transparent);
    animation: scan 3.4s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes scan {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  .task-blocked { box-shadow: inset 0 0 0 1px var(--attn-d); background: var(--attn-bg); color: var(--ink); }
  .task-done, .task-cancelled { opacity: .6; }
  .task-done:hover, .task-cancelled:hover { opacity: 1; }
  .task-failed, .task-conflicted { box-shadow: inset 0 0 0 1px var(--fail-d); }

  /* ── the why panel ───────────────────────────────────────── */

  .why dt {
    font: 600 10px/1 var(--mono);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--dim);
    margin-top: .9rem;
  }
  .why dt:first-child { margin-top: 0; }
  .why dd { margin: .3rem 0 0; color: var(--ink-2); }

  /* ── the timeline ────────────────────────────────────────── */

  .log {
    max-height: 17rem;
    overflow-y: auto;
    padding: .7rem .9rem;
    background: var(--sink);
    box-shadow: inset 0 0 0 1px var(--line);
    clip-path: var(--notch);
  }
  .log div {
    font: 11.5px/1.7 var(--mono);
    color: var(--dim);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── controls ────────────────────────────────────────────── */

  .row {
    display: flex;
    gap: .55rem;
    align-items: center;
    flex-wrap: wrap;
    margin-top: .8rem;
  }
  .row > input { flex: 1 1 16rem; }

  button {
    font: 600 11px/1 var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
    padding: .62rem 1.1rem;
    cursor: pointer;
    color: var(--ink-2);
    background: var(--raise);
    box-shadow: inset 0 0 0 1px var(--line-2);
    clip-path: var(--notch-sm);
    transition: color var(--quick), background var(--quick), box-shadow var(--quick);
  }
  button:hover { color: var(--live); box-shadow: inset 0 0 0 1px var(--live-d); background: var(--hover-bg); }
  button:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
  button:disabled { opacity: .45; cursor: default; }
  button:disabled:hover { color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line-2); background: var(--raise); }

  /* The one button that is the obvious one. Never used in the inbox, where §11 says
     nothing may be the control you tap through without reading. */
  button.primary {
    color: var(--void);
    background: var(--live);
    box-shadow: inset 0 0 0 1px var(--live);
  }
  button.primary:hover { background: color-mix(in srgb, var(--live) 78%, white); color: var(--void); }

  input, textarea {
    font: 13px/1.5 var(--sans);
    width: 100%;
    padding: .55rem .7rem;
    color: var(--ink);
    background: var(--sink);
    border: 1px solid var(--line);
    resize: vertical;
  }
  input::placeholder, textarea::placeholder { color: var(--faint); }
  input:focus, textarea:focus {
    outline: none;
    border-color: var(--live-d);
    background: var(--hover-bg);
  }
  input:focus-visible, textarea:focus-visible { outline: 2px solid var(--live); outline-offset: 1px; }

  /* ── motion, and the right to switch it off ──────────────── */

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
    }
  }

  /* ── narrow ──────────────────────────────────────────────── */

  @media (max-width: 1100px) {
    .board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    body { padding: 1.1rem .9rem 2.5rem; }
    .board { grid-template-columns: minmax(0, 1fr); }
  }
`;

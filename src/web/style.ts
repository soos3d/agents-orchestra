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

    /* Two motion durations, and no third. --quick is a control answering a pointer;
       --settle is a panel arriving, which has to be slower than a hover to read as
       assembly and faster than a blink to stay out of the way. */
    --quick: .16s;
    --settle: .28s;
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

  /* The run view is an instrument panel and wants the screen; everything else is
     reading matter and wants a measure. One selector rather than a class toggled from
     the app, because which screen is showing is Screen's decision and nothing else
     should have to know it. */
  main:has(.hud) { max-width: 112rem; }

  /* The single-column screens — briefing, sign-off, intake — keep the narrow measure
     even on a wide window. A contract set 110rem wide is a contract nobody finishes. */
  .column { max-width: 54rem; }

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

  /* ── the crown, and the status core ──────────────────────── */

  /* The one line that is in the same place on every mission screen: back, what the
     mission is doing, what it is. The core comes before the goal because it is the
     thing being glanced at — the goal is what you read once. */
  .crown {
    display: flex;
    align-items: center;
    gap: .9rem;
    margin-bottom: 1.1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }
  .crown h1 { margin: 0; flex: 1 1 auto; min-width: 0; }
  button.back { padding: .55rem .8rem; flex: none; }

  .core { display: flex; align-items: center; gap: .6rem; flex: none; }

  /* The ring: a hairline circle with one bright arc, so that rotating it is visible
     and standing still is unremarkable. It is 20px because it sits beside a 19px
     heading and must not out-shout it. */
  .core-ring {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--line-2);
    border-top-color: var(--dim);
    flex: none;
  }
  .core-spin .core-ring { animation: turn 1.9s linear infinite; }
  @keyframes turn { to { transform: rotate(360deg); } }

  .core-text {
    display: flex;
    flex-direction: column;
    gap: .1rem;
    font: 11px/1.25 var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .core-text strong { font-weight: 600; color: var(--ink-2); }
  .core-detail { color: var(--faint); letter-spacing: .06em; }

  /* Tone is the core's whole vocabulary, and there are four words in it. */
  .core-live .core-ring { border-top-color: var(--live); box-shadow: 0 0 10px rgba(79,214,232,.35); }
  .core-live .core-text strong { color: var(--live); }
  .core-attn .core-ring { border-color: var(--attn-d); border-top-color: var(--attn); }
  .core-attn .core-text strong { color: var(--attn); }
  .core-met .core-ring { border-top-color: var(--met); }
  .core-met .core-text strong { color: var(--met); }
  .core-fail .core-ring { border-color: var(--fail-d); border-top-color: var(--fail); }
  .core-fail .core-text strong { color: var(--fail); }

  /* ── the three rails ─────────────────────────────────────── */

  /* What the mission is, what it is doing, what it wants from you. The side rail is
     the one that earns the layout: an inbox at the foot of a growing page is an inbox
     a person scrolls past. */
  .hud {
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr) 20rem;
    gap: 1.4rem;
    align-items: start;
  }
  .rail { min-width: 0; }

  /* Both side rails stay put while the middle scrolls. The pause button and the
     pending permission are the two things that must never be somewhere else. */
  .rail-left, .rail-side {
    position: sticky;
    top: 1.2rem;
    max-height: calc(100vh - 2.4rem);
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .rail-left > * + * { margin-top: 1.2rem; }
  .rail-side h2:first-child { margin-top: 0; }

  /* ── the vitals ──────────────────────────────────────────── */

  .vitals { margin: 0; display: grid; gap: .45rem; }
  .vital {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: .6rem;
    padding-bottom: .4rem;
    border-bottom: 1px solid var(--line);
  }
  .vital dt {
    font: 600 10px/1 var(--mono);
    letter-spacing: .16em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .vital dd {
    margin: 0;
    font: 13px/1 var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .tone-met { color: var(--met); }
  .tone-attn { color: var(--attn); }
  .tone-fail { color: var(--fail); }

  /* ── the pane tabs ───────────────────────────────────────── */

  .tabs { display: grid; gap: .35rem; }
  .tab {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .6rem;
    width: 100%;
    text-align: left;
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .tab-on {
    color: var(--live);
    background: var(--run-bg);
    box-shadow: inset 0 0 0 1px var(--live-d);
  }
  .tab-badge {
    font-variant-numeric: tabular-nums;
    letter-spacing: .04em;
    color: var(--faint);
  }
  .tab-on .tab-badge { color: var(--live); }

  /* ── steering ────────────────────────────────────────────── */

  /* Always available, never the next thing to do — which is why panic is an ordinary
     button. A control that looks urgent gets pressed when nothing is urgent. */
  .controls .row { margin-top: .5rem; }
  .controls .row > button { flex: 1 1 auto; padding-inline: .7rem; }

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

  /* Panel assembly (UI plan U7). It plays when the element is *created*, which under a
     vdom means when the panel is genuinely new — the innerHTML page could not have had
     this, because there every panel was new forty times a minute. So a panel sliding
     into place is information: something arrived. Nothing re-plays on an update. */
  .card, .task, .log { animation: assemble var(--settle) ease-out both; }
  @keyframes assemble {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: none; }
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

  /* The selected workspace (UI plan U4). Cyan means live, so a *chosen* row is
     drawn with the ink hairline and a lifted ground rather than with the accent —
     picking a directory is not a mission running in it. */
  .card.chosen {
    background: var(--raise);
    box-shadow: inset 0 0 0 1px var(--line-2);
  }
  .card.chosen > strong { color: var(--ink); }

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

  /* The board under load (UI plan U7). Each column scrolls on its own rather than
     growing the page: on a forty-task mission the running column stays where the eye
     left it while done fills up beneath a header that does not move. An empty column
     is still drawn — a board that reflows as tasks move is one you re-read every
     round. */
  .col h3 {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    padding: .1rem 0 .45rem;
    background: var(--void);
  }
  .col-cards {
    max-height: calc(100vh - 12rem);
    overflow-y: auto;
    scrollbar-width: thin;
    padding-top: .5rem;
  }
  .col h3 .count { color: var(--ink-2); }

  /* The card the why panel is about. Ink, not accent: reading a task is not a task
     running. */
  .task-on { box-shadow: inset 0 0 0 1px var(--line-2); background: var(--raise); }
  .task-running.task-on { box-shadow: inset 0 0 0 1px var(--live); }

  /* ── the outcome, beside the board ───────────────────────── */

  /* Marks and statements, no check lines: whether the mission is winning belongs in
     sight of the board, and how each criterion is checked is in the contract pane. */
  .verdict { margin: 0 0 .6rem; line-height: 1.45; }
  .verdict:last-child { margin-bottom: 0; }

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

  /* ── the briefing (UI plan U5) ───────────────────────────── */

  /* A trail, drawn as a rail with a mark per stage. It only appends, so nothing here
     reflows when a stage lands and the approve button below never moves under a
     pointer that was already travelling toward it. */
  .briefing {
    list-style: none;
    margin: .2rem 0 1.1rem;
    padding: 0 0 0 .1rem;
  }

  .stage {
    display: grid;
    grid-template-columns: 1.2rem minmax(0, auto) minmax(0, 1fr);
    gap: 0 .7rem;
    align-items: baseline;
    padding: .3rem 0;
    line-height: 1.5;
  }

  .stage-mark { font-family: var(--mono); font-size: .85em; color: var(--faint); }
  .stage-label { color: var(--ink-2); }
  .stage-detail {
    font: 11px/1.6 var(--mono);
    letter-spacing: .04em;
    color: var(--faint);
    overflow-wrap: anywhere;
  }

  .stage-done .stage-mark { color: var(--met); }
  .stage-waiting { opacity: .42; }

  /* Glow is state, here as on the board: the stage in flight is the only row that
     moves, and briefing() guarantees there is exactly one of it. */
  .stage-running .stage-mark { color: var(--live); animation: pulse 2.2s ease-in-out infinite; }
  .stage-running .stage-label { color: var(--ink); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .35; }
  }

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
  /* As a pane it fills the rail: 17rem of log inside a screen of empty rail is the
     shape the timeline had when it lived under the board, and it was wrong there too. */
  .rail-main > .log { max-height: calc(100vh - 11rem); }

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

  /* A checkbox is not a text field, and the width rule above stretches one across the
     whole row. Its label is the click target and reads as a control rather than as
     prose, which is what keeps the plan-only toggle from looking like a caption. */
  .row > label {
    display: flex;
    align-items: center;
    gap: .45rem;
    font: 11px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--ink-2);
    white-space: nowrap;
    cursor: pointer;
  }
  input[type="checkbox"] {
    width: auto;
    flex: none;
    accent-color: var(--live);
    cursor: pointer;
  }

  /* ── motion, and the right to switch it off ──────────────── */

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
    }
  }

  /* ── narrow ──────────────────────────────────────────────── */

  /* The rails collapse in a deliberate order: what wants a human first, then the
     board, then the counters and the controls. On a phone the side rail is the whole
     reason to have opened the page. Sticky is dropped with them — a sticky rail in a
     single column is a panel that covers the one below it. */
  @media (max-width: 1200px) {
    .hud { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    .rail-left, .rail-side {
      position: static;
      max-height: none;
      overflow: visible;
    }
    .rail-side { order: 1; }
    .rail-main { order: 2; }
    .rail-left { order: 3; }
    .rail-left > * + * { margin-top: 1rem; }
    .tabs { grid-auto-flow: column; grid-auto-columns: 1fr; }
    .board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .col-cards { max-height: none; }
  }
  @media (max-width: 640px) {
    body { padding: 1.1rem .9rem 2.5rem; }
    .board { grid-template-columns: minmax(0, 1fr); }
    .crown { flex-wrap: wrap; }
  }
`;

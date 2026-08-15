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
// **One accent.** --live (cyan) means *running*, and nothing else is allowed to use
// it. --met, --attn and --fail are semantic and stay off the accent, so a glow
// always means one thing. --fail is rationed to panic and failure — a surface that
// approves payments cannot afford cheap alarm colour.
//
// **Ambience and state are two vocabularies, and the split is load-bearing.** This
// page is a deep field with lit instruments on it, so there is atmosphere here that no
// event caused: the bloom behind the panels, the hairline threads between nodes, the
// outer orbit's 90-second drift. All of it is desaturated, none of it is fast, and it
// is deliberately below the threshold at which movement reads as news. What state
// keeps for itself is the other half — full-strength --live, the 3.4s scan across a
// running task, the 2.2s pulse, the turning sweep. If something idle ever moves as
// fast or as brightly as something running, the glow has stopped meaning anything and
// the change is a regression however good it looks. All of it stops under
// prefers-reduced-motion.
//
// **The display face is Chakra Petch**, served from this process at --font-route (see
// fonts.ts; the literal below is asserted against FONT_ROUTE in style.test.ts). It is
// here rather than a neutral grotesk because its terminals are clipped at the same
// angle as --notch, the shape this panel was already built out of — the type is
// derived from the design language instead of applied over it. It sets the wordmark,
// section headings and the core's readout, and nothing else: ids, paths and telemetry
// stay monospace, because they are data and the eye needs them to line up.
import { tokens } from "./tokens.js";

export const pageStyle = `
  @font-face {
    font-family: "Chakra Petch";
    font-style: normal;
    font-weight: 600;
    font-display: swap;
    src: url("/display.woff2") format("woff2");
  }

  :root {
    /* Every colour here comes from tokens.ts, where tokens.test.ts asserts that
       each text colour clears WCAG AA on each surface. Do not inline a hex below —
       an untested colour is how the check line ended up at 2.2:1. */
    --abyss: ${tokens.abyss};
    --deep: ${tokens.deep};
    --void: ${tokens.void};
    --sink: ${tokens.sink};
    --panel: ${tokens.panel};
    --raise: ${tokens.raise};
    --run-bg: ${tokens.runBg};
    --hover-bg: ${tokens.hover};
    --line: ${tokens.line};
    --line-2: ${tokens.line2};
    --thread: ${tokens.thread};
    --bloom: ${tokens.bloom};

    --core: ${tokens.core};
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

    --display: "Chakra Petch", ui-sans-serif, system-ui, sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;

    /* The scale, so a size is chosen from a list rather than typed. Six steps and no
       seventh: the page had three before, and everything on it looked equally
       important because everything on it very nearly was. */
    --t-mark: 27px;
    --t-lead: 21px;
    --t-goal: 16px;
    --t-body: 14px;
    --t-data: 12px;
    --t-label: 10px;

    /* The HUD's one shape: a notched corner, cut rather than rounded. */
    --notch: polygon(0 9px, 9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%);
    --notch-sm: polygon(0 6px, 6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%);

    /* A clipped element cannot carry an outer box-shadow — clip-path removes it along
       with the corner. drop-shadow is applied after the clip, so it is the only way a
       notched panel gets a halo. Rationed to the panels a person reads, never to the
       forty cards on a board. */
    --lift: drop-shadow(0 0 16px rgba(42, 111, 140, .16));

    /* Two motion durations, and no third. --quick is a control answering a pointer;
       --settle is a panel arriving, which has to be slower than a hover to read as
       assembly and faster than a blink to stay out of the way. --drift is the third
       thing only in the sense that a tide is: nothing that uses it is an event. */
    --quick: .16s;
    --settle: .28s;
    --drift: 90s;
  }

  * { box-sizing: border-box; }

  html { background: var(--abyss); }

  body {
    margin: 0;
    padding: 1.6rem 1.5rem 3rem;
    color: var(--ink);
    font: var(--t-body)/1.55 var(--sans);
    -webkit-font-smoothing: antialiased;
    position: relative;
    z-index: 0;
    background:
      repeating-linear-gradient(0deg, rgba(79,214,232,.022) 0 1px, transparent 1px 44px),
      repeating-linear-gradient(90deg, rgba(79,214,232,.022) 0 1px, transparent 1px 44px),
      transparent;
    background-attachment: fixed;
  }

  /* The field. Two blooms — cyan low on the left, indigo high on the right — over the
     abyss, so the page reads as depth rather than as a dark rectangle. Fixed and
     behind everything, and it is the one layer allowed to move without an event: a
     90-second rotation, far too slow to catch an eye that is not already resting. */
  body::before {
    content: "";
    position: fixed;
    inset: -30%;
    z-index: -2;
    pointer-events: none;
    background:
      radial-gradient(46% 40% at 32% 30%, rgba(42,111,140,.30) 0%, transparent 70%),
      radial-gradient(40% 36% at 68% 24%, rgba(58,54,152,.26) 0%, transparent 72%),
      radial-gradient(60% 50% at 50% 88%, rgba(10,13,30,.90) 0%, transparent 70%);
    animation: drift var(--drift) linear infinite;
  }

  /* The vignette, which is what keeps the blooms from washing the corners out. */
  body::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(120% 100% at 50% 30%, transparent 40%, rgba(3,5,11,.85) 100%);
  }

  @keyframes drift { to { transform: rotate(360deg); } }

  main { max-width: 74rem; margin: 0 auto; }

  /* The run view is an instrument panel and wants the screen; everything else is
     reading matter and wants a measure. One selector rather than a class toggled from
     the app, because which screen is showing is Screen's decision and nothing else
     should have to know it. */
  main:has(.hud) { max-width: 112rem; }
  main:has(.deck) { max-width: 94rem; }

  /* The single-column screens — briefing, sign-off, intake — keep the narrow measure
     even on a wide window. A contract set 110rem wide is a contract nobody finishes. */
  .column { max-width: 54rem; }

  /* And the page narrows with them, so the crown sits over the column rather than
     spanning a width nothing under it uses. The :not is load-bearing: the contract
     *pane* is a column too, and narrowing the whole run view to 54rem because
     somebody opened it would collapse the board behind them. */
  main:has(.column):not(:has(.hud)) { max-width: 54rem; }

  /* ── type ────────────────────────────────────────────────── */

  h1 {
    font: 400 var(--t-goal)/1.4 var(--sans);
    margin: 0 0 .9rem;
    max-width: 54ch;
    text-wrap: balance;
  }

  /* The wordmark, and the only place the display face is set large. */
  .mark {
    font: 600 var(--t-mark)/1 var(--display);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--ink);
    margin: 0 0 .2rem;
  }
  .mark span { color: var(--live); }

  /* Section labels are the HUD's voice: monospace, tracked, quiet. Data, not display —
     the face that sets them is the one the ids and the paths are set in. */
  h2 {
    font: 600 var(--t-label)/1 var(--mono);
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--dim);
    margin: 1.9rem 0 .65rem;
  }

  h3 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font: 600 var(--t-label)/1 var(--mono);
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
     and standing still is unremarkable. It is 20px because it sits beside the goal
     and must not out-shout it. */
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

  /* ── the deck: home ──────────────────────────────────────── */

  /* Home is a rail and a deck, for the same reason the run view is three rails: the
     page had five stacked sections of identical weight, and the two things a person
     opens it to do — start a mission, open the one that is running — were in the
     middle of them with no more emphasis than the doctor report. The rail holds what
     is true of the machine; the deck holds what a person came to do. */
  .deck {
    display: grid;
    grid-template-columns: 17rem minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }

  /* The hero: the mission field beside the console that starts one. */
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 19rem) minmax(0, 1fr);
    gap: 1.6rem;
    align-items: center;
    padding: 1.2rem 1.3rem;
  }
  .hero-title {
    font: 600 var(--t-lead)/1.25 var(--display);
    letter-spacing: .02em;
    margin: 0 0 .35rem;
    color: var(--ink);
  }
  .hero p { margin: 0 0 .8rem; color: var(--ink-2); }
  .hero-eyebrow { margin-top: 0; }
  .hero-figure { display: flex; justify-content: center; }

  /* The map pane. The figure is capped rather than filling a 60rem rail: past about a
     screen's height the nodes stop being one object and start being a wall chart. */
  .map { display: flex; justify-content: center; padding-top: 1rem; }
  .map .orrery-wrap { max-width: 32rem; }

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
  .rail-left > h2:first-child, .rail-main > h2:first-child { margin-top: 0; }

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
    font: 600 var(--t-label)/1 var(--mono);
    letter-spacing: .16em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .vital dd {
    margin: 0;
    font: 600 13px/1 var(--display);
    letter-spacing: .04em;
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
    filter: var(--lift);
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
    font: 600 var(--t-label)/1 var(--mono);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--attn);
    margin-bottom: .5rem;
  }

  .card.chosen {
    background: var(--raise);
    box-shadow: inset 0 0 0 1px var(--line-2);
  }

  .scroll { overflow-x: auto; }

  /* ── semantic colour ─────────────────────────────────────── */

  .ok { color: var(--met); }
  .bad { color: var(--fail); }
  .quiet { color: var(--faint); }
  .id { color: var(--faint); font-family: var(--mono); font-size: .86em; letter-spacing: .06em; }

  /* ── the rail's own rows ─────────────────────────────────── */

  /* A workspace is a row, not a card. It was a card with a paragraph and a button
     inside it, three times over, which is how the directory picker came to be the
     tallest thing on the page. It is also a button now rather than a clickable div:
     choosing a workspace is a control and has to be reachable from a keyboard. */
  .ws-row { display: flex; gap: .3rem; margin-bottom: .35rem; }
  .ws-x {
    flex: none;
    padding: .5rem .55rem;
    font-size: 13px;
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--faint);
  }

  .ws {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    text-align: left;
    padding: .5rem .65rem;
    font: var(--t-data)/1.4 var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink-2);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .ws-path {
    display: block;
    color: var(--faint);
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .ws-name { display: block; color: var(--ink); word-break: break-all; }
  .ws-note { display: block; color: var(--faint); font-size: 10px; letter-spacing: .06em; }
  .ws-on { background: var(--raise); box-shadow: inset 0 0 0 1px var(--line-2); }
  /* A directory holding a running mission is the one row on this rail that is live. */
  .ws-busy .ws-note { color: var(--live); }

  /* The readiness summary. The full doctor report is nine rows and it was permanently
     open at the foot of the page; what a person needs at a glance is whether this
     machine can dispatch anything, and the nine rows are one click under it. Hidden,
     never dropped — every check still carries the thing to type (§2a rule 5). */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    font: 600 var(--t-label)/1 var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--met);
  }
  .pill-bad { color: var(--attn); }

  /* A disclosure, for the controls that are rare rather than unimportant: adding a
     directory, saving a mission under a name. */
  .fold { margin: .4rem 0 .8rem; }
  .fold > summary {
    cursor: pointer;
    list-style: none;
    font: 600 var(--t-label)/1 var(--mono);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--dim);
    padding: .35rem 0;
  }
  .fold > summary::-webkit-details-marker { display: none; }
  .fold > summary::before { content: "▸ "; color: var(--faint); }
  .fold[open] > summary::before { content: "▾ "; }
  .fold > summary:hover { color: var(--live); }
  .fold > summary:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }

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
  .task-role {
    margin-top: .3rem;
    font: 600 11px/1.3 var(--display);
    letter-spacing: .06em;
    color: var(--ink);
  }
  .task-goal {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-top: .15rem;
  }
  .task .meta {
    margin-top: .4rem;
    font: var(--t-label)/1 var(--mono);
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

  /* ── the missions list ───────────────────────────────────── */

  /* One row per mission, with the actions on it rather than under it in two rows of
     their own. The running one is the row that is lit, and it is the row the hero is
     about. */
  .mission {
    display: flex;
    align-items: baseline;
    gap: .8rem;
    flex-wrap: wrap;
    padding: .7rem .9rem;
    margin-bottom: .4rem;
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line);
    clip-path: var(--notch-sm);
  }
  .mission-goal { flex: 1 1 18rem; min-width: 0; color: var(--ink); }
  .mission-meta {
    font: 11px/1.5 var(--mono);
    letter-spacing: .06em;
    color: var(--faint);
    word-break: break-all;
  }
  .mission .row { margin-top: 0; }
  .mission-live { box-shadow: inset 0 0 0 1px var(--live-d); background: var(--run-bg); }
  .mission-live .mission-meta { color: var(--live); }

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

  /* ── the orrery ──────────────────────────────────────────── */

  /* The figure a mission can be read from across a desk: angle is plan order, radius
     is lifecycle, so work falls inward as it finishes. Geometry is orrery.ts's — what
     is here is only what each part is made of.

     The whole ambience/state split is visible in this block. An orbit is a hairline
     and the outer one drifts once every ninety seconds; a thread is --thread, which
     is dark enough to read as structure. What is live is drawn in --live at full
     strength and is the only thing that moves at a rate anybody notices. */
  .orrery-wrap {
    margin: 0;
    display: grid;
    justify-items: center;
    gap: .5rem;
    width: 100%;
    max-width: 21rem;
  }
  .orrery { width: 100%; height: auto; display: block; overflow: visible; }

  /* The readout, under the figure. The core is a light source and holds no text: a
     status is whatever the record says, and no circle 54px across holds the word
     awaiting_signoff. */
  .orrery-read { display: grid; justify-items: center; gap: .15rem; text-align: center; }
  .orrery-read strong {
    font: 600 15px/1.2 var(--display);
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--ink-2);
  }
  .orrery-read span {
    font: 10px/1.3 var(--mono);
    letter-spacing: .08em;
    color: var(--faint);
  }
  .orrery-live .orrery-read strong { color: var(--live); }
  .orrery-attn .orrery-read strong { color: var(--attn); }
  .orrery-met .orrery-read strong { color: var(--met); }
  .orrery-fail .orrery-read strong { color: var(--fail); }

  .orbit { fill: none; stroke: var(--line); stroke-width: 1; }
  .orbit-drift {
    stroke: var(--thread);
    stroke-dasharray: 2 9;
    transform-box: view-box;
    transform-origin: center;
    animation: turn var(--drift) linear infinite;
  }

  .thread { fill: none; stroke: var(--thread); stroke-width: 1; }
  .thread-on {
    stroke: var(--live);
    stroke-opacity: .5;
    stroke-dasharray: 4 6;
    animation: flow 2.6s linear infinite;
  }
  @keyframes flow { to { stroke-dashoffset: -20; } }

  /* The core is a light source, not a hole. A parked mission dims it rather than
     switching it off — at .25 it read as a black disc punched in the middle of the
     rings, which is the opposite of what a core is. */
  .core-shell { fill: none; stroke: var(--line-2); stroke-width: 1; }
  .core-halo { opacity: .5; }
  .orrery-live .core-halo { opacity: 1; }
  .core-sweep {
    fill: none;
    stroke: var(--line-2);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-dasharray: 26 400;
    transform-box: view-box;
    transform-origin: center;
  }
  .orrery-spin .core-sweep { animation: turn 2.6s linear infinite; }
  .orrery-live .core-sweep { stroke: var(--live); }
  .orrery-attn .core-sweep { stroke: var(--attn); }
  .orrery-met .core-sweep { stroke: var(--met); }
  .orrery-fail .core-sweep { stroke: var(--fail); }

  .orb { cursor: pointer; outline: none; }
  .orb-dot { fill: var(--faint); transition: fill var(--quick); }
  .orb-halo { fill: none; }
  .orb-label {
    fill: var(--faint);
    font: 9px var(--mono);
    letter-spacing: .06em;
    text-anchor: middle;
    opacity: 0;
    transition: opacity var(--quick);
  }
  .orb:hover .orb-label, .orb:focus-visible .orb-label, .orb-on .orb-label, .orb-picked .orb-label {
    opacity: 1;
  }
  .orb-live .orb-dot { fill: var(--live); }
  .orb-live .orb-halo { fill: rgba(79,214,232,.16); }
  .orb-met .orb-dot { fill: var(--met); }
  .orb-attn .orb-dot { fill: var(--attn); }
  .orb-attn .orb-halo { fill: rgba(240,168,48,.16); }
  .orb-fail .orb-dot { fill: var(--fail); }
  .orb-on .orb-halo { animation: breathe 3.2s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: .35; transform: scale(1.25); }
  }
  .orb-on { transform-box: fill-box; transform-origin: center; }
  .orb-picked .orb-dot { stroke: var(--ink); stroke-width: 1.5; }
  .orb:focus-visible .orb-halo { fill: none; stroke: var(--live); stroke-width: 2; }

  /* ── the task dossier ────────────────────────────────────── */

  /* A synthesized goal is a two-thousand character specification and a system prompt is
     several times that. Both used to be dumped into a 20rem rail, which is how the
     panel that answers "what is this agent doing" became a wall of text that did not
     contain the agent. Three rules here, and each one is a shape rather than a colour:
     the rail clamps, the pane is as wide as the board, and the prompt is folded. */

  .dossier > h2:first-child { margin-top: 0; }

  /* pre-wrap, because a numbered specification's only structure is its line breaks. */
  .spec {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.6;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .spec-list { margin: .6rem 0 0; padding-left: 1.1rem; color: var(--ink-2); }

  /* Clamped in CSS rather than sliced in JS: what is on screen is the real string, so
     it can still be selected and copied out of the rail. */
  .clamp {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: .5rem 0 0;
    color: var(--ink-2);
  }

  .agent-line {
    margin: 0;
    font: 600 10px/1.4 var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--ink);
  }

  /* The spec sheet: label and value, hairline between, nothing centred. It is a table
     of facts and it is read down the left edge. */
  .sheet { margin: 0; display: grid; gap: .45rem; }
  .sheet-row {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr);
    gap: .1rem .9rem;
    align-items: baseline;
    padding-bottom: .4rem;
    border-bottom: 1px solid var(--line);
  }
  .sheet-row:last-child { padding-bottom: 0; border-bottom: 0; }
  .sheet dt {
    font: 600 var(--t-label)/1.5 var(--mono);
    letter-spacing: .16em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .sheet dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }

  /* A capability list is scanned for one entry, never read as a sentence — so tools and
     lease globs are chips and not a comma string. */
  .chips { display: flex; flex-wrap: wrap; gap: .3rem; }
  .chip {
    padding: .1rem .45rem;
    font-size: 11px;
    color: var(--ink-2);
    background: var(--sink);
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .prompt {
    max-height: 26rem;
    overflow: auto;
    scrollbar-width: thin;
    margin: .3rem 0 .9rem;
    padding: .8rem .9rem;
    background: var(--sink);
    box-shadow: inset 0 0 0 1px var(--line);
    clip-path: var(--notch);
    font: 11.5px/1.7 var(--mono);
    color: var(--dim);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── the why panel ───────────────────────────────────────── */

  .why dt {
    font: 600 var(--t-label)/1 var(--mono);
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

  /* A reading column in a rail wider than one sits in the middle of it rather than
     against its left edge, which is where the contract and the dossier were reading as
     a page that had failed to lay out. */
  .rail-main > .column { margin-inline: auto; }

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
    border: 0;
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

  /* The compose box is the page's one primary input and is set larger than the rest,
     because what a person types into it is the whole mission. */
  textarea#compose-goal { font-size: var(--t-goal); line-height: 1.45; padding: .7rem .8rem; }

  /* A checkbox is not a text field, and the width rule above stretches one across the
     whole row. Its label is the click target and reads as a control rather than as
     prose, which is what keeps the plan-only toggle from looking like a caption. */
  .row > label, .toggles > label {
    display: flex;
    align-items: center;
    gap: .45rem;
    font: 11px/1.35 var(--mono);
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--ink-2);
    cursor: pointer;
  }
  .row > label { white-space: nowrap; }
  /* The two mission flags, stacked rather than crammed into the row with the budget
     and the start button. Each is a sentence, and four controls on one line made all
     four unreadable. */
  .toggles { display: grid; gap: .4rem; margin: .7rem 0 0; }
  .toggles .quiet { text-transform: none; letter-spacing: 0; font-family: var(--sans); }
  /* A native checkbox on a dark page is a white square, which made the two mission
     flags the brightest thing on the screen — brighter than the accent, for a control
     that is off. Drawn instead: an empty notched box, filled with the accent when it
     is on. */
  input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 15px;
    height: 15px;
    flex: none;
    padding: 0;
    background: var(--sink);
    border: 0;
    box-shadow: inset 0 0 0 1px var(--line-2);
    clip-path: polygon(0 4px, 4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%);
    cursor: pointer;
    transition: background var(--quick), box-shadow var(--quick);
  }
  input[type="checkbox"]:hover { box-shadow: inset 0 0 0 1px var(--live-d); }
  input[type="checkbox"]:checked {
    background: var(--live);
    box-shadow: inset 0 0 0 1px var(--live);
  }
  input[type="checkbox"]:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }

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
  /* Home collapses one step earlier than the run view: the deck's own two columns are
     a console and a figure, and a console 20rem wide is not one. */
  @media (max-width: 1000px) {
    .deck { grid-template-columns: minmax(0, 1fr); }
    .hero { grid-template-columns: minmax(0, 1fr); }
    .hero-figure { order: -1; }
  }
  @media (max-width: 640px) {
    body { padding: 1.1rem .9rem 2.5rem; }
    .sheet-row { grid-template-columns: minmax(0, 1fr); }
    .board { grid-template-columns: minmax(0, 1fr); }
    .crown { flex-wrap: wrap; }
    .mark { font-size: var(--t-lead); }
  }
`;

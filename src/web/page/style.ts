// The page's stylesheet, as a string fragment of the shell.
//
// Split out of `shell.html.ts` when Phase 6 grew the page past one screen: the file
// limit is a project rule, and a thousand-line template literal is the thing it
// exists to prevent. Still a string and still no bundler — the fragments are
// concatenated by `shellHtml()` at request time, which keeps §2a's one-process,
// no-build-step constraint exactly where it was.
export const pageStyle = `
  :root {
    --bg: #fbfbfa; --fg: #1a1a18; --dim: #6b6b64; --line: #e0e0d8;
    --card: #ffffff; --warn: #8a5a00; --warn-bg: #fdf6e3; --accent: #1f5fa8;
    --ok: #2c7a3d; --bad: #a83232;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --fg: #e8e8e3; --dim: #9a9a92; --line: #2e2e34;
      --card: #1d1d22; --warn: #e0b354; --warn-bg: #2a2317; --accent: #7fb0e8;
      --ok: #6fc482; --bad: #e07a7a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  h2 { font-size: .78rem; letter-spacing: .09em; text-transform: uppercase;
       color: var(--dim); margin: 1.5rem 0 .5rem; font-weight: 600; }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  .bar { display: flex; flex-wrap: wrap; gap: .4rem 1.1rem; color: var(--dim);
         font-size: .82rem; border-bottom: 1px solid var(--line); padding-bottom: .9rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
          padding: 1rem 1.15rem; margin-bottom: .7rem; }
  .warn { border-color: var(--warn); background: var(--warn-bg); }
  .crit { margin: 0 0 .7rem; }
  .crit:last-child { margin-bottom: 0; }
  .check { color: var(--dim); font-size: .84rem; word-break: break-word; }
  .id { color: var(--dim); }
  .ok { color: var(--ok); }
  .bad { color: var(--bad); }
  ul { margin: .2rem 0; padding-left: 1.1rem; }
  li { margin: .2rem 0; }
  button { font: inherit; padding: .45rem 1.1rem; border-radius: 6px; cursor: pointer;
           border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  input, textarea { font: inherit; width: 100%; padding: .45rem .6rem; border-radius: 6px;
                    border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .row { display: flex; gap: .6rem; align-items: center; margin-top: .8rem; flex-wrap: wrap; }
  .row > input { flex: 1 1 16rem; }
  .log { max-height: 17rem; overflow-y: auto; border: 1px solid var(--line);
         border-radius: 8px; padding: .6rem .8rem; background: var(--card); }
  .log div { color: var(--dim); white-space: pre-wrap; word-break: break-word; }
  .scroll { overflow-x: auto; }
  .quiet { color: var(--dim); }
  .strip { display: flex; flex-wrap: wrap; gap: .3rem .9rem; font-size: .84rem;
           color: var(--dim); margin: .4rem 0 .2rem; }
  .board { display: flex; gap: .6rem; overflow-x: auto; align-items: flex-start; }
  .col { flex: 1 1 0; min-width: 9.5rem; }
  .col h3 { font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
            color: var(--dim); margin: .3rem 0 .4rem; font-weight: 600; }
  .task { background: var(--card); border: 1px solid var(--line); border-radius: 7px;
          padding: .5rem .65rem; margin-bottom: .5rem; font-size: .84rem; cursor: pointer;
          word-break: break-word; }
  .task:hover { border-color: var(--accent); }
  .task .meta { color: var(--dim); font-size: .78rem; margin-top: .2rem; }
  .why dt { color: var(--dim); font-size: .78rem; text-transform: uppercase;
            letter-spacing: .08em; margin-top: .6rem; }
  .why dd { margin: .15rem 0 0 0; }
  .why dt:first-child { margin-top: 0; }
`;

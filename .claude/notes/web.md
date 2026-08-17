# The dashboard and the serve process

Read before touching `src/web/**`. Cited from `CLAUDE.md`.

## The bundle

`web/app/` (`state`, `screens.tsx`, `runView.tsx`, `contract.tsx`, `hud.ts`, `orrery.ts`,
`briefing.ts`, `dossier.ts`, `taskPanel.tsx`, `wire`, `main.tsx`) is a Preact app built by esbuild
into `dist/web/app.js` and served on `/app.js`. It is the *maintainer's* build: `npm i -g` is
unchanged, one binary, one process, no dev server.

- `web/app/state.ts` imports the `Event` union **as a type**, so tsc checks every `case` against the
  real schema and the bundler erases zod entirely. `grep zod dist/web/app.js` returns nothing and it
  should stay that way.
- **No `send()` argument may derive from the page's own fold** — the one exception is the id of the
  element that was clicked, which is why every outbound message lives in `web/app/wire.ts`.
- **`main.tsx` clears the mount before the first render.** Preact diffs against a container it has
  no previous tree for, so `shell.html.ts`'s `connecting…` heading is *not* removed; it sat above
  the whole app from U1 until somebody opened the page in U7. A green suite renders components, not
  the document.
- **`npm run dev` serves a stale or missing bundle** — `tsx` runs the server from source but the
  page is whatever `dist/web/app.js` last held. Run `npm run build:web -- --watch` alongside. A
  missing bundle answers 503 with the command to type rather than 404ing into a blank page
  (`web/assets.ts`), which is why that resolution is a pure, separately tested function.

## The server is below the fixture harness

Exactly like `agentCalls.ts`: nothing above it substitutes for a socket. Keep what the server
*decides* — `eventsSince`, `parseClientMessage`, `isAllowedOrigin`, `renderSignoff` — in pure
functions with tests, and leave only plumbing in `web/server.ts`.

**A WebSocket ignores the same-origin policy, so loopback is not an access control.** Any page in
any tab could open `ws://127.0.0.1:<port>` and send `approve` or `panic` until `isAllowedOrigin`
landed. Two of its rules are counter-intuitive and both are tested: an *absent* `Origin` is a native
client and is allowed, while the literal string `"null"` is a sandboxed iframe on a hostile page and
is not; and loopback hosts match exactly and by port, because `127.0.0.1.evil.example` ends with a
loopback literal.

**`noted` is the acknowledgement half of `rejected`** (`web/server.ts` `Handled`). Save and promote
write a file and no event, so without it a click that worked and a click that vanished were the same
picture. It is a sentence and never state — the page still folds events and only events. Handlers
opt in; most decisions announce themselves through the log.

## Workspaces

**A workspace is a directory that was probed, never one that was declared** (`config/workspaces.ts`).
`discoverConfig` is per workspace rather than per process, and three rules are structural:

- The id is a hash of the **real path**, so two spellings of one directory are one workspace — which
  is what makes the per-workspace mission cap mean "one mission per checkout".
- `compose` carries a `workspaceId` and **never a path**, so a mission-side message cannot reach a
  filesystem path at all.
- `workspace_add` is refused unless its resolved path is the one the server's last `workspace_probe`
  reported: you cannot add a workspace you have not been shown.

The state dir does **not** move with the workspace — missions stay under the serve process's own, so
the registry keeps one listing and a mission stays addressable by id alone. `worktreeRoot` is the
one field derived per workspace, because a worktree is a checkout of one repo.

**A resumed mission's directory is decided from its envelope, never from the message.** A mission's
log records no workspace; `mission_created`'s envelope records `fsRoots`, which is the repo root or
cwd it was scoped to. `workspaceForRoots` matches on that, so serve-side resume needed no
event-union change and an older log resolves the same way. **No match is a refusal** naming the
directory and `orchestra resume <id>` — a browser choosing a checkout for work already scoped to one
is how a mission gets resumed in the wrong repo.

**A composed `--plan-only` mission still gets the dashboard, and a terminal one still does not.**
Plan-only runs intake, so under `serve` a mission with no port would ask its three questions into a
process nobody is attached to and sit there until the budget ran out. From a terminal it prints and
exits, and CI has no browser.

## What fills the screen

- **Past sign-off the page is three rails, decided in `web/app/hud.ts`.** `core`, `vitals` and
  `panes` are pure and tested, because a HUD is a *ranking* before it is a layout and a ranking can
  be wrong invisibly: a mission with a question pending and three tasks running looks busy and is
  stopped, so "needs you" outranks running and does not spin. Two asserted rules — a counter still
  at zero is not drawn at all, and the run view holds the board and the inbox while everything else
  is one pane click away. `Ticker` (`runView.tsx`) is the only thing that repaints between events;
  it owns its clock so a second passing costs one text node and not the card's hover, focus, scroll.
- **The orrery says two things and only two** (`web/app/orrery.ts`): **angle is plan order** and
  **radius is lifecycle**. A task that starts running must not move sideways or the eye loses the
  node it was watching; work falls inward as it settles, so "nearly done" is a shape rather than a
  count. Geometry is pure and tested — a node on the wrong ring still looks like a dashboard. Two
  feeds, one geometry: home folds no mission's log, so there the nodes are *missions* and the core
  is `homeCore`; under a mission they are tasks and the core is `hud.ts`'s. The SVG carries
  `role="group"`, not `role="img"` — ARIA treats everything inside an `img` as presentational, and
  every node is a button.
- **A task says itself in two sizes.** A synthesized `goal` is a two-thousand-character
  specification and `agentSpec.systemPrompt` is several times that. `taskPanel.tsx` splits them:
  `TaskBrief` is the rail's card (role, transport, model, four clamped lines of goal, a way in) and
  `TaskDossier` is a centre pane at board width with the prompt folded. Selecting a task
  deliberately does **not** move the pane — clicking a board card would otherwise replace the board,
  which U7 says must stay; the pane falls back to the board when the selection clears, since
  `panes()` only offers `task` while one exists. `dossier.ts` decides which facts show, pure and
  tested, and it inverts the HUD's zero rule on purpose: an absent optional draws no row, but an
  **empty capability is a fact** — no tools, or a code task whose lease is empty (defect 23) — and
  says what the emptiness means.
- **The briefing is evidence, never elapsed time** (`web/app/briefing.ts`). Two unguessable facts
  about the log shape it: `outcome_spec_written` carries the estimate, so it cannot be emitted until
  *after* the plan — the criteria reach the ledger first, in the `reason: "spec"` revision, and that
  is what the spec stage is done on; and two stages share the `specifying` status, which is why
  "running" is the first unfinished stage rather than a match on the status. The sign-off screen is
  the waiting screen plus one row of buttons (one `Contract` component), so the approve button
  appends under a contract that was already read rather than arriving where a reflex click lands.
- **Home is a rail and a deck, and nothing on it was deleted — it was ranked.** The rare controls
  (add a directory, save a mission, the nine-row `doctor` report) are behind `<details>`, and
  `screens.test.tsx` asserts each is still rendered, because folded and gone look identical in a
  diff. The report opens by itself when the machine is not ready. `--unattended` is deliberately not
  on the page, and `screens.test.tsx` asserts that too.

## Showing the work

**The page names an id and the server derives the path** (`web/work.ts`, `web/showWork.ts`,
PLAN-NEXT 9.3). A finished mission used to report only that it finished, and everything missing was
already on disk with its path already folded — evidence paths, the design note, the merge shas. The
gap was rendering, and the one hazard in closing it is the step in the middle: a filename crossing
the socket is a browser naming a path to a process that also holds the operator's API keys. So
`show` carries a **task id** (for a diff) or the **`seq` of the event that recorded a file**, the
server rebuilds the listing from its own copy of the log, and an id that is not in it is refused
before `readFileSync` — `workspace_add`'s rule applied to a file.

Three facts are load-bearing. **`foldWork` is one reducer with two callers** — `web/app/state.ts`
`apply` and the server's `workOf` — because two implementations of "which files exist" is one
implementation of "which files the server will open" and one of "which files the page will ask
for", and only the first is a rule; it carries the panel-seat early return for the third time, since
a seat is a record and not a verdict. **`apply` folds the listing *around* its switch**, in
`apply`/`project`, because every case returns early and a case that also had to carry the listing
forward is a case that will forget. And **which mission a `show` reads is the socket's cursor and
never the message's**, so a tab cannot read the artifacts of a mission it is not watching — there is
no `missionId` field on the frame at all.

`showWork.ts` touches disk and git and still has its own test with a real tmp dir and a real repo,
which is what keeps `server.ts` holding only plumbing. `isSha` guards the diff range against a
hand-edited log rather than against a browser: `run` spawns without a shell, so there is no quoting
to get wrong, and a leading `-` read as an option is the one thing a bare argument can still become.
**Deliberately not built: a "run it" button** — the value asked for is seeing the result, and a
browser control that executes project code is a new blast radius on a page whose whole security
model is "nobody can route to it".

## Motion and type

**Ambience and state are two motion vocabularies, and the split is what keeps glow meaning
something.** Bloom behind the panels, threads between orrery nodes, a 90-second drift on
`body::before` and the outer orbit — none of it is caused by an event, so all of it is desaturated
and slow, deliberately below the rate at which movement reads as news. State keeps the other half:
full-strength `--live`, the 3.4s scan across a running task, the 2.2s pulse, the turning sweep.
**If something idle ever moves as fast or as brightly as something running, the glow has stopped
meaning anything** — a regression however good it looks. `prefers-reduced-motion` stops all of it,
ambient included.

**The display face is served by this process and `assets/` has to ship.** `web/fonts.ts` mirrors
`assets.ts`: `FONT_ROUTE` is the request path *and* the URL in the `@font-face`, which cannot be
interpolated because `style.test.ts` allows no `${}` that is not a token — so the literal is
asserted against the constant instead. The CSP gained `font-src 'self'` and nothing wider: a font
CDN is a third party inside a surface where a human approves work. Chakra Petch is OFL, vendored as
the Latin subset (10 kB) with its licence, attributed in `NOTICE`; `package.json` `files` carries
`assets`. A missing font is not an error, it is a page silently rendering in the fallback stack,
which is why `fonts.test.ts` asserts the file is really there.

**`src/web/style.ts` is a template literal and a backtick in it is a parse error several lines
later.** Naming `tokens.ts` or `briefing()` in a CSS comment the way every other comment here does
breaks the build, and it reads as a broken edit rather than a stray character — four debugging
detours before `web/style.test.ts` was written to trip on it.

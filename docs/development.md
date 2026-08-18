# Development

```bash
npm run build     # tsc → dist/, then the dashboard bundle → dist/web/app.js
npm test          # ~1,760 tests, ~110s
npm run typecheck
npm run dev -- doctor
```

A single file:

```bash
node --import tsx --no-warnings --test src/events/fold.test.ts
```

## Build before testing on a fresh checkout

The dashboard is a bundle, and the suite asserts the route that serves it.

There is no lint and no formatter — typecheck, build, and test are the whole gate, and CI runs exactly
that on Node 22 and 24, with a separate job proving the shipped binary starts on Node 20.
[`CONTRIBUTING.md`](../CONTRIBUTING.md) has the conventions a first patch has to hit.

Working on the dashboard itself: `npm run build:web -- --watch` alongside `npm run dev`, or the page
you reload is the one you built last.

## One rule the suite cannot enforce for you

`src/loop/agentCalls.ts` is the file the fixture harness substitutes for, so **a green suite says
nothing about what a model actually receives.** Six defects hid there behind 331 passing tests until
the first real run.

> If you change a prompt, a schema, or a decision point's input, do one real `--plan-only` run against
> a scratch directory before believing it.

That applies to the roster too, and to its whole reason for existing. The suite proves a role is
offered, resolved, and composed; it cannot tell you the arrangement saves anything. Run the same goal
twice — once with `agents/` moved aside — and diff `call:synthesize` in `orchestra metrics --json`.

## On the `§N` citations

Code comments cite a design document by section (`§9.1`) and by defect number ("defect 30"). The
document those sections belonged to has been retired; the citations are left in deliberately, as
markers: each one says *why* a piece of code is shaped the way it is, and the reason is usually a
bug that a real mission found. Read the comment beside a citation and the test header, not the
number — `CLAUDE.md` carries a subject map for the numbers.

You do not need any design document to run a mission or to send a patch —
[`CONTRIBUTING.md`](../CONTRIBUTING.md) and `CLAUDE.md` carry what a change has to respect.

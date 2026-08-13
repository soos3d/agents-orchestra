# Contributing

Thanks for looking. This is a small project with strong opinions about its own structure, and most
of them are written down — this file is the short version a first patch needs.

## The gate

```bash
npm run typecheck && npm test
```

That is the whole thing. There is **no lint and no formatter**, deliberately: the conventions below
are about structure rather than whitespace, and a formatter would not catch any of them. Please do
not add one in a first PR.

CI runs the same two commands on Node 20 and 22, plus a fold-equality check over a committed event
log. Node 20 is the floor (`engines`), and `orchestra doctor` enforces it at runtime.

## Conventions a patch has to hit

- **ESM on bare Node: every relative import carries the `.js` extension.** No exceptions.
- **Zod at boundaries only** — disk reads, event append and replay, worker output. Never on internal
  function arguments. Use `safeParse` plus a hand-written message rather than `.parse()`.
- **Colocated `*.test.ts`**, `node:test` + `node:assert/strict`, with a header comment naming the
  failure mode under test.
- **Real tmp directories and real git repos over mocks.** `src/testing/gitRepo.ts` builds one. A fake
  git would encode the same assumptions the bugs came from.
- **No classes except `Error` subclasses.** Factory functions returning an object literal typed by an
  interface. Named exports only.
- **Dependency injection instead of module singletons.** There are no globals; keep it that way.
- **Every error message names the fix.** "Narrow one of the tasks or make them sequential", not
  "conflict detected".
- **A new optional field on a `Deps` interface needs a composition-root test.** This is not style
  advice. Three separate features have been built to spec, unit-tested, and left switched off
  because no entry point passed the parameter — see defects 12b, 23 and 24 in `ROADMAP.md`. Test
  the thing that *builds* it (`buildLoopDeps`, `runMission`), not only the mechanism.

`CLAUDE.md` has the rest, including the architecture and the gotchas. It is written for an agent
working in the repo and is just as useful to a person.

## Adding an event type

Two files, in order: `src/events/schema.ts` (the discriminated union), then `src/events/fold.ts`
(the handler table is a mapped type over the union, so forgetting the second file is a compile
error by design). Add a `fold.test.ts` case for the transition. There is an `/add-event` skill in
`.claude/skills/` if you are working with Claude Code.

## The one thing the suite cannot check for you

`src/loop/agentCalls.ts` is the file the fixture harness substitutes for, so a green suite says
nothing about what a model actually receives. Six defects hid there behind 331 passing tests until
the first real mission ran. **If you change a prompt, a schema, or a decision point's input, do one
real `orchestra run "<goal>" --plan-only` against a scratch directory before believing it**, and
say in the PR that you did.

The same habit applies below the transport seam: the ACP protocol schemas in
`src/testing/acp-transcripts/` are executable fixtures parsed by the suite, and adapter versions are
pinned exact. Bump one and re-capture.

## Design docs

`specs.md` (§0–§17) is authoritative and code comments cite it by section number. If you are
changing behaviour a section describes, read that section first and say in the PR whether the
section still holds. `ROADMAP.md` carries the phase history and the defect table; a fix for a
defect listed there should say which number it closes.

## Pull requests

Keep the summary brief and include how you tested it. Commit messages are
`<type>: <description>` — feat, fix, refactor, docs, test, chore, perf, ci.

By contributing you agree that your contributions are licensed under Apache-2.0, the project's
license.

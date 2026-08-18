# How it got here

Background only. Nothing in this file is needed to make a correct change — it is here so a session
can answer "why does this subsystem exist". For what to do next, `plans/v2-plan.md` is the
authority; for why that order, `plans/ecosystem-analysis.md`.

## Phases

- **1–4 — the load-bearing core.** The event log and `fold`, the scheduler and leases, the two
  seams (`loop/calls.ts`, `loop/human.ts`), worktrees and the merge queue.
- **5 — `src/memory/`**, the semantic and procedural tiers, all markdown under `<stateDir>`:
  `lore/` (one fact per file; provenance required at write, `principle` human-only, stale entries
  re-enter the ledger as guesses via `recallToLedger`), `saved/` (saved missions — deliberately not
  `missions/`, which holds state dirs), and `profiles/` (promoted `AgentSpec`s, offered to synthesis
  as hints that still pass full validation). Recall, write-back (`memory/writeBack.ts`) and profile
  loading are optional deps wired in `runCommand.ts` and `buildLoopDeps`, each with a
  composition-root test. Replays of a saved mission re-run scan and research; `--unattended`
  requires `--saved` or `--force`.
- **6 — `src/channel/` (since deleted).** The carrier-independent trust core (`trust.ts`,
  `cards.ts`, the `Carrier` interface) was built, no concrete carrier ever shipped, and the whole
  module was removed from the tree in August 2026 — cleanly; nothing in `src/` references it. A
  future phone/chat carrier starts from zero, which the v2 plan is fine with ("no phone mirror").
- **7 — `src/workers/acp/`**, ACP as a worker transport. See `.claude/notes/workers.md`.
- **P1–P5, on top of 7.** A criterion checked `false` is re-checkable (`loop/criteria.ts`); every
  task has an artifact directory it may write to; decision points run in the target repo rather than
  the process cwd; the project's own verify command is a merge gate for code tasks.
- **U0–U7 — the dashboard**, rewritten from composed string fragments into a Preact bundle. See
  `.claude/notes/web.md`. `orchestra serve` became the only command a normal run needs: resume,
  save, promote, a `doctor` panel and a plan-only toggle are all on the page.

## Real runs

Nine real missions have run against live models, costing roughly one defect each — **every one of
them in a layer the fixture harness substitutes for.** That is the standing lesson: a green suite
said nothing, and one real run said everything.

- **Five missions over ACP** (2026-08-10): first-attempt tasks with real commits, merges and
  criterion checks; surfaced defects 28–35.
- **Run 8** (2026-08-11) went brief → `complete` uninterrupted — the standing check, met: six
  synthesized agents, six first-attempt tasks, five real merges, nine criteria `met` with evidence.
  Runs 6–8 cost defects 36–41.
- **Run 9** (2026-08-13) proved P2 and defect 41 together. Its log is committed as
  `src/testing/receipts/survey-conventions.jsonl` and the suite folds it.

## Still open

(Corrected 2026-08-18 — three items previously listed here are done: defect 42 is closed by
`workers/childEnv.ts`, artifact content serving landed with the dashboard's `show` frame, and
server-side resume exists.) Still genuinely open: kill-task, the scheduled retention sweep,
envelope editing on compose, streaming live worker activity, and any carrier (`src/channel/` was
deleted; see Phases above). The active plan is `plans/v2-plan.md` (receipts first, then the
Tuesday path, then `verify`/import); the definitive open-items list is
`plans/incomplete-tasks.md`.

## The documents

Planning documents live in `plans/` (gitignored): `v2-plan.md` and `ecosystem-analysis.md` are
active; `plans/archive/` holds the superseded ones (`PLAN-NEXT.md`, the condensed `specs.md`,
`SPECS-AUDIT.md`, session handoffs). The earlier generations — `ROADMAP.md`, `NEXT-PLAN.md`,
`PHASE-8-PLAN.md`, `PLAN.md`, the long-form spec — no longer exist. The still-accurate conceptual
content of `specs.md` was folded into `docs/architecture.md` (2026-08-18, with the audit's
corrections applied).

**The `§N` citations in the source resolve against nothing on disk.** They referred to the retired
long-form spec. `CLAUDE.md` carries the subject map; `plans/archive/SPECS-AUDIT.md` (16 Aug 2026)
has the full audit. Read the comment beside a citation, not the number.

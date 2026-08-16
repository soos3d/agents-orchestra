# How it got here

Background only. Nothing in this file is needed to make a correct change — it is here so a session
can answer "why does this subsystem exist" without opening `PLAN.md`. `PLAN.md` §3 (what landed),
§4 (decisions — do not reopen) and §7 (defects 1–42) are the authority.

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
- **6 — `src/channel/`**, the carrier-independent trust core: `trust.ts` (single-use nonce, bound
  sender identity, replay-approves-once as a property of the store), `cards.ts` (a `credential` gate
  has no card; `GateCard` has no field an image could ride in), and the `Carrier` interface. The
  serve process mirrors a live mission's open questions through an optional `channel` dep; no
  concrete carrier ships yet. `doctor` refuses a non-loopback `ORCHESTRA_GATEWAY_URL` — the spike
  showed the client would allow remote `wss://`, so that refusal is load-bearing.
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

Defect 42 (a worker inherits every secret on the machine — `.claude/notes/workers.md`). Kill-task,
the retention sweep, artifact content serving, envelope editing on compose, and the concrete carrier
are unbuilt; panic has no browser session to close until Phase 8. Next track is U8, then publish,
then Phase 8 — `PLAN.md` §2.

## The documents

`specs.md` and `PLAN.md` live on the maintainer's machine and are gitignored. `ROADMAP.md`,
`NEXT-PLAN.md` and `PHASE-8-PLAN.md` no longer exist — `PLAN.md` consolidated them, and §1.1 records
what they disagreed about rather than quietly fixing it.

**The `§N` citations in the source no longer resolve.** `specs.md` was condensed and renumbered into
nine sections; the code cites twenty-odd, including several that the current file has no counterpart
for at all (`§9.4`, `§9.5`, `§17`, `§12`…). `SPECS-AUDIT.md` (16 Aug 2026) has the full mapping
table and the three ways out. Until one is chosen: read the comment beside a citation, not the
number.

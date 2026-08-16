# The loop, the roster, and the humans

Read before touching `src/loop/**` or `src/agents/**`. Cited from `CLAUDE.md`.

## The seams

**`loop/calls.ts`** is the model-call interface (`research`, `intake`, `plan`, `synthesize`,
`progress`, `judge`) — real in `loop/agentCalls.ts`, scripted in `testing/fixtures.ts`. Everything
above it is tested with no model and no spend.

**`agentCalls.ts` is the one file the fixture harness cannot cover**, since it is the thing the
harness substitutes for. Five defects hid there behind 331 green tests until the first real-model
run, and a sixth behind 461. Anything the model *receives* — SDK options, prompt text, a decision
point's input — belongs in a pure function (`queryOptions`, `withSchema`, `AVAILABLE_TRANSPORTS`) so
the next regression is catchable for free, and still wants one real run before you believe it.

**`loop/human.ts`** is the other seam: the places a mission blocks on a person. `cli/terminal.ts`,
`web/webHuman.ts` and `unattendedHuman` all implement it; `anyOf` lets a decision arrive from
whichever surface answers first, and `prepareMission` cannot tell them apart.

**End of input is not approval.** `Prompter.ask` returns `undefined` for a closed pipe and `""` for
a human pressing Enter, and conflating them hands sign-off to a shell redirect. The same distinction
is why the terminal port *rejects* on intake when nothing was answered: these ports race, and a port
that cheerfully returns "no answers" wins that race and the browser never gets asked.

**`intake` is a sixth decision point**, a one-shot call rather than a streaming conversation,
because intake is capped at three questions asked once — which keeps the cap and the answers
*above* the seam, where they are assertable (defect 15).

**A decision point is the one part of the loop that reaches outside the process**, so it fails the
way networks fail. `loop/resilience.ts`: retry once, then `DecisionPointError`, which the loop parks
on. **Nothing else may be caught there** — a `TypeError` that parked silently would be a bug nobody
finds. Decision points run in the target repo rather than the process cwd (P3).

## Blocking, parking, resuming

`ask_human` parks exactly its `blocks` tasks — **in the fold**, deliberately, because the answer may
arrive when no loop is running and resume can only lift what the fold recorded. A worker reporting
`blocked` raises the question; the inbox answers it; `question_answered` returns the task to
`waiting`, where the scheduler owns the promotion. Pause works the same way: a folded flag the loop
parks on, lifted by `orchestra resume`.

`cli/resumeCommand.ts` is the reconciliation and the continuation, extracted from `main.ts` so the
terminal and the browser reach them by one path — the difference is the optional `RunSurface`,
exactly as in `runMission` (which never closes a server it did not open).

`attempts` is incremented in `fold`'s `task_status` handler when a task enters `running`; there is
no separate dispatch event, and the retry cap reads it.

## Criteria

The outcome spec is written by the `research` call, and its `criteria` are deliberately typed
`unknown[]`. That is what keeps a criterion with no check *representable*, so `writeOutcomeSpec` can
reject it — typing it as `Criterion[]` would make the system's most important validation untestable.
**The cost is that `withSchema` renders it as an unconstrained array**, so the model is told nothing
about a criterion by the derived schema; `RESEARCH_PROMPT` spells out `criterionSchema` and the
`VerifySpec` union by hand. Change one and change the other.

**A criterion checked `false` is re-checked when a contributor lands after the verdict, and a
still-`met` one is never re-judged.** `shouldCheckCriterion` (`loop/criteria.ts`) is that decision
and it is pure, because its two possible mistakes are opposite: never firing again parks a mission
whose fix already merged (observed on run 8), and firing every round buys a judge call per criterion
per round. `Task.completedRound` is folded from `task_status` the way `attempts` is —
`task_replanned` spells it out rather than leaving it to the spread, since `patchTask` merges.

**A judge reads files, and a rubric has to be about them.** The judge gets `artifactPaths` and
nothing else. Defect 22 was the judge having no tools to open them; defect 25 was synthesis writing
"PASS only if the final message…", which no judge can evaluate. Both made every judge-verified
criterion unpassable, and neither was visible to the suite.

## The roster (`src/agents/`)

It amends the spec rather than extending it. The spec said an agent is synthesized per task and
"never chosen from a fixed roster", on the argument that a fixed list caps the system at what its
author anticipated. The argument holds; the conclusion was overturned deliberately, because it
bought that generality with a full system prompt authored from scratch for every task to reach a
decision a one-line description already makes.

`roster.ts` loads markdown entries from the shipped `agents/` directory and `<stateDir>/agents/`;
`offer.ts` merges them with promoted profiles into one index and composes the final prompt. Eighteen
roles ship, derived from `msitarzewski/agency-agents` (MIT, attributed in `NOTICE`) and
substantially rewritten.

**The saving is the split between what the orchestrator reads and what the worker reads.** The call
is shown index lines only — ~3.3k chars, ~820 tokens for all eighteen — and answers with
`basedOn: "<name>"` plus a short addendum. The ~30-line body is never in that call's context; it is
read from disk and folded into `systemPrompt` by `attach()` *before* `task_planned` is emitted. Two
load-bearing consequences: the event log still carries a complete prompt, so `fold`, replay and
`receipt.test.ts` are untouched by the roster's existence; and editing a roster file changes future
missions and no past one. `SynthesizeInput.roster` is a **rendered string** and not a list, because
`describe()` JSON-dumps its input into the prompt — passing role objects would carry every body with
them, which is the whole cost this avoids. **Whether it actually saves tokens is not something the
suite can tell you**: run the same goal with and without a roster and diff `call:synthesize` in
`orchestra metrics --json`.

**A `basedOn` naming nothing is refused, never degraded.** When synthesis names a role it writes
only the task-specific addendum — a paragraph — *because* it expects a body to be attached. Passing
an unresolvable name through would hand a worker that paragraph as its entire system prompt, and
nothing would fail until the work came back wrong. `inspect` re-asks once quoting the real names (a
near-miss is the likely mistake), then `UnknownRoleError` parks the task. `attach()` throws on a
miss rather than returning the spec unchanged, and that throw is unreachable by construction — it
fires only if `inspect` and `attach` are reading different role lists.

**The roster index is a recurring cost, so it is capped by a test rather than by review.**
`DESCRIPTION_BUDGET` (160 chars) is enforced in the schema at parse; `ROSTER_INDEX_BUDGET` (4,000)
is asserted against the shipped roster in `agents/offer.test.ts`, so a nineteenth entry that pushes
it over fails the suite. The number it replaces is why: the full source collection's index is ~15.8k
tokens, against ~8.2k for an entire `--quick --plan-only` mission. **Raising the budget is almost
always the wrong fix.**

**A roster entry contributes a system prompt and nothing else.** A promoted profile carries a whole
validated `AgentSpec` — transport, tools, a lease — and `offeredRoles` deliberately drops all of it,
keeping only `spec.systemPrompt` as the body. Those capabilities were checked against the envelope
of the mission that promoted them, and this mission's may be narrower; letting them ride in on a
name would be a capability grant made by a model, which is exactly the ceiling the design exists to
hold. The `suggests` classes in the index are a hint about the shape of the work and never a grant.

## Quick missions

**A mission can be declared *quick* by the human who composes it** — the compose-card checkbox, or
`--quick`. It skips the deep `research` call and keeps the scan's own brief and criteria (previously
computed and thrown away), and tells the planner to produce one task rather than a decomposition
(`PlanInput.scope`). **It is a hint and never a permission**: the outcome-spec gate is unchanged,
and a scan-derived spec that `writeOutcomeSpec` refuses escalates to the deep call the mission
skipped — so a box ticked on a job that was not small costs one call, not a run.

Two things buy the deep call back, both structural rather than cautious: an **answered intake
question**, because the scan runs *before* intake and its criteria would predate the answer; and the
**first send-back at sign-off**, because a human rejecting a quick plan is contradicting their own
checkbox, and replanning over scan-depth findings would answer that with the same thin ground twice.

Measured on the same goal (2026-08-15, `--plan-only`): 8,194 tokens / 1m53s quick against 15,921 /
3m35s standard.

**The scan has to be told when it is the only research pass** — `ResearchInput.solePass`, derived in
`buildResearchInput` from `depth === "scan" && mission.quick`. Without it the scan returns findings
and no criteria (reasonably: it has been told it is a scan, and on an ordinary mission the deep call
writes the spec), so `writeOutcomeSpec` refuses `(empty)` and the mission escalates to the call it
was skipping. Observed on a real run before the field existed: quick cost two research calls and
saved nothing.

## Optional deps

**An optional field on a `Deps` interface is a place a feature can be finished and switched off at
once.** `requestExtension`, `owns` and `reformat` were each built to spec, unit-tested, and
reachable only through a parameter no entry point passed; all three surfaced on a real mission
rather than in the suite. When you add one, test the composition root that builds it
(`buildLoopDeps`, `runMission`), not only the mechanism.

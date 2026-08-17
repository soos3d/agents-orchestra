# The loop, the roster, and the humans

Read before touching `src/loop/**` or `src/agents/**`. Cited from `CLAUDE.md`.

## The seams

**`loop/calls.ts`** is the model-call interface (`research`, `architect`, `intake`, `plan`,
`critique`, `synthesize`, `progress`, `judge`) — real in `loop/agentCalls.ts`, scripted in
`testing/fixtures.ts`. Everything above it is tested with no model and no spend.

**The names live once, in `CALL_NAMES` (`domain/budget.ts`)**, and `loop/calls.test.ts` pins that
constant to `keyof Calls`. `resilience.ts` kept a second copy behind a header claiming it enumerated
the interface's keys, which is how `architect` was wrapped everywhere except the retry wrapper and
arrived at the composition root as `undefined` with the whole suite green. Two lists may legitimately
be shorter and only by `judge`: `missionStaffingSchema` and the compose card's `STAFFABLE`.

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

**A missing credential parks nothing** (PLAN-NEXT 7.1). `raiseSecrets` in `prepare.ts` compares the
architect's `envVars` against `Envelope.env` and emits `secret_required` plus a `question_asked` whose
`blocks` list is **empty** — there is no task to park, because the plan is written after the architect
answers, and the goal of the stage is that a mission never stops for a key. The inbox item is real and
survives a restart on the ordinary fold path; the human's answer is either "mock it" (nothing changes)
or `orchestra run --env NAME` on a fresh mission, since no code path widens an envelope. The names
already raised are deduped against folded `state.secretsRequired`, which is what stops the architect's
one retry opening a second item for the same variable.

`cli/resumeCommand.ts` is the reconciliation and the continuation, extracted from `main.ts` so the
terminal and the browser reach them by one path — the difference is the optional `RunSurface`,
exactly as in `runMission` (which never closes a server it did not open).

`attempts` is incremented in `fold`'s `task_status` handler when a task enters `running`; there is
no separate dispatch event, and the retry cap reads it.

## Criteria

The outcome spec is written by the `architect` call — by `research` only on a quick mission, where
the scan is the sole pass and `solePass` says so — and its `criteria` are deliberately typed
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

**The gate is unchanged wherever the criteria came from.** `writeOutcomeSpec` did not move with the
spec, and the one retry goes back to whichever call wrote the criteria it refused: the architect on
an ordinary mission, the deep research pass on a quick one, which is that mission's escalation.

**A judge-checked criterion is graded by a panel, and the fold applies only its answer**
(PLAN-NEXT 6.1). `panelSeats(quick)` is one unlensed seat on a quick mission and three lensed ones
otherwise; `criterion_checked` gained optional `panelSeat` and `lens`, and `fold` returns early on a
seated event. Applying one would leave `met` reading whichever judge answered last — wrong on a third
of 2-1 splits — and would move `lastCheckedRound` mid-panel, so `shouldCheckCriterion` would refuse
to re-convene the panel that was still voting. **`web/app/state.ts` `apply` carries the same guard**
— it is the log's second reader, and without it the dashboard paints each seat's own answer onto the
criterion as the events stream. Quorum is `panelVerdict`: a strict majority of the
votes actually cast, so 2-of-3 and 1-of-1 both fall out of one rule and there is no threshold beside
the seat count to drift from it. The seats vote sequentially rather than in parallel: three calls in
flight are three ways to be mid-spend when the first throws, and a `DecisionPointError` parks the
mission with two verdicts nobody will read still being billed. Each seat's own evidence rides on its
own event; the resolved verdict quotes the split, because a 2-1 resolved `true` with the dissent
deleted reads as unanimous to anyone opening the mission later.

**Deterministic checks run first and a failing one closes the round to panels** (6.2,
`deterministicFirst`). The gated criteria are left untouched rather than marked unmet, so the panel
convenes on its own next round once the command criterion is green — marking them would move
`lastCheckedRound` and gate them for the rest of the mission, which is defect 32's shape.

**A `scanner` check is a fourth kind and it is refused unless granted** (6.3). `Envelope.scanners`
is the grant, `probeScanners` is the machine's half, `availableScanners` is the intersection, and
`writeOutcomeSpec` refuses anything outside it — the criterion is refused when the spec is written
rather than skipped when it fires, because a check that does not run is a criterion the mission can
never legitimately report as met. The prompt half is `checkAuthoring(scanners)`, a function rather
than a constant: a mission with no grant gets the text it got before scanners existed. Only the
architect is ever offered one — `research` writes the spec on a quick mission, and a mission composed
as small is the one not to spend a per-file security scan on.

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

**A quick mission also skips the architect and the plan critic** (PLAN-NEXT 5), which is what keeps
that first number true. Neither skip relaxes anything: the outcome-spec gate is the same, and a
one-task plan has no dependency to miss and no lease to collide with — the two objections the critic
exists to raise.

**The scan has to be told when it is the only research pass** — `ResearchInput.solePass`, derived in
`buildResearchInput` from `depth === "scan" && mission.quick`. Without it the scan returns findings
and no criteria (reasonably: it has been told it is a scan, and on an ordinary mission the deep call
writes the spec), so `writeOutcomeSpec` refuses `(empty)` and the mission escalates to the call it
was skipping. Observed on a real run before the field existed: quick cost two research calls and
saved nothing.

## Moonshot missions

**`--moonshot` is `quick` one polarity along, and a preset over knobs that already existed**
(PLAN-NEXT 8.2). Same shape end to end: an optional boolean on `mission_created`, folded to
`mission.moonshot` so a resume runs on what was chosen, a compose-card checkbox beside `quick`, and
no new event type. It grants nothing — every gate, cap and envelope is the standard one.

It sets exactly two knobs. **The critic runs twice** (`MOONSHOT_CRITIQUE_ROUNDS`, `prepare.ts`):
the plan the critic bought is itself critiqued once and then it stops, because a critic with no
ceiling is a budget leak whichever profile asked for it, and `rounds` is the only thing in
`critiquedPlan` that reads the profile. **And the critic is handed the design summary** —
`CritiqueInput.design`, the same projection `PlanInput.design` carries, with a gated paragraph in
`CRITIQUE_PROMPT` ("only when the input carries a `design`") so a standard mission's critique prompt
is byte-identical to what it was. That is the design review round in the only form the critic can
act on: an objection about the plan, which the replan it already buys can fix.

**The panel is deliberately not touched.** The plan text says "panel N=2" and two seats is not a
bigger panel — `panelVerdict` is a strict majority of the votes cast, so an even split is unmet and
either seat vetoes the other. Three lensed seats is already what a standard mission convenes and
there is no fourth lens worth asking, so the profile spends where a knob exists.

**`--quick --moonshot` is refused at parse and the two checkboxes are refused at `compose`** — two
sites because the CLI refusal names flags and the server's names checkboxes, and neither resolves
the pair: whichever one the code picked, half the people asking for both would get the other mission.

## Optional deps

**An optional field on a `Deps` interface is a place a feature can be finished and switched off at
once.** `requestExtension`, `owns` and `reformat` were each built to spec, unit-tested, and
reachable only through a parameter no entry point passed; all three surfaced on a real mission
rather than in the suite. When you add one, test the composition root that builds it
(`buildLoopDeps`, `runMission`), not only the mechanism.

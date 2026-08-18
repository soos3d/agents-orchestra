# Spend, tokens and metrics

Read before touching spend, `domain/budget.ts`, `events/metrics.ts` or `orchestra metrics`.
Cited from `CLAUDE.md`.

## Two axes, both load-bearing

*How well a number is known* is `measured` / `estimated` / `unmeasured`. *What kind of token it is*
is `input` / `output` / `cacheRead` / `cacheWrite`, all optional on `Spend.tokens` **because absent
and zero are different claims**.

`measured` stays `input + output` — it is what `budgetExceeded` compares against and what every log
written before the split means — so cache is reported *beside* it, never folded into it. The kinds
are what make a mission chargeable: input, output and cached input are priced 5× and 10× apart, and
on a real run the cache was 470,767 tokens against 11,662 measured. Producers use `tokensFrom`
(`domain/budget.ts`); a transport reporting an output figure it knows to be a floor passes
`estimatedOutput`, which keeps it out of `measured` and turns `pricedFully` false.

**Absent usage stays absent, never `0`.** `spendOf` counts a transport that reports nothing as one
*unmeasured* dispatch; a confident zero makes a mission that cost real money read as free.

Web searches are a third metered quantity, not a token kind. Anthropic bills $10 per 1,000
(`$0.01` each) on `server_tool_use.web_search_requests`; the count rides on
`Spend.webSearchRequests` and is never folded into token `measured`. `priced()` adds
`count * WEB_SEARCH_USD_PER_REQUEST` even when no model card can price the tokens, so a
`--research-web` mission's `costUsd` is not silently short. Absent and zero stay different
claims; `zeroSpend()` omits the field.

## Where each transport's numbers come from

- **`claude -p --output-format json`** reports usage and this repo used to discard it, reading
  `.result` and nothing else. `parseClaudeCodeResult` keeps all four kinds, not their sum.
- **`codex`** is honestly unmeasured — scraped from `--output-last-message`.
- **ACP** frames carry no usage at all, so `workers/acp/usage.ts` reads the agent's own session log
  after the turn: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, the id being the one
  `session/new` already returns. Three things about that file were captured rather than documented:
  - **One API response writes several lines** (text, then tool call) each repeating the same
    `usage`, so the reader dedupes by `message.id`; summing lines doubles the session.
  - **`output_tokens` is the `message_start` snapshot**, so input and cache are exact and output is
    a floor — hence `confidence` and the `≥` in the report.
  - **The slug is one dash per non-alphanumeric character, not per run.** A worktree path has `/`
    and `.` adjacent; collapsing runs found the log for a mission run from a home directory while
    silently missing it for every `code` task. The fixture test passed and the first live run found
    it in thirty seconds.

  No log means a wire estimate into `estimated`; neither means the dispatch stays unmeasured.
- **`AgentSpec.model` is never sent over ACP**, so `spend_recorded.model` records what actually ran.
  The adapter picks its own model: a task specced `sonnet` ran on `claude-opus-4-6`, a 5× pricing
  error in a log that looked precise. `metrics` prints the mismatch under the task rather than only
  the spec's choice. Making the adapter honour the spec is a separate change and needs a live
  capture of the selection call.

## Attribution

**`spend_recorded.phase` holds two vocabularies.** `dispatch` writes the task's id there; the
orchestrator writes `spendPhase(call)` — `call:research`, `call:plan`. Both live in
`domain/budget.ts` rather than beside `Calls`, because `events/metrics.ts` reads them and `events/`
never imports `loop/`. `CALL_NAMES` is kept exhaustive against `keyof Calls` by a total-record
assertion in `loop/calls.test.ts`. `isCallPhase` is membership in the known set and deliberately not
a prefix match — a task id comes out of a model-written plan and nothing forbids one starting with
`call:`. Before this, all six calls were written as the constant `"orchestration"` and "which call
is expensive?" had no answer.

**`orchestra metrics` folds the log on demand and is deliberately not a projection.** A third atomic
write on every event would pay all mission long for a question nobody asks until the mission is
over. `--json` is the form that matters while tuning: the point of collecting any of it is diffing
two runs of the same goal. It reports phases it does not recognise (an old log's `"orchestration"`)
rather than dropping them, but skips phases that recorded nothing at all — `prepare.ts` emits
`scan_completed` and `research_completed` with a hardcoded `zeroSpend()`, so every mission carries
`scan` and `research` phases that are zero by construction and would otherwise invite the reader to
conclude the scan was free.

## The estimate predicts no tokens, and that is the fix rather than a gap

It used to: four hand-authored per-call constants in `loop/estimate.ts` (`plan` 8k, `synthesize` 4k,
`progress` 3k, `judge` 6k) summed and rendered as "~45k tokens measured". Prompt caching had already
made the quantity meaningless — on a real run `input` was a flat **2 tokens per call**, so `measured`
stopped tracking the work while actual movement ran an order of magnitude above it: **45,000
predicted, 11,662 measured, 470,767 moved**, and the judge calls charged 6,000 apiece were the
largest line at 68,366 of cache for two of them. Recalibrating the coefficients would have kept the
same undefined quantity and made it look trustworthy, so the number was withdrawn.

`Estimate` is now `taskCount` / `wallMs` / `expectedGates`. `estimateSchema` is not strict, so a log
written before this still folds and its `tokens` is dropped on replay. Cost is `orchestra metrics`,
after the run, folded from `spend_recorded`. Restoring a prediction means first deciding **which of
the four kinds it is of** and deriving coefficients from committed logs — and the receipt in
`src/testing/receipts/` cannot do that, because it records every spend as `phase: "orchestration"`
with no kinds at all.

## Model cards and what they may price (PLAN-NEXT 2.1–2.5)

`src/providers/modelCard.ts` makes a model a resource with rates: `{id, provider, access, tier,
contextK, costInPer1M, costOutPer1M, verifiedBy}`, loaded from a shipped `providers/` directory and
`<stateDir>/providers/` with the roster's merge (later wins by id, an unparseable file skipped with a
warning). **`verifiedBy` is required at parse** and names a probe transcript relative to
`<stateDir>/providers/` — `probePath` refuses an absolute path or a `..`, because a card is a
hand-edited JSON file and either one turns "verified" into "this path happens to exist".

`orchestra doctor` is the only place a card becomes offerable: `probeProviders` calls each card's
model for one token through `openaiCompatible.ts`, writes the transcript atomically at 0600, and
`verifiedModelCards` narrows the offer to the cards with one on disk. A failed probe writes nothing
— evidence that outlived the thing it was evidence of would keep offering a withdrawn model. A
provider with no key is skipped entirely rather than reported as failed. `staffableCards` does load
and narrow together and is what every composition root calls.

**Three rules on pricing, and the third is the one that will be got wrong.**

- `costUsd` is **absent, never zero**, and only when *both* `input` and `output` are present. Half a
  usage report is not half a bill.
- It is priced against `modelByPhase` — what actually ran — and never `AgentSpec.model`. That
  distinction has already cost a 5× error once: a task specced `claude-sonnet-4-5` ran on
  `claude-opus-4-6` because ACP is not told the spec's choice.
- **A card prices the call this orchestrator makes to that provider, and nothing else.** A worker
  running under `acp/opencode` on a DeepSeek model is billed on *OpenCode's* contract; the card's
  rates are a claim about the provider's own API. In practice the id mismatch does the work — an
  opencode route id is not a nebius model id — but the rule is the reason, not the mechanism.

Nothing is priced today: every current spend path is a subscription CLI or ACP. The first card-priced
spend is stage 4's provider call path, and `missionMetrics(state, cards)` is already shaped for it.

## Model cards are evidence, and a menu is not an allowlist (PLAN-NEXT 2.1–2.5)

**A model card is evidence, and a menu is not an allowlist** (`src/providers/`, PLAN-NEXT 2.1–2.5).
A card is `{id, provider, access, tier, contextK, costInPer1M, costOutPer1M, verifiedBy}` on disk;
`verifiedBy` is required at parse and names a probe transcript under `<stateDir>/providers/`, which
`orchestra doctor` writes by actually calling the model. No transcript, no offer — the
`availability.ts` narrowing, one field along. **`staffableCards` loads and narrows in one call and
every composition root calls it**, for `staffingOffer`'s reason. The bundled `providers/` directory
ships empty, and the base URLs in `PROVIDERS` are addresses to knock at rather than verified claims.

The half that is not guessable: **card ids are shown to synthesis and are not added to `models`.**
`models` is what `inspect()` refuses against, and a card's id is a name at *its provider's* API —
putting one in would offer a Nebius DeepSeek id to `cli/claude`, and constraining `acp/opencode` to
nebius ids would refuse the models it actually runs. Cards go into the prompt as a rendered index
(`modelCardIndex`, budgeted like `rosterIndex`); the door for a card id arrives with the provider
call path. Pricing follows the same caution: `metrics` prices a phase only when `modelByPhase` — what
*ran*, never `AgentSpec.model` — matches a card and both token kinds are present, so a worker billed
on OpenCode's contract stays unpriced rather than charged at somebody else's rate.


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

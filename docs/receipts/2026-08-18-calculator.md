# Receipt: a calculator page

Mission `20260818T120814Z-build-a-simple-calculator-as-a-s`, 2026-08-18, status `complete` at
seq 93. One task, one try, merged at `6b98b6c`. Folded from a live run; numbers below are
`orchestra metrics --staffing` on that log.

## Goal

Build a simple calculator as a single self-contained HTML page with plain JavaScript: buttons
for digits 0–9, plus, minus, multiply, divide, clear and equals, and a display showing the
current entry and the result.

## Contract

Nine criteria, frozen at sign-off. Six were command checks (`node --test` over an extracted
inline script; `1/0` prints `Error`; `parseFloat(x.toPrecision(12))` for rounding). Three
were judge rubrics, convened only after the command checks were green. Every criterion ended
`met` with evidence.

## What ran where

| Seat | Staffed to | Ran on | Calls | Wall | Tokens | Cost |
|---|---|---|---|---|---|---|
| research | orchestrator model | same | 2 | 2m 45s | 12,495 | — |
| architect | `Qwen/Qwen3-30B-A3B-Instruct-2507` (Nebius) | that card | 1 | 31.2s | 6,286 | $0.0012 |
| intake | orchestrator model | same | 1 | 12.2s | 764 | — |
| plan | orchestrator model | same | 3 | 1m 56s | 10,654 | — |
| critique | orchestrator model | same | 2 | 20.4s | 1,349 | — |
| synthesize | orchestrator model | same | 1 | 15.3s | 1,291 | — |
| progress | orchestrator model | same | 2 | 22.3s | 2,169 | — |
| judge | orchestrator model | same | 9 | 5m 13s | 24,990 | — |
| `build-calculator-page-and-tests` | `acp/claude` / `sonnet` | `claude-opus-4-6` | 1 try | 2m 44s | — | — |

The worker was planned as `sonnet` and `acp/claude` answered on `claude-opus-4-6`. That is
the documented `honoursModel: false` behaviour of that lane, recorded rather than hidden.

`plan` ran three times and `critique` twice: one critic objection, one human `revise`. Both
send-back counters are 1, which is the cap.

## Cost

```
complete · 2 rounds · wall 14m 19s
tokens 60,018 measured (in 3,602 · out ≥56,689 · cache 1,436,549) · 273 estimated
```

The factory seat (architect on Qwen3-30B) cost **$0.0012** and 31 seconds. The subscription
seats are unpriced (no card). The judge panel was 42% of measured tokens and 5m 13s of a
14m run — three criteria at three seats each — against 2m 44s for the worker that wrote the
page.

## Evidence

- Six command criteria green; three judge criteria resolved 3–0 (`correctness`,
  `spec-compliance`, `does-it-run`).
- Merged tree served locally: `7+8=` → `15`, `1/0=` → `Error`, `6/4=` → `1.5`, `12-3=` → `9`.
- No decimal button was in the brief; `0.1+0.2` rounding is covered by the test, not the UI.

The log for this mission is not in this repository. The committed replay fixture is a
different run (`src/testing/receipts/`).

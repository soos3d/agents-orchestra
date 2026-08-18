# Model cards

A card is a model this orchestrator can reach through an OpenAI-compatible API, with the
figures a staffing decision is actually made on: how strong it is, how much context it
holds, and what it costs in and out.

**This directory ships empty on purpose.** A card is offered only once `orchestra doctor`
has called the model and written a probe transcript to the path its `verifiedBy` names —
writing rates for a model nobody on this machine has reached would be inventing a menu,
which is the one thing `src/workers/harness.ts` refuses to do. Add yours to
`<stateDir>/providers/` (`.orchestra/providers/` by default); a file there shadows one
here by `id`.

## The file

One JSON file per provider, holding an array of cards:

```json
[
  {
    "id": "the exact string that goes into AgentSpec.model",
    "provider": "nebius",
    "access": "api-key",
    "tier": "worker",
    "contextK": 128,
    "costInPer1M": 0.13,
    "costOutPer1M": 0.4,
    "verifiedBy": "probes/nebius-example.json"
  }
]
```

`provider` must be a key of `PROVIDERS` in `src/providers/openaiCompatible.ts` — that is
where the base URL and the API-key variable name live. `tier` is one of `frontier`,
`strong`, `worker`, `fast`; `access` is `subscription`, `api-key` or `local`.

`verifiedBy` is a relative path under `<stateDir>/providers/`, never absolute and never
with `..`. `orchestra doctor` writes it. Deleting that file is how you un-verify a card by
hand — the next run stops offering it.

A file that does not parse is skipped with a warning rather than failing the run: losing
one card must never cost a mission that would otherwise go.

# Models and providers

Which model does what, and how to change it.

- [Two systems, not one](#two-systems-not-one)
- [Model cards](#model-cards)
- [The probe is the door](#the-probe-is-the-door)
- [Staffing a decision point](#staffing-a-decision-point)
- [What it cost](#what-it-cost)
- [Providers](#providers)
- [Known limits](#known-limits)

---

## Two systems, not one

The orchestrator runs models in two places, and they are configured differently. Reaching for the
wrong one is the most common way to waste an afternoon here.

| | **Decision points** | **Workers** |
|---|---|---|
| What they are | the loop's own thinking — research, architect, intake, plan, critique, synthesize, progress, judge | the agents that write code in a git worktree |
| Where the model comes from | the Agent SDK by default; a **model card** can redirect one to any OpenAI-compatible provider | the harness (`cli/claude`, `acp/opencode`, …) and `AgentSpec.model` |
| How you change it | `--staff <point>=<card id>` | the roster, synthesis, and `MODELS_BY_VENDOR` |

**A card cannot staff a worker.** A card's `id` is a name at *its own provider's* API. Putting card
ids into the worker allowlist would offer a Nebius DeepSeek id to `cli/claude`, and constraining
`acp/opencode` to Nebius ids would refuse the models it actually runs. Cards are a menu shown to
synthesis; `models` stays the allowlist.

**`judge` is not staffable, and the field does not exist.** The judge is the one exception to the
no-tools rule — it opens the artifacts it grades with `Read`/`Glob`/`Grep`. A chat completion holds
no tools and cannot grow them, so a staffed judge returns `met: false` on correct work while
honestly reporting it could not read the files. The refusal is a shape rather than a check somebody
can forget: `--staff judge=…` is rejected at the terminal, and the compose card renders no judge
row.

The seven that are staffable, in `CALL_NAMES` order: `research`, `architect`, `intake`, `plan`,
`critique`, `synthesize`, `progress`.

---

## Model cards

A card is a model with a price, a size, and a proof that it answers. Cards are JSON arrays, so one
file holds as many as you like:

```jsonc
// ~/.orchestra/providers/nebius.json  — or <stateDir>/providers/
[
  {
    "id": "Qwen/Qwen3-30B-A3B-Instruct-2507",
    "provider": "nebius",
    "access": "api-key",
    "tier": "fast",
    "contextK": 262,
    "costInPer1M": 0.1,
    "costOutPer1M": 0.3,
    "verifiedBy": "probes/nebius-qwen3-30b.json"
  }
]
```

| Field | Notes |
|---|---|
| `id` | exactly the string the provider expects, not a display name |
| `provider` | a key of `PROVIDERS` — a card naming one this build has no base URL for can never be probed, so it can never be offered |
| `access` | `subscription` \| `api-key` \| `local` |
| `tier` | `frontier` \| `strong` \| `worker` \| `fast` |
| `contextK` | context window in thousands of tokens |
| `costInPer1M` / `costOutPer1M` | USD per million tokens; these are what `metrics` charges you at |
| `verifiedBy` | path to the probe transcript, relative to `<stateDir>/providers/`. **Required at parse** |

Two directories are merged, the way the agent roster merges: the bundled `providers/` and
`<stateDir>/providers/`, with the local one winning on a name. An unreadable entry is skipped with
a warning rather than raising.

**The bundled `providers/` directory ships empty, and that is the design.** Writing rates for a
model this machine has never reached would be inventing a menu.

The rendered menu is budgeted (`MODEL_CARD_INDEX_BUDGET`, 2000 characters) because every synthesize
call pays for the whole list.

---

## The probe is the door

`verifiedBy` is required at parse, but the transcript is written by `orchestra doctor`. So you name
a path that does not exist yet, then create it by probing:

```bash
set -a && . ./.env && set +a     # the CLI does not read .env — there is no dotenv, by design
orchestra doctor
```

For every card whose provider has a key present, doctor calls the endpoint, confirms the model id
resolves, and writes the transcript at the path `verifiedBy` names — atomically, 0600.

**No transcript, no offer.** This is `workers/availability.ts`'s list-narrowing one field along: a
card nobody has called is not on the menu, exactly as a transport whose binary is missing is not on
the menu. A card naming a model that does not exist fails with the provider's own words and writes
nothing:

```
nebius: 1 of 2 cards verified
  ✗ Qwen/Qwen3-Imaginary  HTTP 404: the model … does not exist
```

With no key present, nothing about a mission changes.

---

## Staffing a decision point

```bash
orchestra run "<goal>" --staff plan=Qwen/Qwen3-30B-A3B-Instruct-2507,critique=<card id>
```

Pairs are `<decision point>=<card id>`, comma-separated. Unstaffed points stay on the Agent SDK,
byte for byte as before — absent staffing is every mission that ran before this existed.

`--staff plan=fast` is also legal: `fast` (or `worker`, `strong`, `frontier`) resolves to the
cheapest probed card of that tier, by `costInPer1M` then `costOutPer1M` then `id`. A card id still
wins if you name one. `--factory` fills every still-empty staffable point with the cheapest probed
`fast` card, or `worker` if none — it never falls through to `strong` or `frontier`. The log records
the resolved id, not the word `fast`, so `resume` re-runs the same card.

The choice is folded onto `mission_created`, like `runtime`, so a `resume` runs on what was chosen
rather than on what the process defaults to.

A card id nobody probed is refused before the log opens. That check is on what a *human* typed;
`inspect()` still refuses a *worker* spec against `models`, and the two lists stay separate for the
reason in [Two systems](#two-systems-not-one).

In the dashboard, the compose card renders one dropdown per staffable point, populated only from
probed cards and enforced again server-side. You cannot choose what you were not shown.

### The provider path

`loop/providerCalls.ts` is `createAgentCalls` with its transport swapped, not a second
implementation — the system prompts (one per decision point), the schema in each prompt, the one
reformat attempt and `CallFormatError` are shared. Two copies of a prompt drift the first time one of them is corrected,
and neither suite can see it.

Two consequences worth knowing:

- **The card is the model, and a requested one is ignored.** `progress` passes `PROGRESS_MODEL`
  (`sonnet`, an Anthropic alias); forwarding that to Nebius would be a 404 on a call that was
  staffed correctly.
- **`resilience.ts` wraps both paths identically.** Decision points fail like networks either way.

---

## What it cost

```bash
orchestra metrics <id> --staffing
```

Per decision point: what it was staffed to, what actually answered, tokens by kind, cost, wall
time, and how many send-backs its answer drew.

```
research    orchestrator model                 1 call   32.3s   2,405 tokens   0 send-backs
intake      orchestrator model                 1 call    1.9s      11 tokens
plan        Qwen/Qwen3-30B-A3B-Instruct-2507   1 call   26.4s   4,034 tokens  $0.0006  0 send-backs
```

Add `--json` for the same rows machine-readable, carrying `staffedTo`, `ranOn` and `costUsd`.

**A phase is priced only when the model that *ran* matches a card and both token kinds are
present.** Never from `AgentSpec.model`, which is what was asked for rather than what answered. A
worker billed on OpenCode's contract stays unpriced rather than charged at somebody else's rate.
ACP workers also stay unpriced — the wire carries no usage, and although the transport now reads
token counts from the agent's own session log (`workers/acp/usage.ts`), the model that ran
(e.g. `claude-opus-4-6`) matches no card. An unpriced row is honest; an estimated one is a
confident claim about someone else's invoice.

---

## Providers

`PROVIDERS` in `src/providers/openaiCompatible.ts`:

| Key | Base URL | Key env var | Status |
|---|---|---|---|
| `nebius` | `https://api.studio.nebius.com/v1` | `NEBIUS_API_KEY` | verified against a live account |
| `ollama-cloud` | `https://ollama.com/v1` | `OLLAMA_API_KEY` | an address to knock at, not yet a capture |

One adapter serves both: chat completions with JSON-schema response format, over `fetch`, with no
SDK dependency. Key *names* come from config; values are threaded in through `Deps`, because
`process.env` is read in exactly two places in this codebase and neither of them is here.

Adding a provider is a row in that table plus a probe that answers.

### Why some lists are empty

`MODELS_BY_VENDOR.openai` is empty because no list of `codex` models has ever been verified.
`MODELS_BY_VENDOR.opencode` is empty for a neighbouring reason: its menu is the human's own account
and arrives on the wire in `session/new`'s `configOptions`, so there is nothing to write down.

**Empty means unknown, everywhere it is read.** Nothing offered, nothing refused. Do not fill one
in from documentation.

---

## Known limits

**A cheap card can be unreliable at authoring an outcome spec.**
`Qwen/Qwen3-30B-A3B-Instruct-2507` returned no criteria at all on four `architect` calls out of
five, including twice on a goal it had handled ten minutes earlier. `writeOutcomeSpec` refuses an
empty spec and the mission ends there. The same card handled `plan` and `critique` first time.
Staff `architect` to something stronger, or leave it unstaffed — and do not read a staffed-architect
failure as a regression without re-running unstaffed first.

**Whether a harness honours `AgentSpec.model` is per agent, and only a capture can say.** It does
not reach `acp/claude` or `acp/codex` — the adapter picks its own, and
`sessionNewResultSchema.models.currentModelId` is the only place the client learns which. It does
reach `acp/opencode`. `Harness.honoursModel` is read off the launch row, never derived from the
transport id, and the compose card says which control is real rather than implying one that does
nothing.

**Rates on a hand-written card are a claim, not a capture.** Nebius's API returns no pricing and its
pricing page is JS-rendered, so the numbers in the example above are unconfirmed. They feed
`costUsd` and nothing else.

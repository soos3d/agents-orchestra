# Chrome MCP transcripts — captured, not documented

Raw JSON-RPC frames from real `chrome-devtools-mcp` sessions on this machine, 2026-08-11, captured
for the Phase 8 spike (§11, ROADMAP Phase 8). Same rule as `../acp-transcripts/`: every `.jsonl`
here is **captured traffic** rather than a shape derived from documentation, because `agentCalls.ts`'s
lesson is that a green suite says nothing about what a real counterparty actually sends.

One JSON object per line, matching the ACP transcripts' shape:

```
{ "t": "<ISO timestamp>", "dir": "out" | "in", "frame": <JSON-RPC frame> }
```

`out` is client → server. The capture client is `spike-client.mjs.txt` — dependency-free, sharing no
code with `src/`, so a fixture cannot agree with our parsers by construction.

**Base64 screenshot payloads are elided**, replaced by their length. A screenshot in a fixture is
30 KB of noise; the fact under test is that the image arrives as *inline content* at all — see below.

| File | What it captures |
|---|---|
| `handshake-and-tools-list.jsonl` | `initialize` → `notifications/initialized` → `tools/list`. The 29 tools are the classifier's entire input. |
| `navigate-snapshot-screenshot-evaluate.jsonl` | A read-only pass: navigate, accessibility snapshot, screenshot, `evaluate_script`. |
| `fill-and-click.jsonl` | `fill` twice, a screenshot, `click` on a link, then an off-page navigation. |
| `fill-form-with-card-and-password.jsonl` | `fill_form` with a card number and a password, then a screenshot — the redaction case (§17). |

## What the spike found, and what each fact costs us

**Package: `chrome-devtools-mcp@1.7.0`, Apache-2.0, Google's own, no runtime dependencies, stdio.**
Pinned exact for the reason the ACP adapters are: `npx` resolves at dispatch time. `protocolVersion`
negotiated as `2025-06-18`; `serverInfo.name` is `chrome_devtools`.

**A screenshot comes back as inline base64 image content, not a path.** §9.1 forbids inlining image
data in the event log — it would make a mission unreplayable within itself — so the transport has to
write the image to the mission's own directory at `0600` and record the path. That is a step nobody
would have specced from the docs, and it is exactly the shape of defect 30: a step nobody owns looks
like a step that works.

**The addressing scheme is an accessibility snapshot, not CSS selectors.** `take_snapshot` returns a
tree of `uid=1_4 textbox "Amount"` nodes, and `click`/`fill` take a `uid`. Two consequences, both
good: the *action* a gate card describes can be rendered from the snapshot in plain language rather
than from a selector, and **rehearsal's per-step page match (§11) can compare snapshots rather than
images** — a text diff that says which control moved, instead of a pixel diff that says something did.

**A tool name does not determine its action class.** `click` on "Read the policy" and `click` on
"Submit expense" are the same tool. So §11's classifier cannot be a name→class table: the class comes
from the *target* resolved through the snapshot, and the plan's "an unknown tool classifies as
`commit`" is a floor rather than the mechanism. `evaluate_script` is the sharp case — arbitrary
JavaScript in the page can submit any form, so it classifies `commit` however innocent the script
looks, or it stays out of the envelope entirely.

**The browser masks `type="password"` for us; it does not mask a card number.** In
`fill-form-with-card-and-password.jsonl` the password renders as bullets in the screenshot and
`4111 1111 1111 1111` renders in full. So §17's "redacted at capture" is concretely about
non-password-typed sensitive inputs — and it has to happen *before* the shot, because the server
hands back a finished image and the snapshot carries no geometry to blur afterwards.

**Panic is affordable.** SIGTERM → process close in **40 ms**, with the Chrome it launched gone
inside 500 ms — comfortably under §10's one-second requirement, using the SIGTERM→SIGKILL path
`runtime/duplex.ts` already implements. The caveat is the other mode: a server attached with
`--browserUrl` is driving *the human's own browser*, which panic must detach from and must never
kill.

**Two server flags are load-bearing rather than cosmetic.** `--usageStatistics` defaults to **true**
and sends data to Google, so `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` is set on every launch — a
mission's browsing is exactly the data §17 says never leaves the machine. `--allowedUrlPattern`
enforces a URL allowlist inside Chrome itself; useful as a second wall, and never the first one,
because §11 requires the allowlist decision in our process where we can record it.

## When to re-capture

On any version bump. `protocol.test.ts`'s counterpart for these files parses them, so a schema that
drifts from what the server actually sends fails the suite rather than a mission.

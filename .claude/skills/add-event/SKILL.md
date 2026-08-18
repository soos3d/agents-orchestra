---
name: add-event
description: Add a new event type to the mission event log. Use when a new fact about a mission, task, worker, or the loop needs to be recorded — the change spans events/schema.ts, events/fold.ts, and a colocated test, in that order.
---

# Adding an event type

Events are the source of truth; everything else is derived. Adding one is a fixed ritual — the
type system enforces most of it, so work in this order and let the compiler drive.

## 1. `src/events/schema.ts`

Add a member to the `z.discriminatedUnion("type", …)`, inside the group it belongs to
(missionLifecycle / contract / loop / tasks / git / humanChannel / runtime). Keep the group
ordering — the union is read as documentation.

- Do **not** include `v`, `seq`, or `at`. Those come from `eventBaseSchema` and are stamped by the
  log; `EventInput` omits them for callers.
- Include `taskId` only if the event is genuinely about one task.
- Payload fields carry the evidence a reader needs to understand what happened without consulting
  another file. Prefer explicit values over ids that must be resolved later.
- Do **not** bump `SCHEMA_VERSION`. It changes only for a breaking reshape of existing events —
  additive types are handled by the "unknown `type` is skipped with a warning" replay rule.

## 2. `src/events/fold.ts`

The handler table is `{ [K in EventType]: Handler<K> }`, so step 1 has just broken the build. That
is the design: every event must state its effect on `MissionState`.

Add the handler. It returns a **new** state — never mutate (`{ ...state, mission: { ...state.mission, … } }`,
`tasks.map(...)`). If the event genuinely has no state effect, return `state` unchanged, with a
one-line comment saying why it is recorded but inert.

Respect the invariants `fold` already asserts during replay: criteria are frozen after signoff,
`deadEnds` and `factsGiven` are append-only. If the new event touches those, it must not violate
them.

## 3. Projections — only if state shape changed

`src/events/projections.ts` writes `mission.json` and `tasks.json`. Touch it only if the new
handler added a field a reader needs. Projections are derived and safe to delete, so they never
need migration.

## 4. Test

Colocate in `src/events/fold.test.ts` (or the test for whatever subsystem emits the event). Open
with a header comment naming the failure mode. Cover:

- The event folds to the expected state from a realistic prior state.
- Replay is stable: `fold(events)` twice gives the same result, and appending then re-reading the
  log round-trips through the schema.
- Any invariant the event could break (frozen criteria, append-only lists) is asserted.

Use `src/testing/fixtures.ts` (`missionCreated`, `fixedClock`, `anEnvelope`, `aBudget`) rather
than hand-rolling state.

## 5. Verify

```
npm run typecheck && npm test
```

Both must pass. A green typecheck is meaningful here — it proves the handler table is exhaustive.

## Emitting it

Callers build the event without `v`/`seq`/`at` and hand it to `createEventLog(...).append(...)`.
`append` is synchronous on purpose — gapless `seq` depends on an in-memory counter advanced only
after the write returns. Never make an emit path async to accommodate a new event.

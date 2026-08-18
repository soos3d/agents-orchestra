// The failure mode this file exists to catch: a wrong fact in semantic memory is
// worse than no memory at all, because it does not fail loudly — it quietly biases
// every future plan while sounding confident (§6).
//
// So the assertions here are mostly refusals. A fact with no provenance is a rumour
// and must not be writable; a `principle` is human-authored only and must not be
// writable by the orchestrator; a fact past its staling clock must come back
// labelled stale rather than fresh. The round trip and the hand-edited-junk case
// guard the other half of §6's bet — that memory is plain markdown a human can open
// and edit, which is only true if a human's edits cannot take the mission down.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  isStale,
  parseLore,
  readLore,
  renderLore,
  writeLore,
  type LoreEntry,
} from "./lore.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-lore-"));
let dir: string;
let caseNo = 0;

beforeEach(() => {
  dir = path.join(tmpRoot, `case-${++caseNo}`, "lore");
});

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<LoreEntry> = {}): LoreEntry {
  return {
    id: "l1",
    claim: "The API client lives in src/net/.",
    type: "observation",
    confidence: "high",
    source: { missionId: "m-42", evidence: "src/net/client.ts", kind: "codebase" },
    observedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderLore / parseLore", () => {
  test("round trips an entry through markdown", () => {
    const original = entry({ staleAfterDays: 7 });

    const parsed = parseLore(renderLore(original));

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.entry, original);
  });

  test("renders the claim as readable body text, not as an escaped field", () => {
    const rendered = renderLore(entry({ claim: "Stripe's webhook retry window is 3 days" }));

    assert.match(rendered, /Stripe's webhook retry window is 3 days/);
    assert.match(rendered, /^type: observation$/m);
  });

  test("a multi-line claim survives the round trip", () => {
    const original = entry({ claim: "Line one.\n\nLine two." });

    const parsed = parseLore(renderLore(original));

    assert.equal(parsed.ok && parsed.entry.claim, "Line one.\n\nLine two.");
  });

  test("junk that a human pasted in is rejected with a problem naming the fix", () => {
    const parsed = parseLore("just some notes I typed here");

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.problem : "", /fix or delete/i);
  });

  test("a header with an unknown type is rejected rather than coerced", () => {
    const broken = renderLore(entry()).replace("type: observation", "type: hunch");

    const parsed = parseLore(broken);

    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.problem : "", /type/);
  });

  test("an entry with no claim body is rejected", () => {
    const broken = renderLore(entry()).replace("The API client lives in src/net/.", "");

    assert.equal(parseLore(broken).ok, false);
  });
});

describe("isStale", () => {
  const observedAt = "2026-01-01T00:00:00.000Z";
  const at = (days: number) => new Date(Date.parse(observedAt) + days * DAY);

  test("an observation is fresh at 30 days and stale just after", () => {
    const it = entry({ type: "observation", observedAt });

    assert.equal(isStale(it, at(30)), false);
    assert.equal(isStale(it, new Date(at(30).getTime() + 1)), true);
  });

  test("research stales on the same 30-day clock", () => {
    const it = entry({ type: "research", observedAt });

    assert.equal(isStale(it, at(29)), false);
    assert.equal(isStale(it, at(31)), true);
  });

  test("a decision is fresh at 180 days and stale just after", () => {
    const it = entry({ type: "decision", observedAt });

    assert.equal(isStale(it, at(180)), false);
    assert.equal(isStale(it, at(181)), true);
  });

  test("a principle never stales, however long it sits", () => {
    const it = entry({ type: "principle", observedAt });

    assert.equal(isStale(it, at(10_000)), false);
  });

  test("staleAfterDays overrides the per-type default", () => {
    const it = entry({ type: "decision", observedAt, staleAfterDays: 7 });

    assert.equal(isStale(it, at(6)), false);
    assert.equal(isStale(it, at(8)), true);
  });

  test("an override cannot make a principle stale", () => {
    const it = entry({ type: "principle", observedAt, staleAfterDays: 1 });

    assert.equal(isStale(it, at(500)), false);
  });
});

describe("writeLore", () => {
  test("writes a readable file a human could edit", () => {
    const result = writeLore(dir, entry(), "orchestrator");

    assert.equal(result.written, true);
    assert.match(fs.readFileSync(result.path, "utf8"), /The API client lives in src\/net\/\./);
  });

  test("refuses a fact with no evidence, naming the fix", () => {
    const bad = entry({ source: { missionId: "m-42", evidence: "  ", kind: "codebase" } });

    assert.throws(
      () => writeLore(dir, bad, "orchestrator"),
      /rumour/i,
      "a fact with no source must not be writable",
    );
  });

  test("refuses a fact with no mission id", () => {
    const bad = entry({ source: { missionId: "", evidence: "src/net/client.ts", kind: "codebase" } });

    assert.throws(() => writeLore(dir, bad, "orchestrator"), /missionId/);
  });

  test("refuses a principle written by the orchestrator", () => {
    assert.throws(
      () => writeLore(dir, entry({ type: "principle" }), "orchestrator"),
      /human/i,
      "§6: principles are human-authored only",
    );
  });

  test("accepts a principle written by a human", () => {
    const result = writeLore(dir, entry({ type: "principle", claim: "Never deploy on a Friday" }), "human");

    assert.equal(result.written, true);
  });

  test("does not write a second file for a claim already recorded", () => {
    writeLore(dir, entry(), "orchestrator");
    const second = writeLore(dir, entry({ id: "l2", confidence: "low" }), "orchestrator");

    assert.equal(second.written, false);
    assert.equal(second.reason, "duplicate");
    assert.equal(fs.readdirSync(dir).length, 1);
  });

  test("directory is 0700 and the file 0600", () => {
    const result = writeLore(dir, entry(), "orchestrator");

    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  });

  test("leaves no temp file behind", () => {
    writeLore(dir, entry(), "orchestrator");

    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
    );
  });
});

describe("readLore", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  test("a missing directory is empty memory, not an error", () => {
    assert.deepEqual(readLore(path.join(dir, "nope"), now), { fresh: [], stale: [] });
  });

  test("partitions what it finds by the staling clock", () => {
    writeLore(dir, entry({ id: "l1", claim: "fresh claim", observedAt: "2026-07-25T00:00:00.000Z" }), "orchestrator");
    writeLore(dir, entry({ id: "l2", claim: "old claim", observedAt: "2026-01-01T00:00:00.000Z" }), "orchestrator");

    const { fresh, stale } = readLore(dir, now);

    assert.deepEqual(
      fresh.map((it) => it.claim),
      ["fresh claim"],
    );
    assert.deepEqual(
      stale.map((it) => it.claim),
      ["old claim"],
    );
  });

  test("a hand-edited file that no longer parses is skipped with a warning, never fatal", () => {
    writeLore(dir, entry({ claim: "still good" }), "orchestrator");
    fs.writeFileSync(path.join(dir, "hand-edited.md"), "I deleted the header by accident\n");
    const warnings: string[] = [];

    const { fresh } = readLore(dir, now, (message) => warnings.push(message));

    assert.deepEqual(
      fresh.map((it) => it.claim),
      ["still good"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /hand-edited\.md/);
  });

  test("ignores files that are not markdown", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "not lore");
    const warnings: string[] = [];

    const { fresh, stale } = readLore(dir, now, (message) => warnings.push(message));

    assert.deepEqual({ fresh, stale, warnings }, { fresh: [], stale: [], warnings: [] });
  });
});

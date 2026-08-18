// The failure mode: the index quietly becoming the thing it was built to avoid.
//
// This is the one text in the system that every synthesize call of every mission pays
// for, and it is paid per task — so the tests that matter are about what is *in* it and
// how big it is. A body leaking into the index would put 267 lines back into the
// orchestrator's context and delete the entire saving. A roster that grows past its
// budget would do the same by increments nobody notices, which is why the shipped
// roster is asserted against a hard number here rather than trusted to review.
//
// The resolution half is tested for the rule it enforces: `basedOn` contributes a
// system prompt and nothing else. A promoted profile carries a full validated spec —
// transport, tools, a lease — and letting any of that ride in on a name would smuggle
// an old mission's capabilities into a new mission's envelope.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ROSTER_INDEX_BUDGET,
  composeSystemPrompt,
  offeredRoles,
  resolveRole,
  rosterIndex,
} from "./offer.js";
import { loadRoster, rosterDir, type RosterEntry } from "./roster.js";
import { anAgentSpec } from "../testing/fixtures.js";
import { type Profile } from "../memory/profiles.js";

const anEntry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  name: "code-reviewer",
  description: "Reviews a diff for correctness and security.",
  worker: "review",
  suggests: ["fs.read"],
  body: "You are a code reviewer.\n\nRead the diff and report what is wrong.",
  ...over,
});

const aProfile = (over: Partial<Profile> = {}): Profile => ({
  name: "invoice-reconciler",
  spec: { ...anAgentSpec(), role: "Reconciles invoices against ledger entries.", worker: "research" },
  promotedFrom: { missionId: "m1", taskId: "t1" },
  promotedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("rosterIndex", () => {
  test("renders one line per role and never the body", () => {
    const index = rosterIndex([anEntry()]);

    assert.match(index, /code-reviewer/);
    assert.match(index, /Reviews a diff/);
    assert.match(index, /review/);
    // The whole design rests on this: the orchestrator is shown the description and
    // the worker is shown the body, and the two never meet in one context.
    assert.ok(!index.includes("Read the diff and report what is wrong."));
  });

  test("an empty roster renders to nothing rather than to a header with no rows", () => {
    // A prompt carrying "roles: (none)" spends context telling the model about a
    // library that does not exist — the argument that keeps `profiles` omitted.
    assert.equal(rosterIndex([]), "");
  });
});

describe("offeredRoles", () => {
  test("promoted profiles join the same index as bundled entries", () => {
    const roles = offeredRoles([anEntry()], [aProfile()]);

    assert.deepEqual(
      roles.map((role) => role.name).sort(),
      ["code-reviewer", "invoice-reconciler"],
    );
  });

  test("a promoted profile is described by its role, which is the sentence it has", () => {
    const [role] = offeredRoles([], [aProfile()]);
    assert.equal(role?.description, "Reconciles invoices against ledger entries.");
    assert.equal(role?.worker, "research");
  });

  test("a promoted profile shadows a bundled entry of the same name", () => {
    // A human promoting a role they had already shipped is correcting it, and the
    // correction is the more recent statement of intent.
    const roles = offeredRoles(
      [anEntry({ name: "shared", description: "the shipped one" })],
      [aProfile({ name: "shared" })],
    );

    assert.equal(roles.length, 1);
    assert.equal(roles[0]?.description, "Reconciles invoices against ledger entries.");
  });

  test("a description too long for the budget is truncated, never dropped", () => {
    // A profile's `role` was written for a human and answers to no cap, so the index
    // has to bound it. Dropping the role instead would make a promoted agent silently
    // unavailable, which is the worse failure.
    const long = "x".repeat(400);
    const [role] = offeredRoles([], [aProfile({ spec: { ...anAgentSpec(), role: long } })]);

    assert.ok((role?.description.length ?? 0) < long.length);
    assert.match(role?.description ?? "", /…$/);
  });
});

describe("resolveRole", () => {
  test("finds a role by name", () => {
    const roles = offeredRoles([anEntry()], []);
    assert.equal(resolveRole(roles, "code-reviewer")?.name, "code-reviewer");
  });

  test("an unknown name resolves to nothing, so synthesis can refuse it", () => {
    assert.equal(resolveRole(offeredRoles([anEntry()], []), "nope"), undefined);
  });

  test("a promoted profile contributes its system prompt and none of its capabilities", () => {
    const profile = aProfile();
    const [role] = offeredRoles([], [profile]);

    assert.equal(role?.body, profile.spec.systemPrompt);
    // Transport, tools, lease and model are the *new* mission's to decide and are
    // validated against its envelope. A name may not carry them across.
    assert.ok(!Object.hasOwn(role ?? {}, "tools"));
    assert.ok(!Object.hasOwn(role ?? {}, "transport"));
  });
});

describe("composeSystemPrompt", () => {
  test("the role comes first and the task-specific part after it", () => {
    const composed = composeSystemPrompt("You are a reviewer.", "Review src/auth.ts only.");

    assert.ok(composed.indexOf("You are a reviewer.") < composed.indexOf("Review src/auth.ts"));
    assert.match(composed, /Review src\/auth\.ts only\./);
  });

  test("an empty addendum leaves the role prompt alone", () => {
    assert.equal(composeSystemPrompt("You are a reviewer.", "   "), "You are a reviewer.");
  });
});

describe("the shipped roster", () => {
  test("fits the index budget every synthesize call pays", () => {
    const index = rosterIndex(offeredRoles(loadRoster([rosterDir()]), []));

    assert.ok(
      index.length <= ROSTER_INDEX_BUDGET,
      `The shipped roster index is ${index.length} chars, over the ${ROSTER_INDEX_BUDGET} ` +
        `budget. Every synthesize call of every mission pays this. Remove an entry or ` +
        `shorten a description rather than raising the budget.`,
    );
  });

  test("ships at least one role, or the feature is switched off in packaging", () => {
    assert.ok(loadRoster([rosterDir()]).length > 0);
  });
});

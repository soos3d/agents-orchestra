// The failure mode under test: a mid-run permission request that nobody can answer,
// or that two surfaces answer at once.
//
// A running agent asking for a capability is the one place in the system where a
// worker *awaits* a human, and an await is where races live. Two surfaces may answer
// the same request (§10's one inbox, one level down), an answer may arrive twice from
// a carrier that retried, and under `--unattended` nobody answers at all. All three
// have to end with exactly one `permission_resolved` on the log and exactly one
// settled promise — never a hang, never a throw.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type EventInput } from "../../events/schema.js";
import { createPermissionPort } from "./permissionPort.js";

function recorder() {
  const inputs: EventInput[] = [];
  return { inputs, emit: (input: EventInput) => void inputs.push(input) };
}

const typed = (inputs: readonly EventInput[], type: string): EventInput[] =>
  inputs.filter((input) => input.type === type);

describe("the acp permission port", () => {
  test("emits permission_requested against the asking task", async () => {
    const log = recorder();
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      ask: async () => true,
    });

    await port.requestPermission("t1", { tool: "Write", detail: "src/clamp.ts" });

    const [requested] = typed(log.inputs, "permission_requested");
    assert.ok(requested);
    assert.equal(requested.taskId, "t1");
    assert.equal(requested.actor, "worker");
    assert.deepEqual(
      { tool: (requested as { tool: string }).tool, detail: (requested as { detail: string }).detail },
      { tool: "Write", detail: "src/clamp.ts" },
    );
  });

  // PLAN-NEXT 7.3. This channel exists for exactly the call that carries a credential —
  // an agent asking to run `curl -H "Authorization: Bearer …"` — and the request it
  // quotes is written to the log and rendered on whatever surface answers. Scrubbed
  // before either, so the human still sees which variable is in the call and the log
  // never sees the value.
  test("a granted value in the quoted tool call reaches neither the log nor the surface", async () => {
    const log = recorder();
    const shown: string[] = [];
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      ask: async (request) => {
        shown.push(request.detail);
        return true;
      },
      secrets: [{ name: "STRIPE_KEY", value: "sk_live_9d8f7a6b5c4d" }],
    });

    // Both fields. OpenCode's permission frame carries no tool name and its later
    // updates rewrite the title to what the tool is *doing* — `bash` became `ls -la` in
    // the capture — so `tool` is a command string often enough that scrubbing only the
    // detail would leave the same value on the same event one field along.
    await port.requestPermission("t1", {
      tool: 'curl -H "Authorization: Bearer sk_live_9d8f7a6b5c4d"',
      detail: 'curl -H "Authorization: Bearer sk_live_9d8f7a6b5c4d" https://api.stripe.com',
    });

    const [requested] = typed(log.inputs, "permission_requested");
    const detail = (requested as unknown as { detail: string }).detail;
    const tool = (requested as unknown as { tool: string }).tool;
    assert.equal(detail.includes("sk_live_9d8f7a6b5c4d"), false, "the key is on the log");
    assert.equal(tool.includes("sk_live_9d8f7a6b5c4d"), false, "the key is in the tool name");
    assert.match(tool, /\[redacted:STRIPE_KEY\]/);
    assert.match(detail, /\[redacted:STRIPE_KEY\]/);
    assert.deepEqual(shown, [detail], "the surface was shown something else than the log");
  });

  test("request ids are unique per request, so two in flight cannot answer each other", async () => {
    const log = recorder();
    const seen: string[] = [];
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      ask: async (request) => {
        seen.push(request.requestId);
        return true;
      },
    });

    await port.requestPermission("t1", { tool: "Write", detail: "a" });
    await port.requestPermission("t1", { tool: "Bash", detail: "b" });

    assert.equal(new Set(seen).size, 2);
  });

  test("an approval from the human resolves the request and records it once", async () => {
    const log = recorder();
    const port = createPermissionPort({ emit: log.emit, missionId: "m1", ask: async () => true });

    assert.equal(await port.requestPermission("t1", { tool: "Write", detail: "x" }), true);

    const resolved = typed(log.inputs, "permission_resolved");
    assert.equal(resolved.length, 1);
    assert.equal((resolved[0] as { approved: boolean }).approved, true);
  });

  test("a refusal from the human is a rejection, not an error", async () => {
    const log = recorder();
    const port = createPermissionPort({ emit: log.emit, missionId: "m1", ask: async () => false });

    assert.equal(await port.requestPermission("t1", { tool: "Bash", detail: "rm -rf /" }), false);
    assert.equal((typed(log.inputs, "permission_resolved")[0] as { approved: boolean }).approved, false);
  });

  // Nobody is there. §9.4's shape rather than §11's: the worker gets a decision it can
  // report on, and the replan can see *why* — a hang would cost the whole session.
  test("with no human at all the request is denied rather than awaited", async () => {
    const log = recorder();
    const port = createPermissionPort({ emit: log.emit, missionId: "m1" });

    assert.equal(await port.requestPermission("t1", { tool: "Write", detail: "x" }), false);

    const [resolved] = typed(log.inputs, "permission_resolved");
    assert.equal((resolved as { approved: boolean }).approved, false);
    assert.match(String((resolved as { reason?: string }).reason), /unattended/i);
  });

  // The `resolve` handle is what a surface holding the port calls; the pending map is
  // keyed by the request id so a second surface answering a *different* request cannot
  // settle this one.
  test("a surface resolving by id settles the awaiting request", async () => {
    const log = recorder();
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      ask: () => new Promise<boolean>(() => {}), // a surface that never answers
    });

    const decision = port.requestPermission("t1", { tool: "Write", detail: "x" });
    const [requestId] = port.pending();
    assert.ok(requestId);

    assert.equal(port.resolve(requestId, true), true);
    assert.equal(await decision, true);
    assert.equal(typed(log.inputs, "permission_resolved").length, 1);
  });

  // A second surface answering late is normal, not corruption (§10 — the same human
  // reachable two ways). It is dropped with a warning, and it must not throw into a
  // socket handler or emit a second resolution over a request that already ran.
  test("a second resolution for the same request is ignored with a warning", async () => {
    const log = recorder();
    const warnings: string[] = [];
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      ask: async () => true,
      onWarn: (message) => void warnings.push(message),
    });

    await port.requestPermission("t1", { tool: "Write", detail: "x" });
    const requestId = (typed(log.inputs, "permission_requested")[0] as { requestId: string }).requestId;

    assert.equal(port.resolve(requestId, false), false);
    assert.equal(typed(log.inputs, "permission_resolved").length, 1);
    assert.match(warnings.join("\n"), /no open permission request/i);
  });

  test("a resolution for an unknown id is ignored with a warning rather than throwing", () => {
    const log = recorder();
    const warnings: string[] = [];
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      onWarn: (message) => void warnings.push(message),
    });

    assert.equal(port.resolve("perm-nope-1", true), false);
    assert.equal(log.inputs.length, 0);
    assert.match(warnings.join("\n"), /perm-nope-1/);
  });

  // The terminal port rejects when standard input ended, precisely so the browser can
  // still win the race (CLAUDE.md: "end of input is not approval"). A rejection here is
  // therefore "not this surface", never "denied" — the request stays open for another.
  test("a surface that rejects leaves the request open for another one", async () => {
    const log = recorder();
    const warnings: string[] = [];
    const port = createPermissionPort({
      emit: log.emit,
      missionId: "m1",
      ask: async () => {
        throw new Error("standard input ended");
      },
      onWarn: (message) => void warnings.push(message),
    });

    const decision = port.requestPermission("t1", { tool: "Write", detail: "x" });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(typed(log.inputs, "permission_resolved").length, 0);
    assert.equal(port.pending().length, 1);
    assert.match(warnings.join("\n"), /standard input ended/);

    port.resolve(port.pending()[0]!, true);
    assert.equal(await decision, true);
  });

  test("a resolved request leaves the pending set", async () => {
    const log = recorder();
    const port = createPermissionPort({ emit: log.emit, missionId: "m1", ask: async () => true });

    await port.requestPermission("t1", { tool: "Write", detail: "x" });

    assert.deepEqual(port.pending(), []);
  });
});

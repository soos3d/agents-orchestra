// The failure mode under test: a fake counterparty that agrees with our client because
// both were written from the same wrong idea.
//
// This scripted agent exists so an `AcpWorker` can be tested without a subscription, a
// login, or a model — and a fake that speaks a dialect nobody sends would make every
// transport test a tautology. So its frames are copied from the captures in
// `acp-transcripts/`, and the round trip below is driven entirely through `protocol.ts`:
// if the fake and the parsers ever disagree, this test is where it shows up rather than
// on a real mission. The child is a plain `.mjs` spawned as a real subprocess, because a
// stub that speaks in-process would skip framing, backpressure, and exit handling —
// which is most of what the transport actually has to get right.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spawnDuplex, type DuplexProcess } from "../runtime/duplex.js";
import {
  classifyFrame,
  initializeRequest,
  parseFrames,
  parseInitializeResult,
  parseRequestPermissionParams,
  parseSessionNewResult,
  parseSessionPromptResult,
  parseSessionUpdate,
  permissionResponse,
  sessionNewRequest,
  sessionPromptRequest,
  writeTextFileResponse,
} from "../workers/acp/protocol.js";
import { fakeAcpAgent } from "./acpAgent.js";

interface RoundTrip {
  readonly initializeResult: ReturnType<typeof parseInitializeResult>;
  readonly sessionId: string;
  readonly stopReason: string;
  readonly text: string;
  readonly toolCallStatuses: string[];
  readonly written: { path: string; content: string }[];
  readonly warnings: string[];
}

/**
 * A minimal ACP client — the smallest thing that can hold a real session — built only
 * from `protocol.ts`'s exports, so the assertion is about both halves at once.
 */
async function roundTrip(
  proc: DuplexProcess,
  options: { permission?: "allow" | "reject" } = {},
): Promise<RoundTrip> {
  const warnings: string[] = [];
  const chunks: string[] = [];
  const toolCallStatuses: string[] = [];
  const written: { path: string; content: string }[] = [];
  const pending = new Map<number, (result: unknown) => void>();

  const send = (frame: unknown) => proc.stdin.write(JSON.stringify(frame) + "\n");
  const request = (frame: { id: number }) =>
    new Promise<unknown>((resolve) => {
      pending.set(frame.id, resolve);
      send(frame);
    });

  let rest = "";
  proc.stdout.on("data", (data: Buffer) => {
    const step = parseFrames(rest + data.toString());
    rest = step.rest;

    for (const frame of step.frames) {
      const classified = classifyFrame(frame);

      if (classified.kind === "result") {
        pending.get(classified.id as number)?.(classified.result);
        pending.delete(classified.id as number);
        continue;
      }

      if (classified.kind === "request" && classified.method === "session/request_permission") {
        const params = parseRequestPermissionParams(classified.params);
        const wanted = options.permission === "reject" ? "reject_once" : "allow_once";
        const option = params.options.find((o) => o.kind === wanted) ?? params.options[0];
        send(permissionResponse(classified.id as number, option.optionId));
        continue;
      }

      if (classified.kind === "request" && classified.method === "fs/write_text_file") {
        const params = classified.params as { path: string; content: string };
        written.push({ path: params.path, content: params.content });
        send(writeTextFileResponse(classified.id as number));
        continue;
      }

      if (classified.kind === "notification" && classified.method === "session/update") {
        const update = parseSessionUpdate(classified.params, (message) => warnings.push(message));
        if (update.kind === "message_chunk") chunks.push(update.text);
        if (update.kind === "tool_call_update" && update.status !== undefined) {
          toolCallStatuses.push(update.status);
        }
      }
    }
  });

  const initializeResult = parseInitializeResult(
    await request(initializeRequest(1, { name: "fable-orchestra", version: "0.0.0" })),
  );
  const { sessionId } = parseSessionNewResult(await request(sessionNewRequest(2, process.cwd())));
  const { stopReason } = parseSessionPromptResult(
    await request(sessionPromptRequest(3, sessionId, "do the thing")),
  );

  return {
    initializeResult,
    sessionId,
    stopReason,
    text: chunks.join(""),
    toolCallStatuses,
    written,
    warnings,
  };
}

function spawnFake(options: Parameters<typeof fakeAcpAgent>[0]): DuplexProcess {
  const agent = fakeAcpAgent(options);
  return spawnDuplex(agent.command, agent.args, {
    cwd: process.cwd(),
    env: agent.env,
    timeoutMs: 10_000,
  });
}

describe("the scripted acp agent", () => {
  test("the happy scenario completes a full session through protocol.ts", async () => {
    const report = JSON.stringify({ outcome: "completed", summary: "did it" });
    const proc = spawnFake({ scenario: "happy", finalText: report });

    try {
      const result = await roundTrip(proc);

      assert.equal(result.initializeResult.protocolVersion, 1);
      assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
      assert.equal(result.stopReason, "end_turn");
      // Streamed as several chunks, exactly as the captures do — the transport has to
      // concatenate before it can parse a WorkerReport out of it (§4.1).
      assert.equal(result.text, report);
      assert.deepEqual(result.warnings, []);
    } finally {
      await proc.kill();
    }
  });

  test("the permission scenario gates, then writes through the client on allow", async () => {
    const proc = spawnFake({ scenario: "permission", finalText: "wrote it", writePath: "/tmp/fake-acp-hello.txt" });

    try {
      const result = await roundTrip(proc, { permission: "allow" });

      assert.deepEqual(result.written, [{ path: "/tmp/fake-acp-hello.txt", content: "hi" }]);
      assert.deepEqual(result.toolCallStatuses, ["completed"]);
      assert.equal(result.text, "wrote it");
      assert.equal(result.stopReason, "end_turn");
    } finally {
      await proc.kill();
    }
  });

  // The rejected capture's shape: the tool call fails, nothing is written, and the turn
  // still ends `end_turn` — which is why a stopReason alone never means success.
  test("a rejected permission fails the tool call and writes nothing", async () => {
    const proc = spawnFake({ scenario: "permission", rejectedText: "not allowed" });

    try {
      const result = await roundTrip(proc, { permission: "reject" });

      assert.deepEqual(result.written, []);
      assert.deepEqual(result.toolCallStatuses, ["failed"]);
      assert.equal(result.text, "not allowed");
      assert.equal(result.stopReason, "end_turn");
    } finally {
      await proc.kill();
    }
  });

  test("the prose scenario returns text that is not a WorkerReport", async () => {
    const proc = spawnFake({ scenario: "prose" });

    try {
      const result = await roundTrip(proc);

      assert.equal(result.stopReason, "end_turn");
      assert.throws(() => JSON.parse(result.text));
    } finally {
      await proc.kill();
    }
  });

  test("the hang scenario handshakes and then never answers the prompt", async () => {
    const proc = spawnFake({ scenario: "hang" });

    try {
      const raced = await Promise.race([
        roundTrip(proc).then(() => "answered"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 300)),
      ]);

      assert.equal(raced, "still waiting");
    } finally {
      await proc.kill();
    }
  });

  test("the disconnect scenario exits non-zero mid-turn", async () => {
    const proc = spawnFake({ scenario: "disconnect" });

    void roundTrip(proc).catch(() => undefined);
    const exit = await proc.exited;

    assert.equal(exit.code, 1);
  });
});

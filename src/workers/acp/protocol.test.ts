// The failure mode under test: a schema written from documentation rather than from
// traffic, which parses every example in the spec and rejects the first frame a real
// agent sends. That is `agentCalls.ts`'s lesson one layer down — a green suite says
// nothing about what a counterparty actually puts on the wire.
//
// So the transcripts in `src/testing/acp-transcripts/` are executable fixtures rather
// than reading material: every test below feeds *captured* frames through the parsers,
// and a real frame that fails `safeParse` fails the suite. Three agents are covered
// (claude-code-acp 0.16.2, codex-acp 0.16.0 and opencode 1.18.18), which is what makes an
// over-tightened optional field visible — and what proved these are three dialects and
// not one: OpenCode answers `session/new` with `configOptions` and no `models`, and its
// permission options are `once`/`always`/`reject` rather than Claude's ids.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  AcpProtocolError,
  classifyFrame,
  fsReadTextFileParamsSchema,
  fsWriteTextFileParamsSchema,
  initializeRequest,
  methodNotFoundResponse,
  parseFrames,
  parseInitializeResult,
  parseRequestPermissionParams,
  parseSessionNewResult,
  parseSessionPromptResult,
  parseSessionUpdate,
  permissionResponse,
  readTextFileResponse,
  sessionNewRequest,
  sessionPromptRequest,
  writeTextFileResponse,
} from "./protocol.js";

const TRANSCRIPT_DIR = fileURLToPath(new URL("../../testing/acp-transcripts/", import.meta.url));

interface Line {
  readonly dir: string;
  // The captured JSON-RPC frame, or a raw stderr string.
  readonly frame: unknown;
}

function transcript(file: string): Line[] {
  return readFileSync(TRANSCRIPT_DIR + file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
}

function allTranscripts(): { file: string; lines: Line[] }[] {
  return readdirSync(TRANSCRIPT_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((file) => ({ file, lines: transcript(file) }));
}

/** Every captured agent→client frame, with its source file for the assertion message. */
function inbound(): { file: string; frame: Record<string, unknown> }[] {
  return allTranscripts().flatMap(({ file, lines }) =>
    lines
      .filter((line) => line.dir === "in" && typeof line.frame === "object" && line.frame !== null)
      .map((line) => ({ file, frame: line.frame as Record<string, unknown> })),
  );
}

function inboundRequests(method: string): Record<string, unknown>[] {
  return inbound()
    .map(({ frame }) => frame)
    .filter((frame) => frame["method"] === method);
}

/** The result of the client request with `id`, from the file that made it. */
function resultOf(file: string, method: string): unknown {
  const lines = transcript(file);
  const request = lines.find(
    (line) =>
      line.dir === "out" && (line.frame as Record<string, unknown> | null)?.["method"] === method,
  );
  assert.ok(request, `no ${method} request captured in ${file}`);
  const id = (request.frame as Record<string, unknown>)["id"];
  const response = lines.find(
    (line) =>
      line.dir === "in" &&
      (line.frame as Record<string, unknown> | null)?.["id"] === id &&
      (line.frame as Record<string, unknown>)["result"] !== undefined,
  );
  assert.ok(response, `no result for ${method} captured in ${file}`);
  return (response.frame as Record<string, unknown>)["result"];
}

describe("acp ndjson framing", () => {
  test("splits complete lines and keeps the partial tail", () => {
    const { frames, rest } = parseFrames('{"a":1}\n{"b":2}\n{"c":');

    assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
    assert.equal(rest, '{"c":');
  });

  test("a frame split across two reads parses once its tail arrives", () => {
    const first = parseFrames('{"jsonrpc":"2.0","id":1,"met');
    assert.deepEqual(first.frames, []);

    const second = parseFrames(first.rest + 'hod":"x","params":{}}\n');
    assert.deepEqual(second.frames, [{ jsonrpc: "2.0", id: 1, method: "x", params: {} }]);
    assert.equal(second.rest, "");
  });

  test("ignores blank lines rather than treating them as frames", () => {
    assert.deepEqual(parseFrames("\n\n{\"a\":1}\n").frames, [{ a: 1 }]);
  });

  // A line that is not JSON is the agent writing diagnostics to the protocol channel.
  // It names the line, because "unexpected token" with no context is unactionable.
  test("a malformed line raises with the offending text in the message", () => {
    assert.throws(() => parseFrames("not json at all\n"), (err: unknown) => {
      assert.ok(err instanceof AcpProtocolError);
      assert.match(err.message, /not json at all/);
      return true;
    });
  });

  test("every captured frame survives a byte-at-a-time feed", () => {
    for (const { file, lines } of allTranscripts()) {
      const wire = lines
        .filter((line) => line.dir === "in" && typeof line.frame === "object")
        .map((line) => JSON.stringify(line.frame) + "\n")
        .join("");

      let rest = "";
      const seen: unknown[] = [];
      for (const char of wire) {
        const step = parseFrames(rest + char);
        seen.push(...step.frames);
        rest = step.rest;
      }

      assert.equal(rest, "", `${file} left a partial frame`);
      assert.equal(
        seen.length,
        lines.filter((line) => line.dir === "in" && typeof line.frame === "object").length,
        `${file} lost a frame`,
      );
    }
  });
});

describe("acp outbound frames", () => {
  // The captured handshake is the assertion: what we build has to be byte-identical in
  // shape to what the two agents actually answered, or the transcripts prove nothing.
  test("initialize matches the captured handshake", () => {
    const captured = transcript("claude-write-file-approved.jsonl").find(
      (line) => line.dir === "out" && (line.frame as Record<string, unknown>)["method"] === "initialize",
    );

    assert.deepEqual(initializeRequest(1, { name: "fable-orchestra-spike", version: "0.0.0" }), captured?.frame);
  });

  test("session/new sends the cwd and an empty mcpServers list", () => {
    assert.deepEqual(sessionNewRequest(2, "/tmp/acp-spike/work-claude"), {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp/acp-spike/work-claude", mcpServers: [] },
    });
  });

  test("session/prompt wraps the text in one content block", () => {
    assert.deepEqual(sessionPromptRequest(3, "sess-1", "do the thing"), {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "sess-1", prompt: [{ type: "text", text: "do the thing" }] },
    });
  });

  test("a permission answer selects an option by id", () => {
    assert.deepEqual(permissionResponse(0, "allow"), {
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
  });

  // Captured: the agent's `fs/write_text_file` is answered with a literal null result,
  // and an omitted `result` is a different frame that leaves the agent waiting.
  test("fs/write_text_file is answered with a null result", () => {
    const answer = writeTextFileResponse(1);

    assert.deepEqual(answer, { jsonrpc: "2.0", id: 1, result: null });
    assert.ok("result" in answer);
  });

  test("fs/read_text_file is answered with the file content", () => {
    assert.deepEqual(readTextFileResponse(4, "hi"), {
      jsonrpc: "2.0",
      id: 4,
      result: { content: "hi" },
    });
  });

  test("a method we do not implement is refused as JSON-RPC method-not-found", () => {
    const refusal = methodNotFoundResponse(7, "terminal/create");

    assert.equal(refusal.id, 7);
    assert.equal(refusal.error.code, -32601);
    assert.match(refusal.error.message, /terminal\/create/);
  });
});

describe("acp frame classification", () => {
  test("classifies every captured agent frame", () => {
    const kinds = new Set<string>();
    for (const { file, frame } of inbound()) {
      const classified = classifyFrame(frame);
      assert.notEqual(classified.kind, "unknown", `${file}: ${JSON.stringify(frame).slice(0, 120)}`);
      kinds.add(classified.kind);
    }

    // All four shapes appear in the captures: results, an error result (codex over its
    // usage limit), agent-initiated requests, and notifications.
    assert.deepEqual([...kinds].sort(), ["error", "notification", "request", "result"]);
  });

  test("a frame that is not JSON-RPC at all classifies as unknown rather than throwing", () => {
    assert.equal(classifyFrame({ hello: "world" }).kind, "unknown");
    assert.equal(classifyFrame("a string").kind, "unknown");
  });
});

describe("acp results", () => {
  test("initialize results from both agents parse", () => {
    for (const file of ["claude-write-file-approved.jsonl", "codex-initialize-and-session-new.jsonl"]) {
      const parsed = parseInitializeResult(resultOf(file, "initialize"));
      assert.equal(parsed.protocolVersion, 1);
    }
  });

  // Both agents identify themselves, so `agentInfo` is optional out of caution rather
  // than out of a capture — nothing branches on it, and a required field on data no
  // decision reads is a mission that fails for a diagnostic.
  test("agentInfo names the agent, and the two agents disagree about everything else", () => {
    const codex = parseInitializeResult(resultOf("codex-initialize-and-session-new.jsonl", "initialize"));
    const claude = parseInitializeResult(resultOf("claude-write-file-approved.jsonl", "initialize"));

    assert.equal(codex.agentInfo?.name, "codex-acp");
    assert.equal(claude.agentInfo?.name, "@zed-industries/claude-code-acp");
  });

  // codex's session/new result carries `modes` and `configOptions`; claude's carries
  // `models` and `modes`. Unknown keys are stripped rather than refused, which is what
  // keeps one client working against two agents that share only `sessionId`.
  test("extra result keys neither agent shares are stripped, not refused", () => {
    const codex = parseSessionNewResult(resultOf("codex-initialize-and-session-new.jsonl", "session/new"));

    assert.deepEqual(Object.keys(codex), ["sessionId"]);
  });

  test("session/new results from both agents yield a sessionId", () => {
    for (const file of ["claude-write-file-approved.jsonl", "codex-initialize-and-session-new.jsonl"]) {
      assert.match(parseSessionNewResult(resultOf(file, "session/new")).sessionId, /^[0-9a-f-]{36}$/);
    }
  });

  test("session/prompt returns a stopReason and nothing else we can bill", () => {
    const result = resultOf("claude-write-file-approved.jsonl", "session/prompt");

    assert.equal(parseSessionPromptResult(result).stopReason, "end_turn");
    // The captured fact behind the header note: no usage, no tokens, no cost.
    assert.deepEqual(Object.keys(result as object), ["stopReason"]);
  });

  test("a result missing its required field raises with the fix named", () => {
    assert.throws(() => parseSessionNewResult({ notASession: true }), (err: unknown) => {
      assert.ok(err instanceof AcpProtocolError);
      assert.match(err.message, /sessionId/);
      return true;
    });
  });
});

describe("acp session/update", () => {
  function updates(file: string): { update: unknown }[] {
    return transcript(file)
      .filter(
        (line) =>
          line.dir === "in" && (line.frame as Record<string, unknown>)["method"] === "session/update",
      )
      .map((line) => (line.frame as { params: { update: unknown } }).params);
  }

  test("every captured update parses without a warning about its shape", () => {
    const warnings: string[] = [];
    const kinds = new Set<string>();

    for (const { file, lines } of allTranscripts()) {
      void lines;
      for (const params of updates(file)) {
        kinds.add(parseSessionUpdate(params, (message) => warnings.push(`${file}: ${message}`)).kind);
      }
    }

    assert.deepEqual(warnings, []);
    assert.deepEqual([...kinds].sort(), ["ignored", "message_chunk", "tool_call", "tool_call_update"]);
  });

  test("an agent_message_chunk yields its text", () => {
    const chunks = updates("claude-write-file-approved.jsonl")
      .map((params) => parseSessionUpdate(params, () => undefined))
      .filter((update) => update.kind === "message_chunk");

    assert.equal(
      chunks.map((chunk) => (chunk.kind === "message_chunk" ? chunk.text : "")).join(""),
      "The file `hello.txt` has been created with the text `hi`.",
    );
  });

  test("a tool_call carries its id, title, kind, status and the tool name claude tags on", () => {
    const calls = updates("claude-write-file-approved.jsonl")
      .map((params) => parseSessionUpdate(params, () => undefined))
      .filter((update) => update.kind === "tool_call");

    const first = calls[0];
    assert.ok(first?.kind === "tool_call");
    assert.equal(first.toolCallId, "toolu_01TtVMWkrNarTF4HgaASvpiT");
    assert.equal(first.title, "Write");
    assert.equal(first.toolKind, "edit");
    assert.equal(first.status, "pending");
    assert.equal(first.toolName, "mcp__acp__Write");
  });

  test("the bash capture is a kind: execute tool call, not an edit", () => {
    const calls = updates("claude-bash-execute-approved.jsonl")
      .map((params) => parseSessionUpdate(params, () => undefined))
      .filter((update) => update.kind === "tool_call");

    assert.ok(calls.every((call) => call.kind === "tool_call" && call.toolKind === "execute"));
  });

  // Captured: a `tool_call_update` may carry no status at all, and `rawOutput` is a
  // string in one capture and an array in another. Anything tighter rejects live traffic.
  test("tool_call_update tolerates a missing status and either rawOutput shape", () => {
    const rejected = updates("claude-write-file-rejected.jsonl")
      .map((params) => parseSessionUpdate(params, () => undefined))
      .filter((update) => update.kind === "tool_call_update");

    assert.ok(rejected.some((update) => update.kind === "tool_call_update" && update.status === "failed"));

    const approved = updates("claude-bash-execute-approved.jsonl")
      .map((params) => parseSessionUpdate(params, () => undefined))
      .filter((update) => update.kind === "tool_call_update");

    assert.ok(approved.some((update) => update.kind === "tool_call_update" && update.status === undefined));
    assert.ok(approved.some((update) => update.kind === "tool_call_update" && update.status === "completed"));
  });

  test("available_commands_update is ignored without a warning", () => {
    const warnings: string[] = [];
    const ignored = updates("codex-initialize-and-session-new.jsonl")
      .map((params) => parseSessionUpdate(params, (message) => warnings.push(message)))
      .filter((update) => update.kind === "ignored");

    assert.equal(ignored.length, 1);
    assert.deepEqual(warnings, []);
  });

  // §9.1 rule 4, one protocol over: an unknown variant is forward compatibility, not
  // corruption. Fatal here means the next agent release ends every mission.
  test("an unknown sessionUpdate warns and is ignored, never fatal", () => {
    const warnings: string[] = [];
    const update = parseSessionUpdate(
      { sessionId: "s", update: { sessionUpdate: "plan_from_the_future", plan: [] } },
      (message) => warnings.push(message),
    );

    assert.equal(update.kind, "ignored");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /plan_from_the_future/);
  });

  test("a structurally malformed update warns and is ignored too", () => {
    const warnings: string[] = [];

    assert.equal(parseSessionUpdate({ nope: true }, (m) => warnings.push(m)).kind, "ignored");
    assert.equal(parseSessionUpdate(null, (m) => warnings.push(m)).kind, "ignored");
    assert.equal(warnings.length, 2);
  });
});

describe("acp agent-initiated requests", () => {
  // The ids were asserted literally here until OpenCode was captured, which offers the
  // same three options under the ids `once`, `always` and `reject`. That made the old
  // assertion an assertion about Claude's vocabulary rather than about the protocol —
  // and the ids are exactly what `pickPermissionOption` refuses to invent. What every
  // agent must offer, and what the transport actually selects on, is the `kind`.
  test("every captured session/request_permission parses, with a single-use option of each sign", () => {
    const requests = inboundRequests("session/request_permission");
    assert.equal(requests.length, 6);

    for (const frame of requests) {
      const params = parseRequestPermissionParams(frame["params"]);
      const kinds = params.options.map((option) => option.kind);
      assert.ok(kinds.includes("allow_once"), `no allow_once among ${kinds.join(", ")}`);
      assert.ok(kinds.includes("reject_once"), `no reject_once among ${kinds.join(", ")}`);
      assert.ok(params.toolCall.title.length > 0);
      assert.equal(typeof params.toolCall.toolCallId, "string");
    }
  });

  test("a permission request with no options raises rather than picking silently", () => {
    assert.throws(
      () => parseRequestPermissionParams({ sessionId: "s", options: [], toolCall: { toolCallId: "t", title: "x" } }),
      (err: unknown) => {
        assert.ok(err instanceof AcpProtocolError);
        return true;
      },
    );
  });

  test("the captured fs/write_text_file request parses to a path and content", () => {
    const [frame] = inboundRequests("fs/write_text_file");
    const parsed = fsWriteTextFileParamsSchema.safeParse(frame?.["params"]);

    assert.ok(parsed.success);
    assert.equal(parsed.data.path, "/private/tmp/acp-spike/work-claude/hello.txt");
    assert.equal(parsed.data.content, "hi");
  });

  // No capture contains one — the agents read through their own tools — so this is the
  // documented shape held to the same optionality rule as the rest.
  test("fs/read_text_file params require a path and accept optional line bounds", () => {
    assert.ok(fsReadTextFileParamsSchema.safeParse({ sessionId: "s", path: "/tmp/a" }).success);
    assert.ok(fsReadTextFileParamsSchema.safeParse({ sessionId: "s", path: "/tmp/a", line: 1, limit: 20 }).success);
    assert.equal(fsReadTextFileParamsSchema.safeParse({ sessionId: "s" }).success, false);
  });
});

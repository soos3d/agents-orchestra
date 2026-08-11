// The scripted ACP agent's process. Plain ESM JavaScript, spawned with bare `node` —
// no loader, no build step, and deliberately zero imports from `src/`.
//
// Sharing code with `protocol.ts` would make every transport test a tautology: the fake
// would agree with the parsers because both were written from the same idea rather than
// from the wire. So the frames below are transcribed from the real captures in
// `acp-transcripts/` (claude-code-acp 0.16.2, protocolVersion 1, 2026-08-10), field for
// field, including the empty first `agent_message_chunk` and the `tool_call` that arrives
// once with an empty `rawInput` and again with the real one.
//
// Scenario comes from argv[2] or FAKE_ACP_SCENARIO; the texts come from the env so a test
// can make the final message a valid WorkerReport without editing this file.
import process from "node:process";

const scenario = process.argv[2] ?? process.env.FAKE_ACP_SCENARIO ?? "happy";
const finalText = process.env.FAKE_ACP_FINAL_TEXT ?? "Done.";
const rejectedText = process.env.FAKE_ACP_REJECTED_TEXT ?? "I was not allowed to do that.";
const writePath = process.env.FAKE_ACP_WRITE_PATH ?? "/tmp/fake-acp-hello.txt";

const SESSION_ID = "e638581a-6861-40a8-8840-9f6e27ea0858";
const TOOL_CALL_ID = "toolu_01TtVMWkrNarTF4HgaASvpiT";

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const notify = (update) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update } });

// Requests we make of the client, awaiting its result the way a real agent does.
let nextRequestId = 0;
const pending = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

/** Three chunks, as the captures stream them: an empty one, then the text in two halves. */
function streamText(text) {
  const cut = Math.floor(text.length / 2);
  for (const part of ["", text.slice(0, cut), text.slice(cut)]) {
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
  }
}

function availableCommands() {
  notify({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "debug", description: "Debug this session. (bundled)", input: null }],
  });
}

function toolCallFrames() {
  notify({
    _meta: { claudeCode: { toolName: "mcp__acp__Write" } },
    toolCallId: TOOL_CALL_ID,
    sessionUpdate: "tool_call",
    rawInput: {},
    status: "pending",
    title: "Write",
    kind: "edit",
    content: [],
    locations: [],
  });
  notify({
    _meta: { claudeCode: { toolName: "mcp__acp__Write" } },
    toolCallId: TOOL_CALL_ID,
    sessionUpdate: "tool_call",
    rawInput: { file_path: writePath, content: "hi" },
    status: "pending",
    title: `Write ${writePath}`,
    kind: "edit",
    content: [{ type: "diff", path: writePath, oldText: null, newText: "hi" }],
    locations: [{ path: writePath }],
  });
}

async function runPrompt(id) {
  if (scenario === "hang") return; // The prompt is never answered. That is the scenario.

  availableCommands();

  if (scenario === "disconnect") {
    process.exit(1);
  }

  if (scenario === "permission") {
    toolCallFrames();

    const outcome = await ask("session/request_permission", {
      options: [
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      sessionId: SESSION_ID,
      toolCall: { toolCallId: TOOL_CALL_ID, rawInput: { file_path: writePath, content: "hi" }, title: `Write ${writePath}` },
    });

    const optionId = outcome?.outcome?.optionId;
    const allowed = optionId === "allow" || optionId === "allow_always";

    if (allowed) {
      await ask("fs/write_text_file", { sessionId: SESSION_ID, path: writePath, content: "hi" });
      notify({
        _meta: { claudeCode: { toolName: "mcp__acp__Write" } },
        toolCallId: TOOL_CALL_ID,
        sessionUpdate: "tool_call_update",
        status: "completed",
        rawOutput: [{ type: "text", text: `The file ${writePath} has been updated successfully.` }],
      });
      streamText(finalText);
    } else {
      notify({
        _meta: { claudeCode: { toolName: "mcp__acp__Write" } },
        toolCallId: TOOL_CALL_ID,
        sessionUpdate: "tool_call_update",
        status: "failed",
        rawOutput: "The user doesn't want to proceed with this tool use.",
      });
      streamText(rejectedText);
    }

    // Rejected or not, the captured turn still ends `end_turn` — which is the reason a
    // stopReason on its own never means the work was done.
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  streamText(scenario === "prose" ? "I had a look around and things seem fine, broadly." : finalText);
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result);
    return;
  }

  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
            loadSession: true,
          },
          agentInfo: { name: "fake-acp-agent", title: "Scripted ACP agent", version: "0.0.0" },
          authMethods: [],
        },
      });
    case "session/new":
      return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: SESSION_ID } });
    case "session/prompt":
      void runPrompt(message.id);
      return;
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `fake agent does not implement ${message.method}` },
      });
  }
}

let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    handle(JSON.parse(line));
  }
});

// A closed stdin means the client is gone; a fake that lingered would leak a process per
// test, which is the orphan `duplex.ts` exists to prevent.
process.stdin.on("end", () => process.exit(0));

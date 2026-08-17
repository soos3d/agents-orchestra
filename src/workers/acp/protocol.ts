// The ACP wire, written from captured traffic rather than from the specification.
//
// This file exists to stop the failure that hit `agentCalls.ts` five times: a shape we
// believed because we wrote it down, held green by a suite that only ever fed it our own
// examples. Every schema and every builder here is checked against the real frames in
// `src/testing/acp-transcripts/` — `@zed-industries/claude-code-acp` 0.16.2 and
// `@zed-industries/codex-acp` 0.16.0, protocolVersion 1, captured 2026-08-10 — so the
// transcripts are executable fixtures and a field this file requires that a live agent
// omits fails the suite rather than a mission. Where the two agents disagree the field is
// optional, and the test says which capture forced it (`tool_call_update` arrives with no
// `status`; `rawOutput` is a string in one capture and an array in another; the two
// agents' `session/new` results share only `sessionId`).
//
// **Captured fact, 2026-08-10: no frame in any session carries token usage.**
// `session/prompt` returns `{ stopReason }` and nothing else — no usage block, no cost, no
// counts on any `session/update`. So an ACP worker's spend stays in §9.5's *unmeasured*
// column alongside the CLI transport, wall-clock remains the ceiling that binds, and a
// dashboard number claiming otherwise would be the reassuring zero §9.5 exists to refuse.
// If a later agent release starts reporting usage, this paragraph and §9.5's table are
// the two places to change together.
//
// Everything here is pure: builders return plain JSON-RPC objects and parsers return
// values. Nothing writes, spawns, or awaits — the transport owns the socket, and keeping
// the decisions out of the message handler is what makes them assertable at all.
import { z } from "zod";

/** A frame we could not make sense of. `failure` classifies it for §9.4's typed retry. */
export class AcpProtocolError extends Error {
  readonly failure = "transport" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AcpProtocolError";
  }
}

export const ACP_PROTOCOL_VERSION = 1;

// ── framing ──────────────────────────────────────────────────────────────────────

/**
 * Split an accumulated stdout buffer into whole ndjson frames, keeping the partial tail.
 *
 * The tail is the whole point: a 40 KB `session/update` arrives across several `data`
 * events, and a reader that parses per chunk drops the frame that straddles the boundary.
 * The caller feeds `rest` back in with the next chunk.
 */
export function parseFrames(buffer: string): { frames: unknown[]; rest: string } {
  const frames: unknown[] = [];
  let rest = buffer;

  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline < 0) break;

    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line === "") continue;

    try {
      frames.push(JSON.parse(line));
    } catch (err) {
      throw new AcpProtocolError(
        `The agent wrote a non-JSON line to its protocol channel: ${line.slice(0, 200)}. ` +
          "Agents must keep diagnostics on stderr — check the command is an ACP adapter and not the plain CLI.",
        { cause: err },
      );
    }
  }

  return { frames, rest };
}

// ── outbound ─────────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

/**
 * A response to an agent-initiated request. The id is whatever arrived: JSON-RPC permits a
 * string, every captured frame uses a number, and coercing one to the other would answer a
 * request nobody made.
 */
export interface JsonRpcResult {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly error: { readonly code: number; readonly message: string };
}

/**
 * The handshake, exactly as captured.
 *
 * `terminal: false` is a claim we have to keep: declaring the capability invites
 * `terminal/*` requests this client has no implementation for, and a request we answer
 * with an error mid-turn is a turn that dies for no reason.
 */
export function initializeRequest(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: "orchestra", version: "0.1.0" },
    },
  };
}

/** `mcpServers: []` is deliberate: an ACP worker's tools come from its `AgentSpec` (§7). */
export function sessionNewRequest(id: number, cwd: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } };
}

/**
 * Ask the agent to run this session on a named model — sent only to a target whose
 * registry row says it honours one (`AcpLaunch.honoursModel`).
 *
 * A model the agent does not have comes back `-32602` here, which is a refusal *before*
 * the prompt and therefore before any spend. That is the point of sending it early: the
 * alternative is a task that runs to completion on a model nobody chose and is priced
 * against one that never ran.
 */
export function sessionSetModelRequest(id: number, sessionId: string, modelId: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "session/set_model", params: { sessionId, modelId } };
}

export function sessionPromptRequest(id: number, sessionId: string, text: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
  };
}

/**
 * The answer to `session/request_permission`. The option id comes from the request's own
 * `options` — never a string invented here, because the ids are the agent's vocabulary
 * (`allow`, `allow_always`, `reject`) and an id it did not offer selects nothing.
 */
export function permissionResponse(id: number | string, optionId: string): JsonRpcResult {
  return { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } };
}

/** Captured: a literal `null` result. An omitted `result` leaves the agent waiting forever. */
export function writeTextFileResponse(id: number | string): JsonRpcResult {
  return { jsonrpc: "2.0", id, result: null };
}

export function readTextFileResponse(id: number | string, content: string): JsonRpcResult {
  return { jsonrpc: "2.0", id, result: { content } };
}

const METHOD_NOT_FOUND = -32601;

/**
 * Refuse a method we do not implement, loudly and in the protocol's own language.
 *
 * Silence is the failure this prevents: an unanswered agent-initiated request hangs the
 * turn until the session timeout, and the log shows a slow agent rather than a missing
 * capability.
 */
export function methodNotFoundResponse(id: number | string, method: string): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message:
        `${method} is not implemented by this client. ` +
        "Declare the capability in `initialize` and handle it, or leave the capability false so the agent never asks.",
    },
  };
}

// ── inbound: classification ──────────────────────────────────────────────────────

export type AcpFrame =
  | { kind: "result"; id: number | string; result: unknown }
  | { kind: "error"; id: number | string; error: { code: number; message: string; data?: unknown } }
  | { kind: "request"; id: number | string; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "unknown"; frame: unknown };

const idSchema = z.union([z.number(), z.string()]);

const resultFrameSchema = z.object({ id: idSchema, result: z.unknown() });
const errorFrameSchema = z.object({
  id: idSchema,
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
});
const requestFrameSchema = z.object({ id: idSchema, method: z.string(), params: z.unknown() });
const notificationFrameSchema = z.object({ method: z.string(), params: z.unknown() });

/**
 * Which of JSON-RPC's four shapes a frame is. Never throws: an unrecognised frame is a
 * value the caller decides about, not an exception thrown from a socket handler.
 */
export function classifyFrame(frame: unknown): AcpFrame {
  if (typeof frame !== "object" || frame === null) return { kind: "unknown", frame };
  const record = frame as Record<string, unknown>;

  if ("error" in record) {
    const parsed = errorFrameSchema.safeParse(record);
    if (parsed.success) return { kind: "error", id: parsed.data.id, error: parsed.data.error };
    return { kind: "unknown", frame };
  }

  // `result: null` is a legitimate result (see `writeTextFileResponse`), so membership
  // is the test rather than `!== undefined`.
  if ("result" in record) {
    const parsed = resultFrameSchema.safeParse(record);
    if (parsed.success) return { kind: "result", id: parsed.data.id, result: record["result"] };
    return { kind: "unknown", frame };
  }

  if ("method" in record && "id" in record) {
    const parsed = requestFrameSchema.safeParse(record);
    if (parsed.success) {
      return { kind: "request", id: parsed.data.id, method: parsed.data.method, params: record["params"] };
    }
    return { kind: "unknown", frame };
  }

  if ("method" in record) {
    const parsed = notificationFrameSchema.safeParse(record);
    if (parsed.success) {
      return { kind: "notification", method: parsed.data.method, params: record["params"] };
    }
  }

  return { kind: "unknown", frame };
}

// ── inbound: results ─────────────────────────────────────────────────────────────

export const initializeResultSchema = z.object({
  protocolVersion: z.number(),
  // Both captured agents send one, and nothing in the transport branches on it — so it
  // stays optional, because a required field on data no decision reads is a mission
  // that fails over a diagnostic.
  agentInfo: z.object({ name: z.string(), title: z.string().optional(), version: z.string().optional() }).optional(),
  agentCapabilities: z.unknown().optional(),
  authMethods: z.unknown().optional(),
});
export type InitializeResult = z.infer<typeof initializeResultSchema>;

// `models` is optional and read rather than ignored: `AgentSpec.model` is never sent
// over ACP, so this is the only place the client learns which model the adapter chose
// for the turn. A mission whose log names a model that never ran cannot be priced, and
// the two differ in practice — a task specced `claude-sonnet-4-5` ran on
// `claude-opus-4-6` in the capture beside this file. Optional because the agent is
// entitled not to say, and a missing field must not fail a session (§9.1 rule 4).
export const sessionNewResultSchema = z.object({
  sessionId: z.string().min(1),
  models: z.object({ currentModelId: z.string().min(1).optional() }).partial().optional(),
});
export type SessionNewResult = z.infer<typeof sessionNewResultSchema>;

// `stopReason` is a plain string on purpose. `end_turn` is the only value the captures
// contain, and a union of guesses would fail a mission on a value the agent is entitled
// to add — the §9.1 rule-4 instinct applied to a field rather than to an event type.
export const sessionPromptResultSchema = z.object({ stopReason: z.string() });
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>;

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string, fix: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AcpProtocolError(`The agent's ${what} is not the shape ACP defines — ${issuesOf(parsed.error)}. ${fix}`);
}

export function parseInitializeResult(result: unknown): InitializeResult {
  return parseOrThrow(
    initializeResultSchema,
    result,
    "initialize result",
    "Check the command is an ACP adapter (e.g. `claude-code-acp`) rather than the agent's own CLI.",
  );
}

export function parseSessionNewResult(result: unknown): SessionNewResult {
  return parseOrThrow(
    sessionNewResultSchema,
    result,
    "session/new result",
    "Without a sessionId nothing can be prompted — check the agent version against the transcripts in src/testing/acp-transcripts/.",
  );
}

export function parseSessionPromptResult(result: unknown): SessionPromptResult {
  return parseOrThrow(
    sessionPromptResultSchema,
    result,
    "session/prompt result",
    "The turn ended in a shape this client cannot read; treat it as a transport failure and retry the task once (§9.4).",
  );
}

// ── inbound: session/update ──────────────────────────────────────────────────────

export type AcpUpdate =
  | { kind: "message_chunk"; text: string }
  | {
      kind: "tool_call";
      toolCallId: string;
      title: string;
      /** claude-code-acp tags the underlying tool on `_meta.claudeCode.toolName`. */
      toolName?: string;
    }
  | {
      kind: "tool_call_update";
      toolCallId: string;
      title?: string;
      toolName?: string;
    }
  | { kind: "ignored"; sessionUpdate?: string };

const metaSchema = z.object({ claudeCode: z.object({ toolName: z.string().optional() }).optional() }).optional();

const messageChunkSchema = z.object({
  sessionUpdate: z.literal("agent_message_chunk"),
  content: z.object({ type: z.string(), text: z.string() }),
});

const toolCallSchema = z.object({
  sessionUpdate: z.literal("tool_call"),
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.unknown().optional(),
  _meta: metaSchema,
});

const toolCallUpdateSchema = z.object({
  sessionUpdate: z.literal("tool_call_update"),
  toolCallId: z.string(),
  title: z.string().optional(),
  // Captured with no `status` at all on the intermediate frame, and with `failed` /
  // `completed` on the terminal one.
  status: z.string().optional(),
  // A string in the rejected-write capture, an array of content blocks in the approved
  // one. The transport records it; nothing here interprets it.
  rawOutput: z.unknown().optional(),
  _meta: metaSchema,
});

const updateEnvelopeSchema = z.object({
  sessionId: z.string().optional(),
  update: z.object({ sessionUpdate: z.string() }).loose(),
});

/**
 * Variants we knowingly drop, so they never reach the warning path.
 *
 * The last two are OpenCode's and each is dropped for its own reason.
 * `agent_thought_chunk` is reasoning, not the turn's answer — appending it to `raw` would
 * put the model's second thoughts in front of `parseWorkerReport` alongside the report it
 * eventually wrote. `usage_update` is a running context total (`used`, `size`, `cost`) and
 * not the turn's accounting: the numbers this transport reports come from
 * `session/prompt`'s own `usage` or from the agent's session log, and a mid-turn gauge
 * read as a total would double-count. Neither is unknown; both are declined.
 */
const IGNORED_UPDATES = new Set([
  "available_commands_update",
  "current_mode_update",
  "plan",
  "agent_thought_chunk",
  "usage_update",
]);

/**
 * Parse one `session/update` notification's params.
 *
 * **Nothing here is fatal**, which is §9.1's rule 4 one protocol over: an unknown
 * `sessionUpdate` is the agent being newer than us, and a client that throws on it ends
 * every mission the day the adapter ships a variant. Unknown warns and is ignored;
 * malformed warns and is ignored too, because a frame we cannot read is still not a
 * reason to abandon a turn that is otherwise progressing.
 */
export function parseSessionUpdate(params: unknown, onWarn: (message: string) => void): AcpUpdate {
  const envelope = updateEnvelopeSchema.safeParse(params);
  if (!envelope.success) {
    onWarn(
      `Ignoring a session/update this client cannot read — ${issuesOf(envelope.error)}. ` +
        "Capture the frame into src/testing/acp-transcripts/ if it recurs.",
    );
    return { kind: "ignored" };
  }

  const update = envelope.data.update;
  const name = update.sessionUpdate;

  if (name === "agent_message_chunk") {
    const parsed = messageChunkSchema.safeParse(update);
    if (!parsed.success) {
      onWarn(`Ignoring a malformed agent_message_chunk — ${issuesOf(parsed.error)}.`);
      return { kind: "ignored", sessionUpdate: name };
    }
    return { kind: "message_chunk", text: parsed.data.content.text };
  }

  if (name === "tool_call") {
    const parsed = toolCallSchema.safeParse(update);
    if (!parsed.success) {
      onWarn(`Ignoring a malformed tool_call — ${issuesOf(parsed.error)}.`);
      return { kind: "ignored", sessionUpdate: name };
    }
    return {
      kind: "tool_call",
      toolCallId: parsed.data.toolCallId,
      title: parsed.data.title,
      toolName: parsed.data._meta?.claudeCode?.toolName,
    };
  }

  if (name === "tool_call_update") {
    const parsed = toolCallUpdateSchema.safeParse(update);
    if (!parsed.success) {
      onWarn(`Ignoring a malformed tool_call_update — ${issuesOf(parsed.error)}.`);
      return { kind: "ignored", sessionUpdate: name };
    }
    return {
      kind: "tool_call_update",
      toolCallId: parsed.data.toolCallId,
      title: parsed.data.title,
      toolName: parsed.data._meta?.claudeCode?.toolName,
    };
  }

  if (!IGNORED_UPDATES.has(name)) {
    onWarn(
      `Ignoring an unrecognised session/update variant "${name}". ` +
        "Add it to protocol.ts with a captured transcript if the transport should act on it.",
    );
  }
  return { kind: "ignored", sessionUpdate: name };
}

// ── inbound: agent-initiated requests ────────────────────────────────────────────

export const permissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string().optional(),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

export const requestPermissionParamsSchema = z.object({
  sessionId: z.string().optional(),
  // Empty is refused below rather than here, so the message can say why it matters.
  options: z.array(permissionOptionSchema),
  toolCall: z.object({
    toolCallId: z.string(),
    title: z.string(),
    rawInput: z.unknown().optional(),
    kind: z.string().optional(),
  }),
});
export type RequestPermissionParams = z.infer<typeof requestPermissionParamsSchema>;

/**
 * The gate frame (§11's channel, decided by `permissions.ts`).
 *
 * An empty `options` raises rather than defaulting, because every default available here
 * is wrong: picking allow grants a capability nobody offered, and picking reject invents
 * the refusal `permissions.ts` deliberately has no value for.
 */
export function parseRequestPermissionParams(params: unknown): RequestPermissionParams {
  const parsed = parseOrThrow(
    requestPermissionParamsSchema,
    params,
    "session/request_permission params",
    "This client cannot answer a permission request it cannot read; treat it as a transport failure (§9.4).",
  );

  if (parsed.options.length === 0) {
    throw new AcpProtocolError(
      "The agent asked for permission and offered no options to choose from. " +
        "Nothing may be selected on its behalf — treat it as a transport failure and retry the task once (§9.4).",
    );
  }
  return parsed;
}

export const fsWriteTextFileParamsSchema = z.object({
  sessionId: z.string().optional(),
  path: z.string(),
  content: z.string(),
});

export const fsReadTextFileParamsSchema = z.object({
  sessionId: z.string().optional(),
  path: z.string(),
  line: z.number().optional(),
  limit: z.number().optional(),
});
export type FsReadTextFileParams = z.infer<typeof fsReadTextFileParamsSchema>;

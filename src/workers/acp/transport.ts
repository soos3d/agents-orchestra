// The `acp` transport: one live JSON-RPC session with an agent, driven from here (§12).
//
// The `cli` transport spawns a CLI, hands it a prompt, and reads whatever it printed. ACP
// is the opposite shape — the agent talks back mid-turn, and half of what this file does
// is answer it. That is the whole reason §12 wants ACP: `--dangerously-skip-permissions`
// exists in the CLI transport because there is no channel to say no on (defect 14), and
// here there is one. So the permission answer is decided by `permissions.ts` in code, and
// a decision it cannot make on the grant alone goes to the human through an injected port
// rather than being resolved inside a socket handler (§11's argument, one boundary in).
//
// Three failures this file exists to prevent, each of which is a test below:
//
//   * **A hang.** A session has no natural end (`duplex.ts`'s header) and a permission
//     nobody answers is a turn that never finishes. The duplex timer therefore keeps
//     running *through* the wait, so an unanswered gate ends as a killed session with a
//     message naming the budget, not as a mission parked behind a live subprocess. Every
//     request races the session's own end, so a dead agent fails the turn instead of
//     leaving a promise nobody will settle.
//   * **A widening.** `allow_always` is offered by the adapter on every gate and is never
//     selected: one ask, one grant (§7). Selecting it would hand a synthesized agent a
//     standing capability no human was asked about, from inside a message handler.
//   * **An escape.** `fs/write_text_file` names an absolute path the agent chooses, so the
//     client — not the agent — decides what is writable. The task's cwd is the blast
//     radius (§8's lease, one layer down), and a path outside it is refused in the
//     protocol's own language so the turn continues rather than hanging.
//
// Everything a test needs to assert without a subprocess is a pure function up here —
// `permissionRequestOf`, `pickPermissionOption`, `containedPath`, `acpToolName` — for the
// same reason `queryOptions` is one: a decision taken inside a socket handler is a
// decision nothing can assert (defect 18).
//
// **No usage on the wire, so it is read from the agent's own books afterwards.** Not one
// captured frame carries a token count, and for a long time that left every ACP dispatch
// in §9.5's unmeasured column — which hid the largest number in the mission: one dispatch
// measured after the fact had read 288,446 cached tokens against an orchestrator total of
// 19,415. `usage.ts` reads the session log the agent writes for the `sessionId` this
// transport already holds; when there is no such file the wire is estimated instead, and
// when neither is possible the dispatch stays unmeasured exactly as before. Which of the
// three happened is recorded, because a number is worth no more than its source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type Task } from "../../domain/task.js";
import { type WorkerRun, type WorkerTransport } from "../../loop/dispatch.js";
import { spawnDuplex, type DuplexExit, type DuplexProcess } from "../../runtime/duplex.js";
import { buildWorkerEnv } from "../childEnv.js";
import { workerPrompt } from "../prompt.js";
import { decidePermission, type PermissionRequest } from "./permissions.js";
import { estimateFromWire, readSessionUsage, sessionLogPath } from "./usage.js";
import {
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
  type AcpFrame,
  type ClientInfo,
  type JsonRpcErrorResponse,
  type JsonRpcRequest,
  type PermissionOption,
  type RequestPermissionParams,
} from "./protocol.js";
import { acpAgentCommand, acpTargets, type AcpLaunch } from "./registry.js";

/** Anything that ends a session without a report. `failure` matches `AcpProtocolError`'s,
 *  and `dispatch` classifies a throw from a transport as `transport` either way (§9.4). */
export class AcpSessionError extends Error {
  readonly failure = "transport" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AcpSessionError";
  }
}

export interface AcpTransportDeps {
  /**
   * The one inbox (§10). Called only where the grant does not already cover the call —
   * `true` allows it once, `false` refuses it once, and neither answer is remembered.
   *
   * It is a `Promise` that may take hours: a human is on the end of it, and the task is
   * parked meanwhile. The session's wall-clock budget keeps running through the wait,
   * which is deliberate — see the header.
   */
  requestPermission(taskId: string, request: PermissionRequest): Promise<boolean>;
  /** Frames this client knowingly tolerates rather than fails on (§9.1 rule 4). */
  onWarn?(message: string): void;
  /** Injected so a test drives a scripted agent instead of an `npx` download, and so the
   *  registry stays a pure lookup with a test of its own. */
  resolveAgent?(target: string): AcpLaunch | undefined;
  /** Where the agent keeps its own session logs, which is where this transport's token
   *  counts come from (§9.5, `usage.ts`). Injected for the same reason `resolveAgent`
   *  is: a test must be able to point it at a fixture rather than at the real home. */
  home?: string;
  /** The environment this process was started with, from which the adapter's own is
   *  constructed (defect 42). Injected for the same reason `home` is: a test must be
   *  able to put a fake secret in a fake parent environment and assert it does not
   *  reach the child. */
  parentEnv?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
}

const DEFAULT_CLIENT_INFO: ClientInfo = { name: "orchestra", version: "0.1.0" };

/**
 * Everything the adapter's process will be able to see (defect 42).
 *
 * Constructed, never filtered: what this adapter needs to start, plus the variables the
 * mission envelope granted this task, plus whatever the launch sets outright — and
 * nothing else the orchestrator happens to hold. `CLAUDECODE` is absent because nothing
 * names it, which is what replaced the present-and-`undefined` strip the registry used
 * to carry.
 *
 * Pure and exported for the `agentCalls.ts` reason: this is below the fixture harness,
 * a spawn's environment is invisible to every test that does not read it here, and the
 * variable that leaks is the one nobody wrote an assertion about.
 */
export function acpChildEnv(
  launch: AcpLaunch,
  task: Task,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return buildWorkerEnv({
    parent: parentEnv,
    ...(launch.inherits ? { transportVars: launch.inherits } : {}),
    ...(task.agentSpec.env ? { allowed: task.agentSpec.env } : {}),
    ...(launch.env ? { literals: launch.env } : {}),
  });
}

/**
 * The `acp` transport (§7's registry, second row).
 *
 * The id guard is the same one `createCliTransport` carries and for the same reason:
 * `routeTransport` owns the mapping, and a composition root that wires this under another
 * id should hear about it rather than quietly running a `cli` task through an adapter.
 */
export function createAcpTransport(deps: AcpTransportDeps): WorkerTransport {
  const resolveAgent = deps.resolveAgent ?? acpAgentCommand;
  const onWarn = deps.onWarn ?? ((): void => undefined);
  const clientInfo = deps.clientInfo ?? DEFAULT_CLIENT_INFO;

  return async ({ task, cwd, artifactDir, signal }): Promise<WorkerRun> => {
    const { transport } = task.agentSpec;
    if (transport.id !== "acp") {
      throw new AcpSessionError(
        `The acp transport was handed a '${transport.id}' task. Route transports with ` +
          `routeTransport() rather than wiring one transport for every id.`,
      );
    }

    const target = transport.target ?? "";
    const launch = resolveAgent(target);
    if (!launch) {
      throw new AcpSessionError(
        `No ACP agent is registered for target '${target}' — this build launches ` +
          `${acpTargets().join(", ")}. Plan this task with one of those, or add the ` +
          `agent's launch command to src/workers/acp/registry.ts with a captured transcript.`,
      );
    }

    const env = acpChildEnv(launch, task, deps.parentEnv ?? process.env);

    const startedAt = Date.now();
    const proc = spawnDuplex(launch.command, launch.args, {
      cwd,
      timeoutMs: task.budget.wallMs,
      env,
      ...(signal ? { signal } : {}),
    });

    try {
      const session = await runSession({
        proc,
        task,
        cwd,
        ...(artifactDir ? { artifactDir } : {}),
        clientInfo,
        onWarn,
        requestPermission: deps.requestPermission,
      });

      return {
        raw: session.raw,
        elapsedMs: Date.now() - startedAt,
        ...accountFor(session, cwd, deps.home ?? os.homedir(), onWarn),
      };
    } finally {
      // Nothing else will: the turn ended, the process has no reason to, and an agent
      // that outlives its mission is the orphan `duplex.ts` was written to prevent.
      await proc.kill();
    }
  };
}

interface SessionInput {
  readonly proc: DuplexProcess;
  readonly task: Task;
  readonly cwd: string;
  /** The task's artifact directory, absolute and already created (P2). */
  readonly artifactDir?: string;
  readonly clientInfo: ClientInfo;
  readonly onWarn: (message: string) => void;
  readonly requestPermission: AcpTransportDeps["requestPermission"];
}

/** What a finished turn leaves behind: what the agent said, and the two facts needed to
 *  account for it afterwards. */
interface SessionOutcome {
  raw: string;
  /** The agent's id for the session — and the name of the file it wrote its own usage
   *  to, which is the only place an ACP dispatch's cost exists. */
  sessionId: string;
  /** What the adapter says it ran, when it says. Never what the spec asked for. */
  ranOn?: string;
  /** Everything that crossed the connection, in characters, for the wire estimate that
   *  stands in when no session log can be found. */
  characters: number;
}

/**
 * Handshake, session, one turn — and the assembled text of what the agent said.
 *
 * The `stopReason` is parsed and deliberately not returned. The rejected-permission
 * capture ends `end_turn` exactly like the approved one, so a turn's ending says nothing
 * about whether the work happened; the `WorkerReport` in the text does (§4.1).
 */
async function runSession(input: SessionInput): Promise<SessionOutcome> {
  const client = createClient(input);

  parseInitializeResult(await client.request((id) => initializeRequest(id, input.clientInfo)));
  const opened = parseSessionNewResult(await client.request((id) => sessionNewRequest(id, input.cwd)));
  const prompt = workerPrompt(input.task, input.artifactDir);
  parseSessionPromptResult(
    await client.request((id) => sessionPromptRequest(id, opened.sessionId, prompt)),
  );

  const raw = client.text();
  const ranOn = opened.models?.currentModelId;

  return {
    raw,
    sessionId: opened.sessionId,
    ...(ranOn === undefined ? {} : { ranOn }),
    characters: prompt.length + raw.length,
  };
}

/**
 * What the dispatch cost, from the best source available (§9.5).
 *
 * Three outcomes and they are ranked, not interchangeable: the agent's own session log
 * is the API's accounting and is exact for input and cache; the wire is an estimate that
 * counts the conversation rather than the context, and is a floor with a known
 * direction; and no reading at all leaves the dispatch unmeasured, which is where every
 * ACP dispatch used to land.
 *
 * Every failure here is swallowed into the next rank down. This runs *after* the work is
 * done — a missing accounting file must never be the reason a finished dispatch fails.
 */
function accountFor(
  session: SessionOutcome,
  cwd: string,
  home: string,
  onWarn: (message: string) => void,
): Pick<WorkerRun, "usage" | "outputIsFloor" | "ranOn"> {
  const ran = session.ranOn === undefined ? {} : { ranOn: session.ranOn };

  const logPath = sessionLogPath(home, cwd, session.sessionId);
  let text: string | undefined;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    text = undefined;
  }

  const reading = text === undefined ? null : readSessionUsage(text);
  if (reading) {
    return {
      usage: reading.usage,
      ...(reading.confidence === "floor" ? { outputIsFloor: true } : {}),
      // The log's model beats the handshake's: it is what each API call actually
      // reported, rather than what the adapter said it would use.
      ...(reading.model === undefined ? ran : { ranOn: reading.model }),
    };
  }

  onWarn(
    `No session log at ${logPath}, so this dispatch's tokens are estimated from what ` +
      `crossed the connection — a floor, since a session is billed for its context on ` +
      `every turn. Reported under 'estimated', never 'measured'.`,
  );
  return { usage: estimateFromWire(session.characters), outputIsFloor: true, ...ran };
}

interface Client {
  request(build: (id: number) => JsonRpcRequest): Promise<unknown>;
  text(): string;
}

/** What every frame handler below needs, gathered once rather than threaded per call. */
interface FrameContext extends SessionInput {
  send(frame: unknown): void;
  fail(error: Error): void;
  readonly chunks: string[];
  /** `toolCallId` → the tool the adapter tagged, because the permission request itself
   *  carries only a human-facing title (captured: it has no `_meta`). */
  readonly toolNames: Map<string, string>;
  readonly pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
}

function createClient(input: SessionInput): Client {
  const chunks: string[] = [];
  const toolNames = new Map<string, string>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;

  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined);

  // The session ending is a failure of every request outstanding at the time. Racing it
  // is what turns a killed agent into an error naming the budget rather than a promise
  // nobody settles.
  const ended = input.proc.exited.then<never, never>(
    (exit) => {
      throw exitError(input.task, exit);
    },
    (error: unknown) => {
      throw new AcpSessionError(
        `The ACP agent could not be started: ${(error as Error).message}. ` +
          "Check the adapter's launch command in src/workers/acp/registry.ts and that npx can reach the registry.",
        { cause: error },
      );
    },
  );
  ended.catch(() => undefined);

  const send = (frame: unknown): void => {
    input.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  // A broken pipe here means the agent is already gone, and `ended` is carrying the real
  // reason. An unhandled 'error' on the stream would replace it with a worse one.
  input.proc.stdin.on("error", (error: Error) => {
    input.onWarn(`The ACP agent's input channel closed: ${error.message}`);
  });

  const context: FrameContext = { ...input, send, fail: (error) => fail(error), chunks, toolNames, pending };
  readFrames(context);

  return {
    request: (build) => {
      const id = nextId++;
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send(build(id));
      });
      return Promise.race([answer, ended, failed]);
    },
    text: () => chunks.join(""),
  };
}

/**
 * stdout is the protocol channel and nothing buffers it but this: `rest` is the partial
 * frame straddling a chunk boundary, which is the whole reason `parseFrames` returns one.
 *
 * Two boundaries, not one, and only the first is obvious. A frame can straddle a chunk —
 * `rest` carries it. A *character* can straddle one too: `data.toString()` on a chunk
 * ending mid-UTF-8-sequence turns those bytes into U+FFFD and the next chunk's leading
 * bytes into another, so an em-dash or a curly quote landing on a 64 KiB boundary is
 * silently rewritten in whatever it was part of. A worker report is prose in a JSON
 * string, an agent writes both of those characters constantly, and the corruption
 * survives `JSON.parse` — it does not fail, it just comes back subtly wrong. `StringDecoder`
 * holds the incomplete sequence back until its remaining bytes arrive, which is the whole
 * of the fix.
 */
function readFrames(ctx: FrameContext): void {
  let rest = "";
  const decoder = new StringDecoder("utf8");

  ctx.proc.stdout.on("data", (data: Buffer) => {
    let step;
    try {
      step = parseFrames(rest + decoder.write(data));
    } catch (error) {
      // A non-JSON line on the protocol channel is not something the next chunk fixes.
      ctx.fail(error as Error);
      return;
    }

    rest = step.rest;
    for (const frame of step.frames) handleFrame(classifyFrame(frame), ctx);
  });
}

function handleFrame(frame: AcpFrame, ctx: FrameContext): void {
  if (frame.kind === "result") {
    settle(ctx, frame.id, (waiter) => waiter.resolve(frame.result));
    return;
  }

  if (frame.kind === "error") {
    settle(ctx, frame.id, (waiter) =>
      waiter.reject(
        new AcpSessionError(
          `The ACP agent refused a request: ${frame.error.message} (code ${frame.error.code}). ` +
            "Treat it as a transport failure and retry the task once (§9.4).",
        ),
      ),
    );
    return;
  }

  if (frame.kind === "request") {
    // Answering can await a human, so it runs detached — and a throw in it ends the
    // session rather than surfacing as an unhandled rejection.
    void answerRequest(frame.id, frame.method, frame.params, ctx).catch((error: unknown) => ctx.fail(error as Error));
    return;
  }

  if (frame.kind === "notification") {
    note(frame.method, frame.params, ctx);
    return;
  }

  ctx.onWarn("Ignoring a frame on the protocol channel that is not a JSON-RPC message.");
}

function settle(
  ctx: FrameContext,
  id: number | string,
  apply: (waiter: { resolve(value: unknown): void; reject(error: Error): void }) => void,
): void {
  const waiter = ctx.pending.get(id as number);
  if (!waiter) {
    ctx.onWarn(`Ignoring a response to request ${String(id)}, which this client is not waiting on.`);
    return;
  }
  ctx.pending.delete(id as number);
  apply(waiter);
}

function note(method: string, params: unknown, ctx: FrameContext): void {
  if (method !== "session/update") {
    ctx.onWarn(`Ignoring an unrecognised notification "${method}" from the ACP agent.`);
    return;
  }

  const update = parseSessionUpdate(params, ctx.onWarn);
  if (update.kind === "message_chunk") {
    ctx.chunks.push(update.text);
    return;
  }
  if (update.kind === "tool_call" || update.kind === "tool_call_update") {
    if (update.toolName !== undefined) ctx.toolNames.set(update.toolCallId, acpToolName(update.toolName));
  }
}

// ── agent-initiated requests ─────────────────────────────────────────────────────

async function answerRequest(
  id: number | string,
  method: string,
  params: unknown,
  ctx: FrameContext,
): Promise<void> {
  if (method === "session/request_permission") return answerPermission(id, params, ctx);
  if (method === "fs/write_text_file") return answerWrite(id, params, ctx);
  if (method === "fs/read_text_file") return answerRead(id, params, ctx);

  // Answered rather than ignored: an unanswered request hangs the turn until the session
  // timeout, and the log then shows a slow agent rather than a missing capability.
  ctx.send(withId(methodNotFoundResponse(0, method), id));
  return undefined;
}

async function answerPermission(id: number | string, params: unknown, ctx: FrameContext): Promise<void> {
  const parsed = parseRequestPermissionParams(params);
  const request = permissionRequestOf(parsed, ctx.toolNames);

  // `allow` is the grant the human already gave at sign-off; anything else is a question
  // for the one inbox, and the task waits on the answer rather than the loop (§10).
  const allowed =
    decidePermission(ctx.task.agentSpec, request) === "allow"
      ? true
      : await ctx.requestPermission(ctx.task.id, request);

  ctx.send(withId(permissionResponse(0, pickPermissionOption(parsed.options, allowed)), id));
}

function answerWrite(id: number | string, params: unknown, ctx: FrameContext): void {
  const parsed = fsWriteTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    ctx.send(withId(invalidParams(0, "fs/write_text_file needs a string `path` and a string `content`."), id));
    return;
  }

  const target = containedPath(ctx.cwd, parsed.data.path);
  if (!target) {
    ctx.send(withId(invalidParams(0, outsideCwd(parsed.data.path, ctx.cwd)), id));
    return;
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, parsed.data.content);
    ctx.send(withId(writeTextFileResponse(0), id));
  } catch (error) {
    ctx.send(withId(ioError(0, `Could not write ${target}: ${(error as Error).message}`), id));
  }
}

function answerRead(id: number | string, params: unknown, ctx: FrameContext): void {
  const parsed = fsReadTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    ctx.send(withId(invalidParams(0, "fs/read_text_file needs a string `path`."), id));
    return;
  }

  const target = containedPath(ctx.cwd, parsed.data.path);
  if (!target) {
    ctx.send(withId(invalidParams(0, outsideCwd(parsed.data.path, ctx.cwd)), id));
    return;
  }

  try {
    ctx.send(withId(readTextFileResponse(0, slice(fs.readFileSync(target, "utf8"), parsed.data)), id));
  } catch (error) {
    ctx.send(withId(ioError(0, `Could not read ${target}: ${(error as Error).message}`), id));
  }
}

/** `line` is 1-based in the captures, and `limit` counts lines rather than bytes. */
function slice(content: string, params: { line?: number; limit?: number }): string {
  if (params.line === undefined && params.limit === undefined) return content;
  const lines = content.split("\n");
  const from = Math.max((params.line ?? 1) - 1, 0);
  return lines.slice(from, params.limit === undefined ? undefined : from + params.limit).join("\n");
}

// ── the decisions, as pure functions ─────────────────────────────────────────────

/**
 * What a permission request is actually asking for, in the vocabulary `permissions.ts`
 * judges and a human reads.
 *
 * The captured request frame carries a title and a `rawInput` and *no tool name* — the
 * name is on the `tool_call` update that precedes it, which is why the transport tracks
 * them. Falling back to the title's first word is a best effort for an agent that sends
 * no `tool_call`: it will usually miss, and missing means `ask`, which is the safe way
 * round (§7 reserves widening for a human).
 */
export function permissionRequestOf(
  params: RequestPermissionParams,
  toolNames: ReadonlyMap<string, string>,
): PermissionRequest {
  const { toolCallId, title, rawInput } = params.toolCall;
  const tool = toolNames.get(toolCallId) ?? acpToolName(title);
  const rendered = renderRawInput(rawInput);
  return { tool, detail: rendered === "" ? title : `${title} — ${rendered}` };
}

const RAW_INPUT_LIMIT = 400;

/** What the human sees under the title. Bounded, because a gate card is read on a phone
 *  and a whole file's contents in an approval prompt is how gate fatigue starts (§11). */
function renderRawInput(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  const rendered = JSON.stringify(rawInput);
  if (rendered === undefined || rendered === "{}") return "";
  return rendered.length <= RAW_INPUT_LIMIT ? rendered : `${rendered.slice(0, RAW_INPUT_LIMIT)}…`;
}

/**
 * The tool as the catalogue names it (§7).
 *
 * claude-code-acp tags its own tools plainly (`Bash`) and the ones it routes back through
 * the client with an MCP wrapper (`mcp__acp__Write`). `classOf` knows `Write` and knows
 * nothing about the wrapper, so an unwrapped name would gate every write the human had
 * already granted — gate fatigue spent on nothing, which is what makes the gates that
 * matter get tapped through (§11).
 */
export function acpToolName(raw: string): string {
  const unwrapped = raw.startsWith("mcp__") ? raw.slice(raw.lastIndexOf("__") + 2) : raw;
  return unwrapped.trim().split(/\s+/)[0] ?? unwrapped;
}

/**
 * Which option id answers the gate — and, just as importantly, which one never does.
 *
 * Every captured request offers `allow_always` first. Selecting it would turn one human
 * "yes" into a standing grant for the rest of the session, which is a widening §7
 * reserves for a human acting on the mission. So the choice is by `kind`, one grant per
 * ask, and an agent offering no single-use option gets no answer at all rather than the
 * nearest thing to one.
 */
export function pickPermissionOption(options: readonly PermissionOption[], allowed: boolean): string {
  const kind = allowed ? "allow_once" : "reject_once";
  const fallbackId = allowed ? "allow" : "reject";

  const chosen = options.find((option) => option.kind === kind) ?? options.find((option) => option.optionId === fallbackId);
  if (chosen) return chosen.optionId;

  throw new AcpSessionError(
    allowed
      ? "The agent offered no single-use way to allow this tool call — only a standing grant " +
        "(`allow_always`), which widens the agent's capabilities beyond the one call a human approved (§7). " +
        "Treat it as a transport failure and retry the task once (§9.4)."
      : "The agent offered no way to refuse this tool call. Treat it as a transport failure and retry the task once (§9.4).",
  );
}

/**
 * The absolute path a client-side file operation may touch, or `undefined` for one it may
 * not.
 *
 * The agent names the path, so containment is the client's job. Resolution goes through
 * `realpath` on both ends because a prefix comparison on unresolved strings is two bugs at
 * once: `/var` and `/private/var` are the same directory on macOS and do not share a
 * prefix, and a symlink inside the worktree pointing out of it shares one perfectly.
 * `src/routes` and `src/routers` are the third case, which the separator handles.
 */
export function containedPath(root: string, requested: string): string | undefined {
  const realRoot = resolveReal(path.resolve(root));
  const resolved = path.resolve(realRoot, requested);
  const real = resolveReal(resolved);

  return real === realRoot || real.startsWith(realRoot + path.sep) ? resolved : undefined;
}

/** `realpath` of a path that may not exist yet — the nearest existing ancestor resolved,
 *  with the rest appended. A file about to be created has no realpath of its own. */
function resolveReal(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(resolveReal(parent), path.basename(target));
  }
}

function outsideCwd(requested: string, cwd: string): string {
  return (
    `This client refuses to touch ${requested}: it is outside the task's working directory (${cwd}), ` +
    "which is the whole of what this task may change (§8). Work under that directory, or have the mission " +
    "plan a task whose lease covers the path."
  );
}

// ── framing helpers ──────────────────────────────────────────────────────────────

const INVALID_PARAMS = -32602;
const IO_ERROR = -32000;

const invalidParams = (id: number, message: string): JsonRpcErrorResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code: INVALID_PARAMS, message },
});

const ioError = (id: number, message: string): JsonRpcErrorResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code: IO_ERROR, message },
});

/**
 * Echo back the id that arrived.
 *
 * JSON-RPC permits a string id and `protocol.ts`'s builders type it `number`, because
 * every captured frame uses one. Coercing a string id would answer a request nobody made,
 * so it is carried through as it arrived and the cast is confined to this one function.
 */
function withId<T extends { id: number }>(frame: T, id: number | string): T {
  return { ...frame, id } as unknown as T;
}

function exitError(task: Task, exit: DuplexExit): AcpSessionError {
  const stderr = exit.stderrTail.trim();
  const detail = stderr === "" ? "" : ` The agent's last output was: ${stderr.slice(-500)}`;

  if (exit.timedOut) {
    return new AcpSessionError(
      `The ACP agent did not finish within this task's ${task.budget.wallMs}ms wall-clock budget and was killed (§9.5). ` +
        `Raise the task's budget, or split the goal — and if the task was waiting on a permission, answer it sooner.${detail}`,
    );
  }

  if (exit.aborted) {
    return new AcpSessionError(
      "The ACP session was aborted before the turn finished — the mission was paused or shut down. " +
        `Resume it with \`orchestra resume ${task.missionId}\`; the task is retried from the start.${detail}`,
    );
  }

  return new AcpSessionError(
    `The ACP agent exited (code ${String(exit.code)}, signal ${String(exit.signal)}) before the turn finished. ` +
      `Check the adapter runs on its own — \`orchestra doctor\` reports what is installed and authed.${detail}`,
  );
}

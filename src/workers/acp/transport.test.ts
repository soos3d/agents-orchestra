// The failure mode under test: a client that works against an idea of an agent.
//
// Every session below runs a real subprocess over real stdio — the scripted agent from
// `testing/acpAgent.ts`, whose frames are transcribed from captures rather than from this
// client's expectations. That is the whole point: an in-process stub would resolve a
// promise for a permission the transport never actually framed, complete a turn that was
// never streamed in chunks, and time out on a schedule the transport itself controlled.
//
// The adversarial ones are the ones that matter. A permission nobody answers must end as
// a killed session rather than a hang, because a task that waits forever parks a mission
// nothing can resume. A write outside the task's cwd must be refused, because the worktree
// is the blast radius (§8) and an agent that can name any absolute path has none. And
// `allow_always` must never be selected, because a standing grant is a widening no human
// was asked for (§7).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type WorkerRun } from "../../loop/dispatch.js";
import { type Task } from "../../domain/task.js";
import { fakeAcpAgent, type FakeAcpAgentOptions } from "../../testing/acpAgent.js";
import { aBudget, aCodeTask, anAgentSpec } from "../../testing/fixtures.js";
import { type PermissionRequest } from "./permissions.js";
import { parseRequestPermissionParams, parseSessionUpdate } from "./protocol.js";
import { type AcpLaunch } from "./registry.js";
import { sessionLogPath } from "./usage.js";
import {
  acpChildEnv,
  acpToolName,
  containedPath,
  createAcpTransport,
  permissionRequestOf,
  pickPermissionOption,
  rememberToolName,
  type AcpTransportDeps,
} from "./transport.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acp-transport-")));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function anAcpTask(
  patch: { tools?: string[]; wallMs?: number; target?: string; model?: string } = {},
): Task {
  return aCodeTask({
    agentSpec: anAgentSpec({
      transport: { id: "acp", target: patch.target ?? "claude" },
      tools: patch.tools ?? ["Read", "Write", "Edit"],
      ...(patch.model === undefined ? {} : { model: patch.model }),
    }),
    budget: aBudget({ wallMs: patch.wallMs ?? 10_000 }),
  });
}

/** A transport wired to a scripted agent instead of an `npx` download. */
function transportFor(
  agent: FakeAcpAgentOptions | AcpLaunch,
  deps: Partial<AcpTransportDeps> = {},
): ReturnType<typeof createAcpTransport> {
  const launch: AcpLaunch =
    "command" in agent
      ? agent
      : (() => {
          const fake = fakeAcpAgent(agent);
          return { command: fake.command, args: fake.args, env: fake.env as Record<string, string> };
        })();

  return createAcpTransport({
    requestPermission: async () => {
      throw new Error("requestPermission should not have been called");
    },
    ...deps,
    resolveAgent: () => launch,
  });
}

/** The same scripted agent, on a launch whose registry row says the model reaches it —
 *  `acp/opencode`'s row, which is the only one that does. */
function honouringLaunch(options: FakeAcpAgentOptions): AcpLaunch {
  const fake = fakeAcpAgent(options);
  return {
    command: fake.command,
    args: fake.args,
    env: fake.env as Record<string, string>,
    honoursModel: true,
  };
}

const TRANSCRIPTS = fileURLToPath(new URL("../../testing/acp-transcripts/", import.meta.url));

const REPORT = JSON.stringify({ outcome: "completed", summary: "did it" });

/** What the scripted agent answers `session/new` with — the id its usage would be
 *  filed under, so a test can plant a log where the transport will look for it. */
const SCRIPTED_SESSION_ID = "e638581a-6861-40a8-8840-9f6e27ea0858";

describe("the acp transport", () => {
  test("runs a session and returns the assembled final message", async () => {
    const cwd = tmpDir();
    const run: WorkerRun = await transportFor({ scenario: "happy", finalText: REPORT })({
      task: anAcpTask(),
      cwd,
    });

    // Streamed as three chunks by the agent; the report is only parseable once joined.
    assert.equal(run.raw, REPORT);
    assert.ok(run.elapsedMs >= 0);
  });

  /**
   * `AgentSpec.model` reaches an agent only where the launch says it does, and the two
   * halves of that fail differently (`workers/harness.ts`).
   *
   * Sending it to an adapter that ignores it would be the worse bug of the two: the spec's
   * model would then look honoured everywhere the harness row says it is not, and the
   * mission would be priced against a model that never ran.
   */
  describe("the model, where it is honoured", () => {
    test("is set on the session and reported as what ran", async () => {
      const run = await transportFor(honouringLaunch({ scenario: "happy", finalText: REPORT }))({
        task: anAcpTask({ model: "deepseek-v4" }),
        cwd: tmpDir(),
      });

      assert.equal(run.raw, REPORT);
      assert.equal(run.ranOn, "deepseek-v4");
    });

    // The invented-`--model` defect closed on the agent's side of the wire: the refusal
    // arrives before `session/prompt`, so nothing is spent on a model nobody chose.
    test("a model the agent does not have fails the task rather than running on another", async () => {
      const transport = transportFor(
        honouringLaunch({ scenario: "happy", finalText: REPORT, unknownModel: "not-a-model" }),
      );

      await assert.rejects(
        transport({ task: anAcpTask({ model: "not-a-model" }), cwd: tmpDir() }),
        /model not found/,
      );
    });

    test("is not sent to an adapter that picks its own", async () => {
      const run = await transportFor({ scenario: "happy", finalText: REPORT })({
        task: anAcpTask({ model: "deepseek-v4" }),
        cwd: tmpDir(),
      });

      // The scripted agent names no model in `session/new`, so anything here would be the
      // spec's own preference echoed back as fact.
      assert.equal(run.ranOn, undefined);
    });
  });

  // No frame carries usage (`protocol.ts`), so what a dispatch cost is read afterwards
  // from the agent's own session log — and every one of these three outcomes is a
  // different claim about how much the number can be trusted (§9.5, `usage.ts`).
  describe("what the dispatch cost", () => {
    /** The agent's session log, where `usage.ts` expects to find it. */
    function writeSessionLog(home: string, cwd: string, lines: readonly unknown[]): void {
      const file = sessionLogPath(home, cwd, SCRIPTED_SESSION_ID);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
    }

    test("reads the agent's own books when it kept them", async () => {
      const cwd = tmpDir();
      const home = tmpDir();
      writeSessionLog(home, cwd, [
        {
          type: "assistant",
          message: {
            id: "msg_1",
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 12,
              output_tokens: 900,
              cache_read_input_tokens: 288446,
              cache_creation_input_tokens: 34455,
            },
          },
        },
      ]);

      const run = await transportFor({ scenario: "happy", finalText: REPORT }, { home })({
        task: anAcpTask(),
        cwd,
      });

      // The number this whole change exists for: the dispatch used to be reported as
      // unmeasured while reading a quarter of a million cached tokens.
      assert.deepEqual(run.usage, {
        input: 12,
        output: 900,
        cacheRead: 288446,
        cacheWrite: 34455,
      });
      assert.equal(run.outputIsFloor, undefined, "a final output count was called a floor");
      // `AgentSpec.model` is never sent over ACP, so what actually ran is the adapter's
      // choice and has to be recorded rather than assumed.
      assert.equal(run.ranOn, "claude-opus-4-6");
    });

    test("marks a session log's output as a floor when it only holds snapshots", async () => {
      const cwd = tmpDir();
      const home = tmpDir();
      writeSessionLog(home, cwd, [
        { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 2 } } },
      ]);

      const run = await transportFor({ scenario: "happy", finalText: REPORT }, { home })({
        task: anAcpTask(),
        cwd,
      });

      assert.equal(run.outputIsFloor, true);
    });

    test("estimates from the wire when there is no log, and says so", async () => {
      const warnings: string[] = [];
      const run = await transportFor(
        { scenario: "happy", finalText: REPORT },
        { home: tmpDir(), onWarn: (message) => warnings.push(message) },
      )({ task: anAcpTask(), cwd: tmpDir() });

      // An estimate is a floor with a known direction, and it must never be presented
      // as a measurement — the flag is what keeps it out of `measured`.
      assert.ok((run.usage?.output ?? 0) > 0);
      assert.equal(run.outputIsFloor, true);
      assert.equal(run.usage?.cacheRead, undefined, "the wire cannot see cached input");
      assert.ok(
        warnings.some((message) => message.includes("estimated")),
        "the fallback happened silently",
      );
    });
  });

  // Real missions came back with "Unterminated string in JSON" worker reports, and a
  // long final message crossing stdio chunk boundaries was the suspect. These two are
  /**
   * Which tool a gate is about, replayed from the captured traffic of both agents.
   *
   * This is the transport's half of the permission decision and it is the half a unit
   * test with a scripted agent cannot see: the request frame carries no tool name, so
   * everything depends on what the updates before it said. A real mission is what caught
   * it — three granted `bash` calls arrived as `pwd`, `git` and `python3`, matched no
   * class, and were refused.
   */
  describe("naming the tool a gate is about", () => {
    function toolOfGate(file: string): string {
      const lines = fs
        .readFileSync(path.join(TRANSCRIPTS, file), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> });

      const names = new Map<string, string>();
      for (const line of lines) {
        if (line.dir !== "in") continue;
        if (line.frame["method"] === "session/update") {
          const update = parseSessionUpdate(line.frame["params"], () => undefined);
          if (update.kind === "tool_call" || update.kind === "tool_call_update") {
            rememberToolName(names, update);
          }
        }
        if (line.frame["method"] === "session/request_permission") {
          return permissionRequestOf(parseRequestPermissionParams(line.frame["params"]), names).tool;
        }
      }
      throw new Error(`no permission request captured in ${file}`);
    }

    // OpenCode names the tool once, in the `tool_call`, and every `tool_call_update`
    // after it rewrites the title to what the tool is *doing* — `bash` becomes `ls -la`.
    test("opencode: the first announcement names it, later updates do not rename it", () => {
      assert.equal(toolOfGate("opencode-bash-execute-approved.jsonl"), "bash");
      assert.equal(toolOfGate("opencode-write-file-approved.jsonl"), "write");
    });

    // Claude tags it in `_meta`, wrapped as an MCP tool. Unchanged by the fix above.
    test("claude: the tagged name wins over the title", () => {
      assert.equal(toolOfGate("claude-write-file-approved.jsonl"), "Write");
      assert.equal(toolOfGate("claude-bash-execute-approved.jsonl"), "Bash");
    });
  });

  // what that investigation turned into: reassembly is lossless across frame boundaries
  // — and was *not* lossless across character ones.
  describe("a long final message", () => {
    test("reassembles byte for byte across many stdio chunks", async () => {
      // Well past a pipe's 64 KiB read, so the frame is split several times over.
      const summary = "x".repeat(400_000);
      const report = JSON.stringify({ outcome: "completed", summary });

      const run: WorkerRun = await transportFor({ scenario: "happy", finalText: report })({
        task: anAcpTask({ wallMs: 30_000 }),
        cwd: tmpDir(),
      });

      assert.equal(run.raw.length, report.length);
      assert.equal(run.raw, report);
    });

    // A frame straddling a chunk is the boundary everyone thinks of. A *character*
    // straddling one is the boundary that actually bit: `Buffer.toString()` on a chunk
    // ending mid-sequence yields U+FFFD on both sides of the cut, and the damage
    // survives `JSON.parse` — the report comes back parseable and subtly wrong. Every
    // character here is three bytes and 65536 is not a multiple of three, so a read
    // boundary has to land inside one.
    test("survives a multi-byte character split across a chunk boundary", async () => {
      const summary = "—".repeat(100_000);
      const report = JSON.stringify({ outcome: "completed", summary });

      const run: WorkerRun = await transportFor({ scenario: "happy", finalText: report })({
        task: anAcpTask({ wallMs: 30_000 }),
        cwd: tmpDir(),
      });

      assert.ok(!run.raw.includes("�"), "no character was cut in half by a chunk boundary");
      assert.equal(JSON.parse(run.raw).summary, summary);
    });
  });

  test("refuses a target this build has no launch command for", async () => {
    const transport = createAcpTransport({
      requestPermission: async () => true,
      resolveAgent: () => undefined,
    });

    await assert.rejects(
      transport({ task: anAcpTask({ target: "gemini" }), cwd: tmpDir() }),
      (error: Error) => {
        assert.match(error.message, /gemini/);
        assert.match(error.message, /claude/);
        return true;
      },
    );
  });

  test("refuses a task routed to it by mistake", async () => {
    const task = aCodeTask({ agentSpec: anAgentSpec({ transport: { id: "cli", target: "claude" } }) });

    await assert.rejects(transportFor({ scenario: "happy" })({ task, cwd: tmpDir() }), /routeTransport/);
  });

  describe("permissions", () => {
    test("answers a granted tool itself, without troubling a human", async () => {
      const cwd = tmpDir();
      const writePath = path.join(cwd, "hello.txt");
      let asked = 0;

      const run = await transportFor(
        { scenario: "permission", finalText: REPORT, writePath },
        { requestPermission: async () => ((asked += 1), true) },
      )({ task: anAcpTask({ tools: ["Read", "Write", "Edit"] }), cwd });

      assert.equal(asked, 0, "a tool the spec was granted must not reach the inbox");
      assert.equal(fs.readFileSync(writePath, "utf8"), "hi");
      assert.equal(run.raw, REPORT);
    });

    test("asks the injected port about a tool outside the grant, and allows on yes", async () => {
      const cwd = tmpDir();
      const writePath = path.join(cwd, "hello.txt");
      const asked: { taskId: string; request: PermissionRequest }[] = [];

      const run = await transportFor(
        { scenario: "permission", finalText: REPORT, writePath },
        {
          requestPermission: async (taskId, request) => {
            asked.push({ taskId, request });
            return true;
          },
        },
      )({ task: anAcpTask({ tools: ["Read"] }), cwd });

      assert.equal(asked.length, 1);
      assert.equal(asked[0].taskId, "t1");
      // The tool name comes off the preceding `tool_call`, where claude-code-acp tags it
      // `mcp__acp__Write` — the request frame itself carries only a title.
      assert.equal(asked[0].request.tool, "Write");
      assert.match(asked[0].request.detail, /hello\.txt/);
      assert.equal(fs.readFileSync(writePath, "utf8"), "hi");
      assert.equal(run.raw, REPORT);
    });

    test("rejects on no, and the turn still finishes", async () => {
      const cwd = tmpDir();
      const writePath = path.join(cwd, "hello.txt");

      const run = await transportFor(
        { scenario: "permission", rejectedText: "not allowed", writePath },
        { requestPermission: async () => false },
      )({ task: anAcpTask({ tools: ["Read"] }), cwd });

      assert.equal(fs.existsSync(writePath), false);
      // The capture ends `end_turn` either way, which is why a stopReason never means
      // the work was done — the report does.
      assert.equal(run.raw, "not allowed");
    });

    // A permission nobody answers is a session nobody ends. The duplex timer keeps
    // running through the wait on purpose: the alternative is a mission parked behind a
    // subprocess that will never exit.
    test("an unanswered permission is killed by the task's own wall-clock budget", async () => {
      const cwd = tmpDir();

      await assert.rejects(
        transportFor(
          { scenario: "permission", writePath: path.join(cwd, "hello.txt") },
          { requestPermission: () => new Promise<boolean>(() => undefined) },
        )({ task: anAcpTask({ tools: ["Read"], wallMs: 600 }), cwd }),
        /budget/,
      );
    });

    test("never selects a standing grant, whatever the agent offers first", () => {
      const options = [
        { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ];

      assert.equal(pickPermissionOption(options, true), "allow");
      assert.equal(pickPermissionOption(options, false), "reject");
    });

    test("refuses to answer when the only way to say yes is a standing grant", () => {
      const options = [{ optionId: "allow_always", name: "Always Allow", kind: "allow_always" }];

      assert.throws(() => pickPermissionOption(options, true), /allow_always|standing/);
    });

    test("reads the tool name the adapter tags rather than the mcp wrapper", () => {
      assert.equal(acpToolName("mcp__acp__Write"), "Write");
      assert.equal(acpToolName("Bash"), "Bash");
      assert.equal(acpToolName("Write /tmp/hello.txt"), "Write");
    });
  });

  describe("the filesystem the client lends the agent", () => {
    test("writes only under the task's cwd", async () => {
      const cwd = tmpDir();
      const outside = path.join(tmpDir(), "escaped.txt");

      const run = await transportFor(
        { scenario: "permission", finalText: REPORT, writePath: outside },
        { requestPermission: async () => true },
      )({ task: anAcpTask({ tools: ["Read"] }), cwd });

      assert.equal(fs.existsSync(outside), false, "the worktree is the blast radius (§8)");
      // Refused in the protocol's own language, so the agent hears "no" and the turn
      // continues rather than hanging on an unanswered request.
      assert.equal(run.raw, REPORT);
    });

    test("containment survives `..` and a sibling sharing the prefix", () => {
      const root = tmpDir();

      assert.equal(containedPath(root, path.join(root, "a/b.txt")), path.join(root, "a/b.txt"));
      assert.equal(containedPath(root, "a/b.txt"), path.join(root, "a/b.txt"));
      assert.equal(containedPath(root, path.join(root, "../elsewhere.txt")), undefined);
      assert.equal(containedPath(root, `${root}-sibling/x.txt`), undefined);
      assert.equal(containedPath(root, "/etc/passwd"), undefined);
    });
  });

  describe("failure paths", () => {
    test("a turn that never ends is killed at the budget, as a transport failure", async () => {
      await assert.rejects(
        transportFor({ scenario: "hang" })({ task: anAcpTask({ wallMs: 500 }), cwd: tmpDir() }),
        (error: Error) => {
          assert.match(error.message, /budget/);
          assert.match(error.message, /500/);
          return true;
        },
      );
    });

    test("an agent that exits mid-turn fails with what happened", async () => {
      await assert.rejects(
        transportFor({ scenario: "disconnect" })({ task: anAcpTask(), cwd: tmpDir() }),
        /exited/,
      );
    });

    test("a spawn that never starts fails naming the command", async () => {
      await assert.rejects(
        transportFor({ command: "definitely-not-an-agent-binary", args: [] })({
          task: anAcpTask(),
          cwd: tmpDir(),
        }),
        /definitely-not-an-agent-binary/,
      );
    });

    test("an aborted mission ends the session rather than waiting it out", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        transportFor({ scenario: "hang" })({
          task: anAcpTask(),
          cwd: tmpDir(),
          signal: controller.signal,
        }),
        /abort/i,
      );
    });
  });

  // §9.1's rule 4, one protocol over: an agent newer than this client is not corruption.
  test("tolerates an unknown update and an unknown method without ending the turn", async () => {
    const warnings: string[] = [];

    const run = await transportFor(
      { command: process.execPath, args: ["-e", HOSTILE_AGENT] },
      { onWarn: (message) => warnings.push(message) },
    )({ task: anAcpTask(), cwd: tmpDir() });

    // The agent asked for a capability this client does not implement and was told so in
    // JSON-RPC rather than left waiting — the code it echoes back is METHOD_NOT_FOUND.
    assert.equal(run.raw, "code -32601");
    // One warning about the drift, and exactly one: the accounting pass warns for its
    // own reasons (no session log for a scripted agent), so the count is taken over
    // the warnings this test is about rather than over all of them.
    const drift = warnings.filter((message) => message.includes("thinking_out_loud"));
    assert.equal(drift.length, 1);
  });

  // Defect 42. Every session above spawns a real subprocess through this function, so
  // they are the evidence that a constructed environment still *starts* an agent; what
  // they cannot see is which variables it holds once it has. That is what these assert,
  // and the case that matters is a secret sitting in the orchestrator's own environment
  // that no envelope granted anybody.
  describe("what the adapter's process can see", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      CLAUDECODE: "1",
      AWS_SECRET_ACCESS_KEY: "leak-me",
      XERO_TOKEN: "granted-by-envelope",
    };
    const launch: AcpLaunch = { command: "npx", args: ["-y", "adapter"], inherits: ["PATH", "HOME"] };

    test("holds what the launch names and nothing else the orchestrator has", () => {
      const env = acpChildEnv(launch, anAcpTask(), parentEnv);

      assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/someone" });
    });

    test("carries a variable this task's envelope granted it", () => {
      const task = aCodeTask({
        agentSpec: anAgentSpec({ transport: { id: "acp", target: "claude" }, env: ["XERO_TOKEN"] }),
      });

      assert.equal(acpChildEnv(launch, task, parentEnv)["XERO_TOKEN"], "granted-by-envelope");
    });

    // The registry's oldest rule, now expressed as an absence rather than as a strip:
    // an adapter that inherits CLAUDECODE believes it is nested inside a session.
    test("never carries CLAUDECODE, whatever the orchestrator is running under", () => {
      assert.equal("CLAUDECODE" in acpChildEnv(launch, anAcpTask(), parentEnv), false);
    });

    test("a launch's own values are set outright", () => {
      const env = acpChildEnv({ ...launch, env: { ADAPTER_MODE: "acp" } }, anAcpTask(), parentEnv);

      assert.equal(env["ADAPTER_MODE"], "acp");
    });
  });
});

/**
 * An agent that speaks a dialect this client does not know: an invented `session/update`
 * variant, and a request for a method we never declared. Inline rather than a scenario on
 * the scripted agent, because the scripted agent is transcribed from real captures and
 * frames nobody has ever sent do not belong in it.
 */
const HOSTILE_AGENT = `
let promptId;
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });
function handle(m) {
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  if (m.method === "session/prompt") {
    promptId = m.id;
    update({ sessionUpdate: "thinking_out_loud", text: "hmm" });
    return send({ jsonrpc: "2.0", id: 99, method: "terminal/create", params: {} });
  }
  if (m.id === 99) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "code " + m.error.code } });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
}
let buffer = "";
process.stdin.on("data", (d) => {
  buffer += d.toString();
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

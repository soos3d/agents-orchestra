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
import { type WorkerRun } from "../../loop/dispatch.js";
import { type Task } from "../../domain/task.js";
import { fakeAcpAgent, type FakeAcpAgentOptions } from "../../testing/acpAgent.js";
import { aBudget, aCodeTask, anAgentSpec } from "../../testing/fixtures.js";
import { type PermissionRequest } from "./permissions.js";
import { type AcpLaunch } from "./registry.js";
import {
  acpToolName,
  containedPath,
  createAcpTransport,
  pickPermissionOption,
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

function anAcpTask(patch: { tools?: string[]; wallMs?: number; target?: string } = {}): Task {
  return aCodeTask({
    agentSpec: anAgentSpec({
      transport: { id: "acp", target: patch.target ?? "claude" },
      tools: patch.tools ?? ["Read", "Write", "Edit"],
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

const REPORT = JSON.stringify({ outcome: "completed", summary: "did it" });

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
    // No frame in any capture carries usage, so the field stays absent — never a
    // confident 0, which is what `Spend.tokens.unmeasured` exists to refuse (§9.5).
    assert.equal(run.measuredTokens, undefined);
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
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /thinking_out_loud/);
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

// The composition root under test, because that is where features get finished and
// switched off at once (defects 12b, 23, 24): `serve` wires the registry, the shared
// server, and the surface a composed mission publishes through — and every one of
// those is an optional dependency something else defaults to nothing.
//
// The mission runner is injected. A real `runMission` would need a repo, a model,
// and a worker CLI; what this file has to prove is the serve process's own wiring —
// a compose reaches the runner with a working surface, one mission runs at a time,
// a live mission cannot be forgotten, and a parked mission can still be answered.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import { type Carrier, type CarrierReply } from "../channel/carrier.js";
import { type GateCard } from "../channel/cards.js";
import { type DiscoveredConfig } from "../config/discover.js";
import { fold } from "../events/fold.js";
import { createEventLog } from "../events/log.js";
import { createFileStore } from "../loop/store.js";
import { aCodeTask, missionCreated } from "../testing/fixtures.js";
import { type WorkspacesFrame } from "../web/protocol.js";
import { createWebHuman } from "../web/webHuman.js";
import { workspaceId } from "../config/workspaces.js";
import { type Io } from "./main.js";
import { type RunOptions } from "./runCommand.js";
import { parseServeArgs, serve, type ServeDeps } from "./serveCommand.js";

const quietIo: Io = { out: () => {}, err: () => {} };

function scratchConfig(): DiscoveredConfig {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-serve-"));
  return {
    cwd: stateDir,
    stateDir,
    worktreeRoot: path.join(stateDir, "worktrees"),
    agents: [],
    orchestratorModel: "sonnet",
    maxConcurrency: 4,
  };
}

function seedParkedMission(stateDir: string, missionId: string): void {
  const store = createFileStore(path.join(stateDir, "missions", missionId));
  store.emit(missionCreated({ missionId }));
  store.emit({
    missionId,
    actor: "orchestrator",
    type: "task_planned",
    task: aCodeTask({ missionId }),
  });
  store.emit({
    missionId,
    actor: "orchestrator",
    taskId: "t1",
    type: "question_asked",
    questionId: "q1",
    question: "Which account?",
    blocks: ["t1"],
  });
}

describe("parseServeArgs", () => {
  test("defaults, --port, and an unknown flag", () => {
    assert.deepEqual(parseServeArgs([]), { ok: true, options: {} });
    assert.deepEqual(parseServeArgs(["--port", "4600"]), { ok: true, options: { port: 4600 } });
    assert.equal(parseServeArgs(["--port", "nope"]).ok, false);
    assert.equal(parseServeArgs(["--unattended"]).ok, false);
  });
});

describe("serve", () => {
  const stops: AbortController[] = [];
  const done: Promise<number>[] = [];
  after(async () => {
    for (const stop of stops) stop.abort();
    await Promise.all(done);
  });

  interface Started {
    url: string;
    send(message: object): void;
    /** The next frame that is *not* the workspace listing. Workspaces ride every
     *  publish (U4), so folding them into this queue would make every existing
     *  assertion about frame order a test of how many times the server published. */
    next(): Promise<Record<string, unknown>>;
    /** The next workspace listing. */
    nextWorkspaces(): Promise<WorkspacesFrame>;
    /** The next frame that is neither listing — a refusal, or an event push. Every
     *  publish carries a mission listing, so waiting for a rejection means skipping
     *  however many of those happened to land first. */
    nextDecision(): Promise<Record<string, unknown>>;
    runs: RunOptions[];
  }

  /** Boots serve with an injected runner, connects a client, and buffers frames. */
  async function boot(
    config: DiscoveredConfig,
    runner?: ServeDeps["run"],
    extra: Partial<ServeDeps> = {},
  ): Promise<Started> {
    const stop = new AbortController();
    stops.push(stop);

    const runs: RunOptions[] = [];
    const urlReady = new Promise<string>((resolve) => {
      const io: Io = { out: (line) => { if (line.startsWith("dashboard:")) resolve(line.slice(11)); }, err: () => {} };
      done.push(
        serve({}, config, io, {
          createCalls: () => {
            throw new Error("these tests never reach a model");
          },
          run: async (options, ...rest) => {
            runs.push(options);
            return runner ? runner(options, ...rest) : 0;
          },
          ...extra,
          signal: stop.signal,
        }),
      );
    });

    const url = (await urlReady).trim();
    const socket = new WebSocket(url.replace("http://", "ws://"));
    const buffered: Record<string, unknown>[] = [];
    const waiting: ((frame: Record<string, unknown>) => void)[] = [];
    const bufferedWorkspaces: WorkspacesFrame[] = [];
    const waitingWorkspaces: ((frame: WorkspacesFrame) => void)[] = [];
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === "workspaces") {
        const next = waitingWorkspaces.shift();
        if (next) next(frame as WorkspacesFrame);
        else bufferedWorkspaces.push(frame as WorkspacesFrame);
        return;
      }
      const next = waiting.shift();
      if (next) next(frame);
      else buffered.push(frame);
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const next = (): Promise<Record<string, unknown>> =>
      new Promise((settle) => {
        const ready = buffered.shift();
        if (ready) settle(ready);
        else waiting.push(settle);
      });

    return {
      url,
      send: (message) => socket.send(JSON.stringify(message)),
      next,
      nextDecision: async () => {
        let frame = await next();
        while (frame.kind === "missions") frame = await next();
        return frame;
      },
      nextWorkspaces: () =>
        new Promise<WorkspacesFrame>((settle) => {
          const ready = bufferedWorkspaces.shift();
          if (ready) settle(ready);
          else waitingWorkspaces.push(settle);
        }),
      runs,
    };
  }

  test("a compose reaches the runner, and a second is refused while one is live", async () => {
    const config = scratchConfig();

    let release = () => {};
    const client = await boot(config, async (options, _config, _io, deps) => {
      // A runner that registers like the real one and stays live until released.
      deps.surface!.register("m-live", {
        human: createWebHuman(),
        store: { emit: () => {}, state: () => { throw new Error("unused"); } },
        onPanic: () => {},
      });
      await new Promise<void>((resolve) => { release = resolve; });
      deps.surface!.release("m-live");
      return 0;
    });
    await client.next(); // the listing

    client.send({ kind: "compose", goal: "reconcile invoices", budgetMinutes: 30 });
    // The registration publish carries a fresh listing; wait for it so the second
    // compose races nothing.
    await client.next();
    assert.equal(client.runs.length, 1);
    assert.equal(client.runs[0]?.goal, "reconcile invoices");
    assert.equal(client.runs[0]?.budgetMinutes, 30);
    assert.equal(client.runs[0]?.unattended, false);

    client.send({ kind: "compose", goal: "another one" });
    const rejected = await client.next();
    assert.equal(rejected.kind, "rejected");
    assert.match(String(rejected.problem), /one at a time/);

    release();
  });

  test("forget refuses the live mission and deletes a parked one", async () => {
    const config = scratchConfig();
    seedParkedMission(config.stateDir, "m-parked");
    seedParkedMission(config.stateDir, "m-live");

    let release = () => {};
    const client = await boot(config, async (_options, _config, _io, deps) => {
      deps.surface!.register("m-live", {
        human: createWebHuman(),
        store: { emit: () => {}, state: () => { throw new Error("unused"); } },
        onPanic: () => {},
      });
      await new Promise<void>((resolve) => { release = resolve; });
      deps.surface!.release("m-live");
      return 0;
    });
    await client.next();
    client.send({ kind: "compose", goal: "hold the live slot" });
    await client.next();

    client.send({ kind: "forget", missionId: "m-live" });
    const refused = await client.next();
    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /running/);
    assert.ok(fs.existsSync(path.join(config.stateDir, "missions", "m-live")));

    client.send({ kind: "forget", missionId: "m-parked" });
    const listing = await client.next();
    assert.equal(listing.kind, "missions");
    assert.equal(fs.existsSync(path.join(config.stateDir, "missions", "m-parked")), false);

    release();
  });

  test("an answer reaches a parked mission no loop is running for", async () => {
    const config = scratchConfig();
    seedParkedMission(config.stateDir, "m-parked");

    const client = await boot(config);
    await client.next();

    client.send({ kind: "answer", missionId: "m-parked", questionId: "q1", answer: "staging" });
    await client.next(); // the publish that follows the append

    const events = createEventLog(path.join(config.stateDir, "missions", "m-parked")).read();
    const state = fold(events);
    assert.ok(events.some((e) => e.type === "question_answered"));
    assert.equal(state.tasks[0]?.status, "waiting");
  });

  // The mirror wiring, against a hostile carrier (§17): the carrier is fake and the
  // trust decisions are real. What has to hold — the card leaves without a
  // screenshot, a forged reply approves nothing, a forwarded reply is refused and
  // reported, and the same valid reply approves once.
  test("mirrors a live question and lets only the bound sender answer it, once", async () => {
    const config = scratchConfig();
    // The live mission's log holds an open question before the runner registers.
    seedParkedMission(config.stateDir, "m-live");

    const published: GateCard[] = [];
    let reply: (r: CarrierReply) => void = () => {
      throw new Error("the carrier was never given a reply handler");
    };
    const carrier: Carrier = {
      id: "test",
      publish: async (card) => {
        published.push(card);
      },
      onReply: (handler) => {
        reply = handler;
      },
    };

    let release = () => {};
    const client = await boot(
      config,
      async (_options, _config2, _io, deps) => {
        const store = createFileStore(path.join(config.stateDir, "missions", "m-live"));
        deps.surface!.register("m-live", { human: createWebHuman(), store, onPanic: () => {} });
        await new Promise<void>((r) => { release = r; });
        deps.surface!.release("m-live");
        return 0;
      },
      { channel: { carrier, identity: { carrier: "test", senderId: "davide-123", boundAt: "2026-08-01T00:00:00Z" } } },
    );
    await client.next(); // the listing
    client.send({ kind: "compose", goal: "hold the live slot" });
    await client.next(); // the registration publish

    // The open question was carded, with a nonce and without the screenshot field
    // even existing.
    assert.equal(published.length, 1);
    const card = published[0]!;
    assert.equal(card.itemId, "q1");
    assert.match(card.caption, /Which account\?/);
    assert.ok(card.nonce.length >= 32);

    const logOf = () =>
      createEventLog(path.join(config.stateDir, "missions", "m-live")).read();

    // Forged: a nonce the carrier invented approves nothing.
    reply({ nonce: "invented-by-the-carrier", senderId: "davide-123", text: "production" });
    assert.equal(logOf().some((e) => e.type === "question_answered"), false);

    // Forwarded: the right nonce from the wrong account is refused, recorded, and
    // the bound user is told.
    reply({ nonce: card.nonce, senderId: "mallory-999", text: "production" });
    assert.equal(logOf().some((e) => e.type === "question_answered"), false);
    assert.ok(logOf().some((e) => e.type === "envelope_violation"));
    assert.ok(published.some((c) => c.kind === "notice"));

    // The bound sender answers — once; the replayed duplicate does nothing.
    reply({ nonce: card.nonce, senderId: "davide-123", text: "the staging one" });
    reply({ nonce: card.nonce, senderId: "davide-123", text: "the staging one" });
    const answers = logOf().filter((e) => e.type === "question_answered");
    assert.equal(answers.length, 1);
    assert.ok("answer" in answers[0]! && answers[0].answer === "the staging one");

    release();
  });

  // ── workspaces (UI plan U4) ──
  //
  // The cap is what these are really about. It exists so two missions never share one
  // checkout and one merge queue, and under U4 it became a lookup on a workspace id —
  // so "two directories may run at once" and "one directory may not" have to be
  // asserted together, or the generalisation quietly removes the protection.

  /** A runner that registers and stays live until it is released. */
  function holdingRunner(): { runner: NonNullable<ServeDeps["run"]>; releaseAll: () => void } {
    const releases: (() => void)[] = [];
    let count = 0;
    return {
      releaseAll: () => releases.forEach((release) => release()),
      runner: async (_options, runConfig, _io, deps) => {
        const missionId = `m-${++count}`;
        deps.surface!.register(missionId, {
          human: createWebHuman(),
          store: {
            emit: () => {},
            state: () => {
              throw new Error(`unused (${runConfig.cwd})`);
            },
          },
          onPanic: () => {},
        });
        await new Promise<void>((resolve) => releases.push(resolve));
        deps.surface!.release(missionId);
        return 0;
      },
    };
  }

  test("the directory serve was started in is a workspace without being registered", async () => {
    const config = scratchConfig();
    const client = await boot(config);

    const frame = await client.nextWorkspaces();

    assert.equal(frame.defaultId, workspaceId(fs.realpathSync(config.cwd)));
    assert.deepEqual(
      frame.workspaces.map((workspace) => workspace.path),
      [fs.realpathSync(config.cwd)],
    );
    // Never written to disk: it is the cwd, and persisting it would record on every
    // boot a fact the process already carries.
    assert.equal(fs.existsSync(path.join(config.stateDir, "workspaces.json")), false);
  });

  // The structural rule: naming a directory and using one are separate acts, and the
  // server refuses an add whose resolution it did not itself just report. A stale tab
  // replaying an old add cannot register a directory nobody was shown.
  test("a workspace cannot be added without first being resolved and shown", async () => {
    const config = scratchConfig();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-other-")));
    const client = await boot(config);
    await client.nextWorkspaces();

    client.send({ kind: "workspace_add", path: other, create: false });
    const refused = await client.nextDecision();
    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /check the directory first/);

    client.send({ kind: "workspace_probe", path: other });
    const probed = await client.nextWorkspaces();
    assert.equal(probed.pending?.path, other);
    assert.equal(probed.pending?.exists, true);

    client.send({ kind: "workspace_add", path: other, create: false });
    const added = await client.nextWorkspaces();
    assert.equal(added.pending, null, "the resolution was not cleared once it was used");
    assert.ok(added.workspaces.some((workspace) => workspace.path === other));
    assert.ok(fs.existsSync(path.join(config.stateDir, "workspaces.json")));
  });

  test("a directory is created from the browser, and only when creating was confirmed", async () => {
    const config = scratchConfig();
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-parent-")));
    const target = path.join(parent, "ledger");
    const client = await boot(config);
    await client.nextWorkspaces();

    client.send({ kind: "workspace_probe", path: target });
    const probed = await client.nextWorkspaces();
    assert.equal(probed.pending?.exists, false);
    assert.equal(probed.pending?.problem, undefined, "a path to create was refused as a problem");

    // Confirming an add without confirming the creation does not create anything.
    client.send({ kind: "workspace_add", path: target, create: false });
    const refused = await client.nextDecision();
    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /does not exist/);
    assert.equal(fs.existsSync(target), false);

    client.send({ kind: "workspace_add", path: target, create: true });
    const added = await client.nextWorkspaces();
    assert.equal(fs.existsSync(target), true);
    assert.ok(added.workspaces.some((workspace) => workspace.path === target));
  });

  test("two workspaces run at once; a second mission in one of them is refused", async () => {
    const config = scratchConfig();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-other-")));
    const held = holdingRunner();
    const client = await boot(config, held.runner);
    const first = await client.nextWorkspaces();

    client.send({ kind: "workspace_probe", path: other });
    await client.nextWorkspaces();
    client.send({ kind: "workspace_add", path: other, create: false });
    const registered = await client.nextWorkspaces();
    const otherId = registered.workspaces.find((workspace) => workspace.path === other)!.id;

    client.send({ kind: "compose", goal: "in the launch directory" });
    await client.nextWorkspaces();
    client.send({ kind: "compose", goal: "in the other one", workspaceId: otherId });
    const both = await client.nextWorkspaces();

    assert.equal(client.runs.length, 2, "the second workspace was refused a mission");
    assert.equal(Object.keys(both.live).length, 2);
    assert.ok(both.live[first.defaultId]);
    assert.ok(both.live[otherId]);

    // …and the cap still holds inside one directory, which is the whole reason it
    // exists: two missions there would share a checkout and a merge queue.
    client.send({ kind: "compose", goal: "a third, in the launch directory again" });
    const refused = await client.nextDecision();
    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /one at a time per directory/);
    assert.equal(client.runs.length, 2);

    held.releaseAll();
  });

  test("each mission runs against its own workspace's discovered config", async () => {
    const config = scratchConfig();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-other-")));
    const cwds: string[] = [];
    const held = holdingRunner();
    const client = await boot(config, async (options, runConfig, io, deps) => {
      cwds.push(runConfig.cwd);
      return held.runner(options, runConfig, io, deps);
    });
    await client.nextWorkspaces();

    client.send({ kind: "workspace_probe", path: other });
    await client.nextWorkspaces();
    client.send({ kind: "workspace_add", path: other, create: false });
    const registered = await client.nextWorkspaces();
    const otherId = registered.workspaces.find((workspace) => workspace.path === other)!.id;

    client.send({ kind: "compose", goal: "over there", workspaceId: otherId });
    await client.nextWorkspaces();

    assert.deepEqual(cwds, [other]);
    held.releaseAll();
  });

  test("a workspace holding a live mission cannot be removed, and neither can the launch directory", async () => {
    const config = scratchConfig();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-other-")));
    const held = holdingRunner();
    const client = await boot(config, held.runner);
    const first = await client.nextWorkspaces();

    client.send({ kind: "workspace_forget", workspaceId: first.defaultId });
    const refusedDefault = await client.nextDecision();
    assert.equal(refusedDefault.kind, "rejected");
    assert.match(String(refusedDefault.problem), /serve was started in/);

    client.send({ kind: "workspace_probe", path: other });
    await client.nextWorkspaces();
    client.send({ kind: "workspace_add", path: other, create: false });
    const registered = await client.nextWorkspaces();
    const otherId = registered.workspaces.find((workspace) => workspace.path === other)!.id;

    client.send({ kind: "compose", goal: "over there", workspaceId: otherId });
    await client.nextWorkspaces();

    client.send({ kind: "workspace_forget", workspaceId: otherId });
    const refusedLive = await client.nextDecision();
    assert.equal(refusedLive.kind, "rejected");
    assert.match(String(refusedLive.problem), /is running there/);

    held.releaseAll();
  });

  test("composing into a workspace that was never added is refused by id", async () => {
    const client = await boot(scratchConfig());
    await client.nextWorkspaces();

    client.send({ kind: "compose", goal: "somewhere else entirely", workspaceId: "ws-000000000000" });
    const refused = await client.nextDecision();

    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /no workspace/);
  });

  test("a runner that rejects does not take the serve process down", async () => {
    const config = scratchConfig();
    const client = await boot(config, async () => {
      throw new Error("the mission blew up");
    });
    await client.next();

    client.send({ kind: "compose", goal: "doomed" });
    // Still serving: the next message gets an answer rather than a dead socket. An
    // approve with nothing live must reject; the failed run's own publish may
    // interleave a listing frame first.
    client.send({ kind: "approve" });
    let frame = await client.next();
    while (frame.kind === "missions") frame = await client.next();
    assert.equal(frame.kind, "rejected");
    assert.match(String(frame.problem), /no mission is running/);
  });
});

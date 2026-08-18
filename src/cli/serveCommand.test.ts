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
import { type DiscoveredConfig } from "../config/discover.js";
import { fold } from "../events/fold.js";
import { createEventLog } from "../events/log.js";
import { createFileStore } from "../loop/store.js";
import { aCodeTask, anEnvelope, missionCreated } from "../testing/fixtures.js";
import { type HealthFrame, type WorkspacesFrame } from "../web/protocol.js";
import { createWebHuman } from "../web/webHuman.js";
import { workspaceId } from "../config/workspaces.js";
import { type Io } from "./main.js";
import { type RunOptions } from "./runCommand.js";
import { parseServeArgs, serve, type ServeDeps } from "./serveCommand.js";

function scratchConfig(): DiscoveredConfig {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-serve-"));
  return {
    cwd: stateDir,
    stateDir,
    worktreeRoot: path.join(stateDir, "worktrees"),
    agents: [],
    orchestratorModel: "sonnet",
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
    /** The doctor report, sent once on connect (U6). Kept out of `next()` for the
     *  reason the workspace listing is: a frame that rides the connection is not a
     *  reply to anything, and threading it through the queue would make every
     *  assertion about frame order a test of what the server volunteers. */
    nextHealth(): Promise<HealthFrame>;
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
    const bufferedHealth: HealthFrame[] = [];
    const waitingHealth: ((frame: HealthFrame) => void)[] = [];
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === "workspaces") {
        const next = waitingWorkspaces.shift();
        if (next) next(frame as WorkspacesFrame);
        else bufferedWorkspaces.push(frame as WorkspacesFrame);
        return;
      }
      if (frame.kind === "health") {
        const next = waitingHealth.shift();
        if (next) next(frame as HealthFrame);
        else bufferedHealth.push(frame as HealthFrame);
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
      nextHealth: () =>
        new Promise<HealthFrame>((settle) => {
          const ready = bufferedHealth.shift();
          if (ready) settle(ready);
          else waitingHealth.push(settle);
        }),
      runs,
    };
  }

  test("a compose reaches the runner, and a second is refused while one is live", async () => {
    const config = scratchConfig();

    let release = () => {};
    const client = await boot(config, async (_options, _config, _io, deps) => {
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

  // ── terminal parity (UI plan U6) ──
  //
  // The point of these is that the browser can now do what only a typed command could,
  // and the risk they cover is the one U4 introduced: a mission is resumed *somewhere*,
  // and nothing in the message says where. The directory comes from the mission's own
  // envelope, and a mission scoped to a directory this process was never shown is
  // refused rather than run in the launch directory by default.

  /** A parked mission scoped to `root` — what `defaultEnvelope` writes for a mission
   *  composed in that workspace. */
  function seedScopedMission(stateDir: string, missionId: string, root: string): void {
    const store = createFileStore(path.join(stateDir, "missions", missionId));
    store.emit(missionCreated({ missionId, envelope: anEnvelope({ fsRoots: [root] }) }));
    store.emit({ missionId, actor: "human", type: "signoff_granted", unattended: false });
    store.emit({
      missionId,
      actor: "orchestrator",
      type: "task_planned",
      task: aCodeTask({ missionId }),
    });
  }

  test("a parked mission is resumed in the workspace its envelope names", async () => {
    const config = scratchConfig();
    const launch = fs.realpathSync(config.cwd);
    seedScopedMission(config.stateDir, "m-parked", launch);

    const resumed: { missionId: string; cwd: string }[] = [];
    let release = () => {};
    const client = await boot(config, undefined, {
      resume: async (missionId, resumeConfig, _io, deps) => {
        resumed.push({ missionId, cwd: resumeConfig.cwd });
        deps.surface!.register(missionId, {
          human: createWebHuman(),
          store: { emit: () => {}, state: () => { throw new Error("unused"); } },
          onPanic: () => {},
        });
        await new Promise<void>((resolve) => { release = resolve; });
        deps.surface!.release(missionId);
        return 0;
      },
    });
    await client.next(); // the listing

    client.send({ kind: "resume", missionId: "m-parked" });
    const started = await client.nextDecision();
    assert.equal(started.kind, "noted");
    assert.match(String(started.note), /Resuming m-parked/);
    // Compared through `realpathSync`, the macOS `/var` vs `/private/var` rule: the
    // launch workspace's *path* is resolved and its discovered config's `cwd` is the
    // one the process was started with, which are two spellings of one directory.
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]?.missionId, "m-parked");
    assert.equal(fs.realpathSync(resumed[0]!.cwd), launch);

    // It holds the workspace while it runs, so a compose into the same directory is
    // refused by the same cap a second compose is — resume is not a way around it.
    client.send({ kind: "compose", goal: "in the same directory" });
    const refusedCompose = await client.nextDecision();
    assert.equal(refusedCompose.kind, "rejected");
    assert.match(String(refusedCompose.problem), /one at a time per directory/);

    client.send({ kind: "resume", missionId: "m-parked" });
    const refusedResume = await client.nextDecision();
    assert.equal(refusedResume.kind, "rejected");
    assert.match(String(refusedResume.problem), /already running/);
    assert.equal(resumed.length, 1);

    release();
  });

  test("a mission scoped to a directory this server was never shown is refused, with the command that works", async () => {
    const config = scratchConfig();
    // `seedParkedMission`'s envelope names /repo, which is nobody's workspace here.
    seedParkedMission(config.stateDir, "m-elsewhere");

    const resumed: string[] = [];
    const client = await boot(config, undefined, {
      resume: async (missionId) => {
        resumed.push(missionId);
        return 0;
      },
    });
    await client.next();

    client.send({ kind: "resume", missionId: "m-elsewhere" });
    const refused = await client.nextDecision();

    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /\/repo/);
    assert.match(String(refused.problem), /orchestra resume m-elsewhere/);
    assert.deepEqual(resumed, [], "a mission was resumed in a directory nobody chose");

    client.send({ kind: "resume", missionId: "no-such-mission" });
    const unknown = await client.nextDecision();
    assert.equal(unknown.kind, "rejected");
    assert.match(String(unknown.problem), /no mission/);
  });

  test("save and promote reach procedural memory, and a name that is a path does not", async () => {
    const config = scratchConfig();
    seedScopedMission(config.stateDir, "m-done", fs.realpathSync(config.cwd));

    const client = await boot(config);
    await client.next();

    // Both are acknowledged, and that is not a nicety: neither writes an event, so a
    // click that worked and a click that vanished are the same picture without it.
    client.send({ kind: "save", missionId: "m-done", name: "monthly-reconcile" });
    const saved = await client.nextDecision();
    assert.equal(saved.kind, "noted");
    assert.match(String(saved.note), /monthly-reconcile/);
    assert.ok(fs.existsSync(path.join(config.stateDir, "saved", "monthly-reconcile.md")));

    client.send({ kind: "promote", missionId: "m-done", taskId: "t1", name: "reconciler" });
    const promoted = await client.nextDecision();
    assert.equal(promoted.kind, "noted");
    assert.ok(fs.existsSync(path.join(config.stateDir, "profiles", "reconciler.md")));

    // The refusals are the memory layer's own, reported rather than thrown: both of
    // these are things a human typed into a box.
    client.send({ kind: "promote", missionId: "m-done", taskId: "t9", name: "whoever" });
    const noTask = await client.nextDecision();
    assert.equal(noTask.kind, "rejected");
    assert.match(String(noTask.problem), /t1/);

    client.send({ kind: "save", missionId: "m-done", name: "../escape" });
    const escape = await client.nextDecision();
    assert.equal(escape.kind, "rejected");
    assert.match(String(escape.problem), /name/);
  });

  test("plan-only rides the compose through, and unattended has no way in", async () => {
    const config = scratchConfig();
    const client = await boot(config);
    await client.next();

    client.send({ kind: "compose", goal: "what would this take?", planOnly: true });
    await client.next();

    assert.equal(client.runs[0]?.planOnly, true);
    // The one flag the page may never set, whatever it sends (§17).
    assert.equal(client.runs[0]?.unattended, false);
  });

  // PLAN-NEXT 8.2. The compose card offers both checkboxes, so it can send both — and
  // the pair is refused here for the reason `--quick --moonshot` is refused at parse:
  // whichever one this process picked, half the people ticking both would get the other
  // mission.
  test("moonshot rides the compose through, and never alongside quick", async () => {
    const config = scratchConfig();
    const client = await boot(config);
    await client.next();

    client.send({ kind: "compose", goal: "worth spending on", moonshot: true });
    await client.next();
    assert.equal(client.runs[0]?.moonshot, true);

    client.send({ kind: "compose", goal: "both at once", quick: true, moonshot: true });
    const refused = await client.nextDecision();

    assert.equal(refused.kind, "rejected");
    assert.match(String(refused.problem), /untick one/);
  });

  test("the doctor report reaches the page, and names what this machine can start", async () => {
    const config = scratchConfig();
    const client = await boot(config);

    const health = await client.nextHealth();

    assert.ok(health.checks.some((check) => check.name === "node"));
    // No agents on PATH in this config, so nothing can be dispatched — the transports
    // line is `availableTransports`, never the registry the build ships (defect 21).
    assert.deepEqual(health.transports, []);
    assert.equal(health.ready, false);
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

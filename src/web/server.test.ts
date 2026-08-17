// This layer is below the fixture harness in the same way `agentCalls.ts` is: nothing
// above it substitutes for a socket, so a green suite says nothing about what a
// browser can actually do. Six defects hid in the last file with that property.
//
// The mitigation is the same one: what the server *decides* — which events a client
// has not seen, whether a frame is a message, whether a decision has anywhere to go —
// is a pure function asserted here, and the socket is exercised end to end for the
// handful of things only a real connection can show.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import { missionCreated, stamp } from "../testing/fixtures.js";
import { BUNDLE_ROUTE } from "./assets.js";
import { type Event, type EventInput } from "../events/schema.js";
import { isOfferedRuntime, isOfferedStaffing, parseClientMessage } from "./protocol.js";
import { eventsSince, HOST, isAllowedOrigin, startWebServer, type RunningServer } from "./server.js";
import { createWebHuman } from "./webHuman.js";

const someEvents = (count: number): Event[] =>
  stamp([
    missionCreated(),
    ...Array.from(
      { length: count - 1 },
      (_, index) =>
        ({
          type: "round_started",
          missionId: "m1",
          actor: "orchestrator",
          round: index + 1,
        }) as EventInput,
    ),
  ]);

describe("eventsSince", () => {
  test("replay-on-connect and live tail are the same call", () => {
    const events = someEvents(4);

    assert.equal(eventsSince(events, 0).length, 4);
    assert.equal(eventsSince(events, 2).length, 2);
    assert.equal(eventsSince(events, 4).length, 0);
  });

  test("a cursor past the end returns nothing rather than replaying", () => {
    assert.deepEqual(eventsSince(someEvents(2), 99), []);
  });
});

// A WebSocket is not subject to the same-origin policy, so "bound to loopback" is a
// statement about the network and not about who may connect: any page in any tab can
// open ws://127.0.0.1:<port> and send `approve` or `panic`, and read the mission's
// events back. The origin check is what makes loopback mean what §17 claims it means.
describe("isAllowedOrigin", () => {
  test("a native client sends no Origin at all, and is allowed", () => {
    assert.equal(isAllowedOrigin(undefined, 4173), true);
  });

  test("the page this server served is allowed, by either loopback name", () => {
    assert.equal(isAllowedOrigin("http://127.0.0.1:4173", 4173), true);
    assert.equal(isAllowedOrigin("http://localhost:4173", 4173), true);
    assert.equal(isAllowedOrigin("http://[::1]:4173", 4173), true);
  });

  // The attack this exists for: the user visits a page, that page opens a socket to
  // a port it guessed, and approves a plan the user never saw.
  test("refuses a remote origin whatever it claims to be", () => {
    for (const origin of [
      "https://evil.example",
      "http://127.0.0.1.evil.example:4173",
      "http://evil.example:4173",
      "http://notlocalhost:4173",
    ]) {
      assert.equal(isAllowedOrigin(origin, 4173), false, origin);
    }
  });

  // A sandboxed iframe on a hostile page sends the literal string "null", which is
  // neither absent nor parseable — the case a `!origin` guard would wave through.
  test("refuses a null origin rather than reading it as absent", () => {
    assert.equal(isAllowedOrigin("null", 4173), false);
    assert.equal(isAllowedOrigin("", 4173), false);
    assert.equal(isAllowedOrigin("not a url", 4173), false);
  });

  // Another local service is not this local service. A dev server on :3000 is a page
  // the user is running, not a page the user approved anything on.
  test("refuses loopback on a different port", () => {
    assert.equal(isAllowedOrigin("http://127.0.0.1:3000", 4173), false);
  });
});

describe("parseClientMessage", () => {
  test("accepts the decisions the page can send", () => {
    assert.deepEqual(parseClientMessage('{"kind":"approve"}'), {
      ok: true,
      message: { kind: "approve" },
    });
    assert.equal(parseClientMessage('{"kind":"revise","feedback":"narrow t1"}').ok, true);
    assert.equal(parseClientMessage('{"kind":"intake","answers":[]}').ok, true);
  });

  // The socket is on loopback, which is an argument about the network and not about
  // the bytes: a stale tab sends the same handler a frame from an older build.
  test("rejects rather than throwing, so one bad frame is not a dead server", () => {
    for (const raw of ["", "not json", "[]", '{"kind":"launch_missiles"}', '{"kind":"revise"}']) {
      const result = parseClientMessage(raw);
      assert.equal(result.ok, false, raw);
      assert.ok(!result.ok && result.problem.length > 0);
    }
  });

  // An empty revision is a click on the wrong button, not feedback. Accepting it
  // would replan against nothing and present the same plan again.
  test("refuses revise with empty feedback", () => {
    assert.equal(parseClientMessage('{"kind":"revise","feedback":""}').ok, false);
  });

  test("accepts the serve-mode messages and refuses the empty shapes", () => {
    assert.equal(parseClientMessage('{"kind":"watch","missionId":"m1"}').ok, true);
    assert.equal(parseClientMessage('{"kind":"compose","goal":"reconcile invoices"}').ok, true);
    assert.equal(parseClientMessage('{"kind":"forget","missionId":"m1"}').ok, true);
    // A whitespace goal is a click on an empty box, and a compose message may not
    // smuggle an unattended flag — sign-off skipping stays a typed CLI decision.
    assert.equal(parseClientMessage('{"kind":"compose","goal":"  "}').ok, false);
    assert.equal(parseClientMessage('{"kind":"compose","goal":"x","budgetMinutes":-5}').ok, false);
    const composed = parseClientMessage('{"kind":"compose","goal":"x","unattended":true}');
    assert.ok(composed.ok && !("unattended" in composed.message));
    // Plan-only is a real field and defaults to off, so a compose from an older tab
    // dispatches work exactly as it always did (U6).
    const planned = parseClientMessage('{"kind":"compose","goal":"x","planOnly":true}');
    assert.ok(planned.ok && "planOnly" in planned.message && planned.message.planOnly);
    const bare = parseClientMessage('{"kind":"compose","goal":"x"}');
    assert.ok(bare.ok && "planOnly" in bare.message && bare.message.planOnly === false);
  });

  // The three U6 messages. Each names a mission, and none names a directory: where a
  // resumed mission runs is the server's to work out from the mission's own envelope.
  test("accepts resume, save and promote, and refuses the nameless shapes", () => {
    assert.equal(parseClientMessage('{"kind":"resume","missionId":"m1"}').ok, true);
    assert.equal(parseClientMessage('{"kind":"save","missionId":"m1","name":"monthly"}').ok, true);
    assert.equal(
      parseClientMessage('{"kind":"promote","missionId":"m1","taskId":"t1","name":"reconciler"}').ok,
      true,
    );
    assert.equal(parseClientMessage('{"kind":"resume"}').ok, false);
    assert.equal(parseClientMessage('{"kind":"save","missionId":"m1","name":"  "}').ok, false);
    assert.equal(parseClientMessage('{"kind":"promote","missionId":"m1","name":"x"}').ok, false);
    const resumed = parseClientMessage('{"kind":"resume","missionId":"m1","path":"/etc"}');
    assert.ok(resumed.ok && !("path" in resumed.message));
  });

  test("accepts pause and unpause, scoped or not", () => {
    assert.equal(parseClientMessage('{"kind":"pause"}').ok, true);
    assert.equal(parseClientMessage('{"kind":"unpause","missionId":"m1"}').ok, true);
  });

  test("accepts an answer and refuses an empty one", () => {
    assert.equal(parseClientMessage('{"kind":"answer","questionId":"q1","answer":"staging"}').ok, true);
    // An empty answer is the same wrong-button click as an empty revision.
    assert.equal(parseClientMessage('{"kind":"answer","questionId":"q1","answer":""}').ok, false);
    assert.equal(parseClientMessage('{"kind":"answer","answer":"staging"}').ok, false);
  });

  // A mid-run permission answer (§12). `approved` is a boolean and not a string,
  // because "false" is truthy and this is the message that grants a live agent a
  // capability nobody planned for it.
  test("accepts a permission resolution and refuses a malformed one", () => {
    assert.equal(parseClientMessage('{"kind":"resolve","requestId":"perm-t1-1","approved":true}').ok, true);
    assert.equal(
      parseClientMessage('{"kind":"resolve","requestId":"perm-t1-1","approved":false,"missionId":"m1"}').ok,
      true,
    );
    assert.equal(parseClientMessage('{"kind":"resolve","requestId":"perm-t1-1","approved":"true"}').ok, false);
    assert.equal(parseClientMessage('{"kind":"resolve","requestId":"","approved":true}').ok, false);
    assert.equal(parseClientMessage('{"kind":"resolve","approved":true}').ok, false);
  });
});

describe("the web human", () => {
  test("a decision with nothing pending is dropped, not queued", () => {
    const human = createWebHuman();

    assert.equal(human.deliver({ kind: "approve" }), false);
    assert.equal(human.pending(), undefined);
  });

  test("resolves the waiting sign-off and nothing else", async () => {
    const human = createWebHuman();
    const pending = human.awaitSignoff({} as never);

    assert.equal(human.pending(), "signoff");
    assert.equal(human.deliver({ kind: "revise", feedback: "split t1" }), true);
    assert.deepEqual(await pending, { kind: "revise", feedback: "split t1" });

    // Cleared, so a second click cannot answer a question nobody has asked yet.
    assert.equal(human.deliver({ kind: "approve" }), false);
  });

  test("intake answers reach the awaiting call", async () => {
    const human = createWebHuman();
    const pending = human.askIntake([]);

    human.deliver({ kind: "intake", answers: [{ questionId: "q1", answer: "npm test" }] });
    assert.deepEqual(await pending, [{ questionId: "q1", answer: "npm test" }]);
  });

  // A stale tab clicking approve before a restart must not approve whatever the
  // mission happens to be asking after it.
  test("an approval sent while intake is pending does not answer intake", () => {
    const human = createWebHuman();
    void human.askIntake([]);

    assert.equal(human.deliver({ kind: "approve" }), false);
    assert.equal(human.pending(), "intake");
  });

  // Permissions are keyed by request id where sign-off and intake are not, because two
  // workers can be waiting at once — a click on one card must not answer the other.
  test("a permission resolution reaches the request it names", async () => {
    const human = createWebHuman();
    const first = human.askPermission!({ requestId: "perm-t1-1", taskId: "t1", tool: "Write", detail: "a" });
    const second = human.askPermission!({ requestId: "perm-t2-1", taskId: "t2", tool: "Bash", detail: "b" });

    assert.equal(human.deliver({ kind: "resolve", requestId: "perm-t2-1", approved: false }), true);
    assert.equal(await second, false);

    assert.equal(human.deliver({ kind: "resolve", requestId: "perm-t1-1", approved: true }), true);
    assert.equal(await first, true);
  });

  test("a resolution for a request nobody is waiting on is dropped, not queued", () => {
    const human = createWebHuman();

    assert.equal(human.deliver({ kind: "resolve", requestId: "perm-t9-1", approved: true }), false);
  });

  test("a second resolution for the same request is dropped", async () => {
    const human = createWebHuman();
    const pending = human.askPermission!({ requestId: "perm-t1-1", taskId: "t1", tool: "Write", detail: "a" });

    assert.equal(human.deliver({ kind: "resolve", requestId: "perm-t1-1", approved: true }), true);
    assert.equal(await pending, true);
    assert.equal(human.deliver({ kind: "resolve", requestId: "perm-t1-1", approved: false }), false);
  });
});

describe("the server", () => {
  const running: RunningServer[] = [];
  after(async () => {
    for (const server of running) await server.close();
  });

  type Handled = { ok: true; note?: string } | { ok: false; problem: string };

  async function serve(events: Event[], onMessage: () => Handled = () => ({ ok: true })) {
    const server = await startWebServer({ events: () => events, onMessage });
    running.push(server);
    return server;
  }

  interface Client {
    socket: WebSocket;
    /** Frames are buffered from construction, not from the first `next()`.
     *
     *  The server replays the log the moment it accepts the connection, so a listener
     *  attached after `open` resolves is attached a microtask too late and the replay
     *  is simply gone — a test that then waits forever for a frame that already
     *  arrived. Which is a fair warning about the page itself: its `onmessage` is
     *  assigned before `connect()` returns, for exactly this reason. */
    next(): Promise<Record<string, unknown>>;
    close(): void;
  }

  const open = (url: string): Promise<Client> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url.replace("http://", "ws://"));
      const buffered: Record<string, unknown>[] = [];
      const waiting: ((frame: Record<string, unknown>) => void)[] = [];

      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        const next = waiting.shift();
        if (next) next(frame);
        else buffered.push(frame);
      });

      socket.once("error", reject);
      socket.once("open", () =>
        resolve({
          socket,
          next: () =>
            new Promise((settle) => {
              const ready = buffered.shift();
              if (ready) settle(ready);
              else waiting.push(settle);
            }),
          close: () => socket.close(),
        }),
      );
    });

  // The pure check above says what the rule is; this says the socket actually applies
  // it. A browser cannot forge `Origin`, so refusing the handshake is what turns
  // "bound to loopback" into "only this page may approve things".
  test("refuses a handshake from a page on another origin", async () => {
    const warnings: string[] = [];
    const server = await startWebServer({
      events: () => someEvents(1),
      onMessage: () => ({ ok: true }),
      onWarn: (message) => warnings.push(message),
    });
    running.push(server);

    const refused = await new Promise<string>((resolve) => {
      const socket = new WebSocket(server.url.replace("http://", "ws://"), {
        origin: "https://evil.example",
      });
      socket.once("error", (error) => resolve(error.message));
      socket.once("open", () => resolve("connected"));
    });

    assert.notEqual(refused, "connected");
    assert.ok(
      warnings.some((message) => message.includes("evil.example")),
      "the refusal is reported, not silent",
    );
  });

  test("accepts the page it served, which sends its own origin", async () => {
    const server = await serve(someEvents(1));

    const connected = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(server.url.replace("http://", "ws://"), {
        origin: server.url,
      });
      socket.once("error", () => resolve(false));
      socket.once("open", () => {
        socket.close();
        resolve(true);
      });
    });

    assert.equal(connected, true);
  });

  // The page is a bundle now, so "the server serves a page" is two routes and the
  // second one can be missing in a way the first never could.
  test("serves the bundle the shell asks for", async () => {
    const server = await serve(someEvents(1));
    const response = await fetch(`${server.url}${BUNDLE_ROUTE}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    // Built by `npm run build` before the suite runs in CI, and by hand otherwise.
    // If this is empty the bundle step did not happen, which is the thing to know.
    assert.ok(body.length > 0);
  });

  test("binds loopback and nothing else — this socket can approve things (§17)", async () => {
    const server = await serve(someEvents(1));

    assert.match(server.url, new RegExp(`^http://${HOST}:\\d+$`));
    assert.ok(Number(server.url.split(":").at(-1)) > 0);
  });

  test("serves a page that loads nothing from anywhere", async () => {
    const server = await serve(someEvents(1));
    const response = await fetch(server.url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>Mission Control<\/title>/);
    // No external origin can be reached even if a future edit reaches for one.
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(/<script src=|<link .*href="http/.test(html), false);
  });

  // The display face is the one binary this process serves, and it is served for a
  // reason: the alternative is a font CDN, which is a third party inside a surface
  // where someone approves work. So the route has to exist and the policy has to allow
  // exactly it.
  test("serves the display face itself, and permits no other origin to", async () => {
    const server = await serve(someEvents(1));

    const page = await fetch(server.url);
    assert.match(page.headers.get("content-security-policy") ?? "", /font-src 'self'/);

    const font = await fetch(`${server.url}/display.woff2`);
    assert.equal(font.status, 200, "the page preloads a font this server does not serve");
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.ok((await font.arrayBuffer()).byteLength > 0);
  });

  test("replays the whole log on connect", async () => {
    const server = await serve(someEvents(3));
    const client = await open(server.url);

    const frame = await client.next();
    assert.equal(frame.kind, "events");
    assert.equal((frame.events as Event[]).length, 3);
    client.close();
  });

  // A reconnecting tab must draw the same screen as a first connect, or a mission
  // that dropped a socket mid-round renders one that skipped it.
  test("a second connection replays from the start rather than resuming a cursor", async () => {
    const events = someEvents(2);
    const server = await serve(events);

    const first = await open(server.url);
    await first.next();
    first.close();

    const second = await open(server.url);
    const frame = await second.next();
    assert.equal((frame.events as Event[]).length, 2);
    second.close();
  });

  test("publish pushes only what a client has not seen", async () => {
    const events = someEvents(2);
    const server = await serve(events);
    const client = await open(server.url);

    assert.equal(((await client.next()) as unknown as { events: Event[] }).events.length, 2);

    events.push(...stamp([missionCreated()]).map((event) => ({ ...event, seq: 3 })));
    server.publish();

    const frame = (await client.next()) as unknown as { events: Event[] };
    assert.equal(frame.events.length, 1);
    assert.equal(frame.events[0]?.seq, 3);
    client.close();
  });

  test("tells the page when a frame was rejected instead of failing silently", async () => {
    const server = await serve(someEvents(1));
    const client = await open(server.url);
    await client.next();

    client.socket.send("{ not json");
    const frame = await client.next();

    assert.equal(frame.kind, "rejected");
    assert.match(String(frame.problem), /not JSON/);
    client.close();
  });

  // A save and a promote write a file and no event, so without this frame a click
  // that worked and a click that vanished are the same picture (U6).
  test("acknowledges a decision whose only effect is a file on disk", async () => {
    const server = await serve(someEvents(1), () => ({ ok: true as const, note: "Saved 'monthly'." }));
    const client = await open(server.url);
    await client.next();

    client.socket.send('{"kind":"approve"}');
    const frame = await client.next();

    assert.equal(frame.kind, "noted");
    assert.match(String(frame.note), /Saved 'monthly'/);
    client.close();
  });

  // …and stays quiet otherwise: most decisions announce themselves by the events they
  // cause, and a second way of saying the same thing is a second thing to keep true.
  test("says nothing back for a decision the log already reports", async () => {
    const events = someEvents(1);
    const server = await serve(events);
    const client = await open(server.url);
    await client.next();

    client.socket.send('{"kind":"approve"}');
    events.push(...someEvents(2).slice(1));
    server.publish();
    const frame = await client.next();

    assert.equal(frame.kind, "events", "an unremarkable decision sent a frame of its own");
    client.close();
  });

  test("says so when a decision has nothing to answer", async () => {
    const server = await serve(someEvents(1), () => ({
      ok: false as const,
      problem: "nothing is waiting on that right now.",
    }));
    const client = await open(server.url);
    await client.next();

    client.socket.send('{"kind":"approve"}');
    const frame = await client.next();

    assert.equal(frame.kind, "rejected");
    assert.match(String(frame.problem), /nothing is waiting/);
    client.close();
  });

  test("a POST is refused — this surface takes decisions over the socket only", async () => {
    const server = await serve(someEvents(1));
    const response = await fetch(server.url, { method: "POST" });

    assert.equal(response.status, 405);
  });

  // ── serve mode: the registry replaces the single feed, and a client watches ──

  function fakeRegistry(logs: Record<string, Event[]>) {
    return {
      missions: () =>
        Object.entries(logs).map(([id, events]) => ({
          id,
          goal: `goal of ${id}`,
          status: "executing" as const,
          updatedAt: events[events.length - 1]?.at ?? "",
        })),
      eventsFor: (missionId: string) => logs[missionId] ?? [],
    };
  }

  async function serveRegistry(logs: Record<string, Event[]>, onMessage: () => Handled = () => ({ ok: true })) {
    const server = await startWebServer({ registry: fakeRegistry(logs), onMessage });
    running.push(server);
    return server;
  }

  test("a registry server opens with the listing and streams nothing unasked", async () => {
    const server = await serveRegistry({ m1: someEvents(2) });
    const client = await open(server.url);

    const frame = await client.next();
    assert.equal(frame.kind, "missions");
    assert.equal((frame.missions as unknown[]).length, 1);

    // Watching is what starts the stream; the whole log replays from seq 0.
    client.socket.send('{"kind":"watch","missionId":"m1"}');
    const events = await client.next();
    assert.equal(events.kind, "events");
    assert.equal((events.events as Event[]).length, 2);
    client.close();
  });

  test("watching a mission that does not exist is rejected, not a dead stream", async () => {
    const server = await serveRegistry({ m1: someEvents(1) });
    const client = await open(server.url);
    await client.next();

    client.socket.send('{"kind":"watch","missionId":"ghost"}');
    const frame = await client.next();

    assert.equal(frame.kind, "rejected");
    assert.match(String(frame.problem), /no mission 'ghost'/);
    client.close();
  });

  test("a per-run server refuses watch — it has one mission and no registry", async () => {
    const server = await serve(someEvents(1));
    const client = await open(server.url);
    await client.next();

    client.socket.send('{"kind":"watch","missionId":"m1"}');
    const frame = await client.next();

    assert.equal(frame.kind, "rejected");
    client.close();
  });

  test("a server with neither feed is a bug, loudly", async () => {
    await assert.rejects(
      () => startWebServer({ onMessage: () => ({ ok: true }) }),
      /events feed or a registry/,
    );
  });
});

// The failure mode: a browser naming a harness or a model that this machine never
// offered, and the server taking its word for it.
//
// These two strings are not like the rest of the compose message. `harness` decides
// which binary gets spawned and the model fields become `--model` arguments and SDK
// options, so free text from a page reaches a subprocess — which is the exact thing the
// `workspaceId`-not-a-path rule exists to prevent one field over. The answer is the same
// one `workspace_add` uses: you cannot choose what you have not been shown, and the
// server checks the choice against the frame it computed itself.
describe("isOfferedRuntime", () => {
  const health = {
    harnesses: [
      { id: "cli/claude", models: ["opus", "sonnet", "haiku"], honoursModel: true },
      { id: "acp/claude", models: ["opus", "sonnet", "haiku"], honoursModel: false },
    ],
    orchestratorModels: ["opus", "sonnet", "haiku"],
  };

  test("choosing nothing is always allowed", () => {
    assert.deepEqual(isOfferedRuntime(health, {}), { ok: true });
  });

  test("accepts a harness and a model that were offered", () => {
    assert.equal(isOfferedRuntime(health, { harness: "acp/claude" }).ok, true);
    assert.equal(isOfferedRuntime(health, { workerModel: "haiku" }).ok, true);
    assert.equal(isOfferedRuntime(health, { orchestratorModel: "sonnet" }).ok, true);
  });

  test("refuses a harness this machine does not have, and names what it does", () => {
    const result = isOfferedRuntime(health, { harness: "cli/codex" });

    assert.equal(result.ok, false);
    // §2a rule 5: the refusal names the fix.
    assert.match(result.ok === false ? result.problem : "", /cli\/claude/);
  });

  test("refuses a model nobody offered", () => {
    assert.equal(isOfferedRuntime(health, { workerModel: "gpt-9-turbo" }).ok, false);
    assert.equal(isOfferedRuntime(health, { orchestratorModel: "gpt-9-turbo" }).ok, false);
  });

  test("refuses a model the chosen harness cannot run", () => {
    const codexOnly = {
      harnesses: [{ id: "cli/codex", models: ["gpt-x"], honoursModel: true }],
      orchestratorModels: ["opus"],
    };

    assert.equal(isOfferedRuntime(codexOnly, { harness: "cli/codex", workerModel: "opus" }).ok, false);
  });

  // Empty is "unknown", not "none". No codex model list has been verified, so a model
  // named against that harness is not refused — refusing every one of them to enforce
  // the Anthropic half would fail correct work.
  test("a harness with no known model list constrains nothing", () => {
    const unknown = {
      harnesses: [{ id: "cli/codex", models: [], honoursModel: true }],
      orchestratorModels: ["opus"],
    };

    assert.equal(isOfferedRuntime(unknown, { harness: "cli/codex", workerModel: "anything" }).ok, true);
  });

  test("a machine with no agent at all says so rather than listing nothing", () => {
    const bare = { harnesses: [], orchestratorModels: ["opus"] };
    const result = isOfferedRuntime(bare, { harness: "cli/claude" });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.problem : "", /no agent CLI is installed/);
  });
});

// The same rule for the card menu (PLAN-NEXT 4.3), and the stronger case for it: a card
// id decides which provider this process posts a prompt and an API key to. Unlike the
// model menus, empty is never permissive here — a card exists only because
// `orchestra doctor` reached it, so "no cards" means nothing can legitimately be staffed.
describe("isOfferedStaffing", () => {
  const health = {
    modelCards: [
      { id: "deepseek-ai/DeepSeek-V3", tier: "worker", provider: "nebius" },
      { id: "Qwen/Qwen3-4B-fast", tier: "fast", provider: "nebius" },
    ],
  };

  test("staffing nothing is always allowed", () => {
    assert.deepEqual(isOfferedStaffing(health, {}), { ok: true });
  });

  test("accepts cards the server itself sent", () => {
    assert.equal(
      isOfferedStaffing(health, { plan: "deepseek-ai/DeepSeek-V3", progress: "Qwen/Qwen3-4B-fast" }).ok,
      true,
    );
  });

  test("refuses a card that was never offered, and names the ones that were", () => {
    const result = isOfferedStaffing(health, { plan: "gpt-9-turbo" });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.problem : "", /deepseek-ai\/DeepSeek-V3/);
  });

  test("with no cards probed, nothing may be staffed at all", () => {
    const result = isOfferedStaffing({ modelCards: [] }, { plan: "deepseek-ai/DeepSeek-V3" });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.problem : "", /probed no provider/);
  });
});

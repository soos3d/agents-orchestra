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
import { type Event, type EventInput } from "../events/schema.js";
import { parseClientMessage } from "./protocol.js";
import { eventsSince, HOST, startWebServer, type RunningServer } from "./server.js";
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
});

describe("the server", () => {
  const running: RunningServer[] = [];
  after(async () => {
    for (const server of running) await server.close();
  });

  type Handled = { ok: true } | { ok: false; problem: string };

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

  test("binds loopback and nothing else — this socket can approve things (§17)", async () => {
    const server = await serve(someEvents(1));

    assert.match(server.url, new RegExp(`^http://${HOST}:\\d+$`));
    assert.ok(server.port > 0);
  });

  test("serves a page that loads nothing from anywhere", async () => {
    const server = await serve(someEvents(1));
    const response = await fetch(server.url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<title>fable-orchestra<\/title>/);
    // No external origin can be reached even if a future edit reaches for one.
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(/<script src=|<link .*href="http/.test(html), false);
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
});

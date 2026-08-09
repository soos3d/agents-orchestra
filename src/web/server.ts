// The dashboard, served by the orchestrator process itself (§2a).
//
// One process, one port, no second terminal and no dev server: the constraint that
// disqualifies designs rather than being tidied up later. That is why the page is a
// string in this package instead of a bundle, and why the only runtime dependency
// here is `ws`.
//
// Bound to loopback, always, and not as a default a flag can move. This socket can
// approve things; §17 spends a whole row on what it means when the surface that
// approves a payment is reachable from somewhere else, and the answer that survived
// review was to make it unreachable rather than to authenticate it.
//
// The server is deliberately thin. Everything it decides — which events a client has
// not seen, what a frame means, what the page says — lives in a pure function next
// door, because this file is below the fixture harness in the same way `agentCalls.ts`
// is, and that is where six defects hid behind a green suite.
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { type Event } from "../events/schema.js";
import { shellHtml } from "./shell.html.js";
import { parseClientMessage, type ClientMessage } from "./protocol.js";

/** Never configurable. See the header. */
export const HOST = "127.0.0.1";

export interface WebServerDeps {
  /** Reads the log. Injected rather than reading the file here, so the server has no
   *  opinion about where a mission lives and tests need no disk. */
  events(): readonly Event[];
  onMessage(message: ClientMessage): { ok: true } | { ok: false; problem: string };
  /** 0 asks the OS for a free one, which is what keeps two missions from colliding. */
  port?: number;
  onWarn?(message: string): void;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  /** Pushes whatever is new since each client last heard. Called after every emit. */
  publish(): void;
  close(): Promise<void>;
}

/** What a client has not seen yet. Pure, and the only thing between "replay on
 *  connect" and "live tail" being two code paths that can disagree. */
export function eventsSince(events: readonly Event[], seq: number): Event[] {
  return events.filter((event) => event.seq > seq);
}

export async function startWebServer(deps: WebServerDeps): Promise<RunningServer> {
  const warn = deps.onWarn ?? (() => {});
  const html = shellHtml();

  const server = http.createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end("Only GET is served here.");
      return;
    }

    const path = (request.url ?? "/").split("?")[0];
    if (path !== "/") {
      response.writeHead(404, { "content-type": "text/plain" }).end("No such page.");
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The page loads nothing from anywhere. Stated in a header as well as being
      // true, so a future edit that reaches for a CDN fails in the browser rather
      // than quietly putting a third party inside the approval surface.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    response.end(html);
  });

  const sockets = new Map<WebSocket, { seq: number }>();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    // Replay on connect, then live tail — the same call, which is what stops a
    // reconnecting tab from rendering a mission that skipped a round.
    sockets.set(socket, { seq: 0 });
    pushTo(socket);

    socket.on("message", (raw) => {
      const parsed = parseClientMessage(raw.toString());
      if (!parsed.ok) {
        warn(`Ignored a message from the dashboard: ${parsed.problem}`);
        socket.send(JSON.stringify({ kind: "rejected", problem: parsed.problem }));
        return;
      }

      const handled = deps.onMessage(parsed.message);
      if (!handled.ok) {
        socket.send(JSON.stringify({ kind: "rejected", problem: handled.problem }));
      }
    });

    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  function pushTo(socket: WebSocket): void {
    const cursor = sockets.get(socket);
    if (!cursor || socket.readyState !== socket.OPEN) return;

    const fresh = eventsSince(deps.events(), cursor.seq);
    if (fresh.length === 0) return;

    socket.send(JSON.stringify({ kind: "events", events: fresh }));
    cursor.seq = fresh[fresh.length - 1]!.seq;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, HOST, resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://${HOST}:${port}`,
    port,
    publish: () => {
      for (const socket of sockets.keys()) pushTo(socket);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.keys()) socket.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

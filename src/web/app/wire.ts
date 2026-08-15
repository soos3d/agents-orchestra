// The page's socket, and everything that *sends*.
//
// Kept in its own module for the reason `web/page/wire.ts` was: the containment
// stated in `state.ts` is that no decision derives from the page's own fold, and one
// short file holding every outbound message is what makes that reviewable. A `send`
// here carries what a human typed or clicked, never a value computed from the view —
// the one exception is an id read off the clicked element, which names *what* was
// clicked and not what to do about it.
//
// `ClientMessage` is imported as a type, so the schema it comes from is erased at
// bundle time. The browser sends decisions; zod validates them on the far side.
import { type Event } from "../../events/schema.js";
import { type ClientMessage, type HealthFrame, type WorkspacesFrame } from "../protocol.js";
import { type MissionSummary } from "./state.js";

/** What the server can say. It sends events and listings, never rendered state —
 *  the asymmetry `protocol.ts` explains at length. */
export type ServerFrame =
  | { kind: "events"; events: Event[] }
  | { kind: "missions"; missions: MissionSummary[] }
  | ({ kind: "workspaces" } & WorkspacesFrame)
  | ({ kind: "health" } & HealthFrame)
  | { kind: "rejected"; problem: string }
  /** A decision whose only effect is a file on disk — saving a mission, promoting an
   *  agent — saying so. It is a sentence, never state: nothing on the page is folded
   *  from it. */
  | { kind: "noted"; note: string };

export interface Wire {
  send(message: ClientMessage): void;
}

export interface WireHandlers {
  onFrame(frame: ServerFrame): void;
  onOpen(): void;
  onClose(): void;
}

/**
 * Opens the socket and returns the sender.
 *
 * `onmessage` is assigned before this returns, and that is load-bearing: the server
 * replays the whole log the moment it accepts the connection, so a listener attached
 * a microtask later is attached too late and the replay is simply gone.
 */
export function connect(handlers: WireHandlers): Wire {
  const url = `${location.origin.replace(/^http/, "ws")}/`;
  const socket = new WebSocket(url);

  socket.onmessage = (message) => {
    try {
      handlers.onFrame(JSON.parse(String(message.data)) as ServerFrame);
    } catch {
      // A frame this build cannot parse is a stale tab against a newer server. Drop
      // it rather than tearing down a stream that is otherwise fine.
    }
  };
  socket.onopen = () => handlers.onOpen();
  socket.onclose = () => handlers.onClose();

  return {
    send: (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
  };
}

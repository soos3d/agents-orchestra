// The dashboard's entry point: mount, connect, fold, render.
//
// This is the file esbuild bundles into `dist/web/app.js`. It replaces the four
// string fragments `shell.html.ts` used to concatenate, and with them the whole class
// of bug the old header warned about — a backtick or a `${` inside a fragment silently
// truncated or interpolated the page, and `shell.test.ts` existed to trip on it.
//
// The reason for a framework here is not the look. `render()` in the old page set
// `screen.innerHTML` on *every* event, which destroyed focus, scroll position and
// input state forty times a minute and made any transition impossible. A real vdom
// fixes that, and 3 kB of Preact is the whole cost.
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type ClientMessage } from "../protocol.js";
import { Home, Screen } from "./screens.js";
import { apply, emptyMission, emptyView, line, type View } from "./state.js";
import { connect, type ServerFrame, type Wire } from "./wire.js";

const TIMELINE_LIMIT = 400;

function App() {
  const [view, setView] = useState<View>(emptyView);
  const [timeline, setTimeline] = useState<readonly string[]>([]);
  const [wire, setWire] = useState<Wire | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const socket = connect({
      onFrame: (frame: ServerFrame) => {
        if (frame.kind === "rejected") {
          setProblem(frame.problem);
          return;
        }
        if (frame.kind === "missions") {
          setView((current) => ({ ...current, missions: frame.missions }));
          return;
        }
        // The workspace listing, U4. `chosen` is this tab's and survives every
        // refresh of the server's half — losing the selection every time a probe
        // comes back is exactly the kind of state the innerHTML page destroyed.
        if (frame.kind === "workspaces") {
          setView((current) => ({
            ...current,
            workspaces: {
              ...current.workspaces,
              list: frame.workspaces,
              probe: frame.pending,
              live: frame.live,
              defaultId: frame.defaultId,
              chosen: current.workspaces.chosen ?? frame.defaultId,
            },
          }));
          return;
        }
        // A replay arrives as one frame from seq 0, so the mission half of the view
        // resets when a stream restarts — applying a replay onto a stale view would
        // double every count. `missions` and `watching` are the server's and survive.
        setView((current) => frame.events.reduce(apply, current));
        setTimeline((current) => [...current, ...frame.events.map(line)].slice(-TIMELINE_LIMIT));
      },
      onOpen: () => setProblem(null),
      onClose: () => setProblem("Disconnected. The orchestrator process has stopped or restarted."),
    });
    setWire(socket);
  }, []);

  const send = (message: ClientMessage): void => {
    setProblem(null);
    // `watch` is the one message that resets the mission view: this tab is about to
    // be streamed a different log from seq 0.
    if (message.kind === "watch") {
      setView((current) => ({ ...current, ...emptyMission(), watching: message.missionId }));
      setTimeline([]);
    }
    wire?.send(message);
  };

  const home = view.missions !== null && !view.watching;

  useEffect(() => {
    document.title = home ? "Mission Control" : view.goal || "orchestra";
  }, [home, view.goal]);

  if (home) {
    return (
      <>
        <h1>Mission Control</h1>
        <div class="bar" />
        {problem ? <div class="card warn">{problem}</div> : null}
        <Home
          view={view}
          send={send}
          onChoose={(workspaceId) =>
            setView((current) => ({
              ...current,
              workspaces: { ...current.workspaces, chosen: workspaceId },
            }))
          }
        />
      </>
    );
  }

  return (
    <>
      <h1>{view.goal || "orchestra"}</h1>
      <div class="bar">
        <span>
          status <strong>{view.status}</strong>
          {view.paused ? " ⏸ paused" : ""}
        </span>
        <span>round {view.round}</span>
        <span>stalls {view.stalls}</span>
        <span>resets {view.resets}</span>
      </div>

      {problem ? <div class="card warn">{problem}</div> : null}

      {view.missions !== null ? (
        <div class="row">
          <button
            onClick={() => {
              setView((current) => ({ ...current, ...emptyMission(), watching: null }));
              setTimeline([]);
            }}
          >
            ← missions
          </button>
        </div>
      ) : null}

      <Screen
        view={view}
        send={send}
        onSelect={(taskId) => setView((current) => ({ ...current, selected: taskId }))}
      />

      <h2>Note — steers the mission, never blocks it</h2>
      <div class="row">
        <input id="note" placeholder="e.g. stop using the staging database" />
        <button
          onClick={() => {
            const box = document.getElementById("note") as HTMLInputElement | null;
            const text = box?.value.trim();
            if (!text) return;
            send({
              kind: "note",
              scope: "global",
              text,
              ...(view.watching ? { missionId: view.watching } : {}),
            });
            box!.value = "";
          }}
        >
          send
        </button>
        <button
          title="drain in-flight work and park — reversible"
          onClick={() =>
            send({
              kind: view.paused ? "unpause" : "pause",
              ...(view.watching ? { missionId: view.watching } : {}),
            })
          }
        >
          {view.paused ? "resume" : "pause"}
        </button>
        <button
          title="stop dispatching now — worktrees are left intact"
          onClick={() => send({ kind: "panic", reason: "panic from the dashboard" })}
        >
          panic
        </button>
      </div>

      <h2>Timeline</h2>
      <div class="log">
        {timeline.map((entry, index) => (
          <div key={index}>{entry}</div>
        ))}
      </div>
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);

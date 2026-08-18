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
import { type PaneKey } from "./hud.js";
import { StatusCore } from "./runView.js";
import { Home, Screen } from "./screens.js";
import { apply, emptyMission, emptyView, line, type View } from "./state.js";
import { connect, type ServerFrame, type Wire } from "./wire.js";

const TIMELINE_LIMIT = 400;

function App() {
  const [view, setView] = useState<View>(emptyView);
  const [timeline, setTimeline] = useState<readonly string[]>([]);
  // Which rail pane is showing. Page state, like the selected task: it sends nothing.
  // The board is the default because it is what a mission is; the contract and the
  // timeline are what a person goes looking for (U7).
  const [pane, setPane] = useState<PaneKey>("board");
  const [wire, setWire] = useState<Wire | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The acknowledgement half of `problem` (U6): a save or a promote changes no event
  // and would otherwise look identical whether it worked or vanished.
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const socket = connect({
      onFrame: (frame: ServerFrame) => {
        if (frame.kind === "rejected") {
          setProblem(frame.problem);
          return;
        }
        if (frame.kind === "noted") {
          setNote(frame.note);
          return;
        }
        // One diff or one file, rendered by the server (PLAN-NEXT 9.3). Lands on the
        // view rather than in a local state hook so the work pane can read it without
        // three components' worth of prop threading — and it is not folded from
        // anything, exactly like `health`.
        if (frame.kind === "shown") {
          setView((current) => ({
            ...current,
            shown: {
              what: frame.what,
              id: frame.id,
              title: frame.title,
              text: frame.text,
              truncated: frame.truncated,
            },
          }));
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
        // What `doctor` found, sent once on connect (U6). Not part of the mission
        // half of the view, so a stream reset leaves it alone.
        if (frame.kind === "health") {
          setView((current) => ({
            ...current,
            // Copied field by field rather than spread, so a field added to the frame
            // is a compile error here instead of arriving silently unrendered.
            health: {
              checks: frame.checks,
              ready: frame.ready,
              transports: frame.transports,
              harnesses: frame.harnesses,
              orchestratorModels: frame.orchestratorModels,
              orchestratorModel: frame.orchestratorModel,
              modelCards: frame.modelCards,
              fixedModels: frame.fixedModels,
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
    setNote(null);
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
        {/* The wordmark, and the page's one large piece of the display face. The
            accent is on the second word because this page is the control and the
            missions are what it is over. */}
        <h1 class="mark">
          Mission <span>Control</span>
        </h1>
        <div class="bar" />
        {problem ? <div class="card warn">{problem}</div> : null}
        {note ? <div class="card">{note}</div> : null}
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

  // The crown: what this mission is, and what it is doing, in one line that is in the
  // same place on every mission screen. The status core is the page's one rotating
  // element and it lives here rather than in a rail, because the briefing, the sign-off
  // screen and the run view all want it and none of them wants a second copy (U7).
  return (
    <>
      <header class="crown">
        {view.missions !== null ? (
          <button
            class="back"
            title="back to the mission list"
            onClick={() => {
              setView((current) => ({ ...current, ...emptyMission(), watching: null }));
              setTimeline([]);
            }}
          >
            ←
          </button>
        ) : null}
        <StatusCore view={view} />
        <h1>{view.goal || "orchestra"}</h1>
      </header>

      {problem ? <div class="card warn">{problem}</div> : null}
      {note ? <div class="card">{note}</div> : null}

      <Screen
        view={view}
        send={send}
        onSelect={(taskId) => setView((current) => ({ ...current, selected: taskId }))}
        pane={pane}
        onPane={setPane}
        timeline={timeline}
      />
    </>
  );
}

const root = document.getElementById("app");
if (root) {
  // The shell paints a "connecting…" heading so the page is not blank while the bundle
  // loads, and Preact does not remove it: the first render diffs against a container it
  // has no previous tree for, and the placeholder is left sitting above the app. It sat
  // there for the whole of every session until U7 went looking at the page. Clearing the
  // container is the fix, and it must happen before the first render, not in an effect.
  root.replaceChildren();
  render(<App />, root);
}

// The run view: three rails, and the instrument panel that fills them (UI plan U7).
//
// Everything here used to be one column that grew. A running mission drew a ledger
// strip, the criteria, a five-column board, the why panel, the inbox, a note box, three
// buttons and four hundred lines of timeline, in that order, all at once — so the two
// things that actually matter at hour four, the board and the thing waiting on a human,
// were somewhere in the middle of a page nobody could take in. The rails are the fix and
// the rule behind them is one sentence: **the run view shows the board and the inbox,
// and everything else is one click away.**
//
// Three things about this file are decisions rather than layout:
//
//  - **The pane is page state, like the selected task.** Which of board / contract /
//    timeline is showing sends nothing and decides nothing, and `panes()` is what the
//    rail draws from — so "what is one click away" is asserted in `hud.test.ts` rather
//    than read off a screenshot.
//  - **A live timer re-renders itself and nothing else.** `Ticker` owns its own clock,
//    so a card with a running task repaints one text node per second instead of the
//    card — and the card keeps its hover, its focus ring and the panel's scroll offset.
//    That is the whole reason the innerHTML page could never have a clock.
//  - **Glow is state.** The ring turns only while the loop is working, the scan crosses
//    only a running task, and a panel assembles only when it is created. Peripheral
//    movement here means something changed; if it stops meaning that, it has to go.
import { useEffect, useState } from "preact/hooks";
import { type ClientMessage } from "../protocol.js";
import { Contract } from "./contract.js";
import { core, elapsed, panes, vitals, type PaneKey } from "./hud.js";
import { taskOrrery } from "./orrery.js";
import { TaskBrief, TaskDossier } from "./taskPanel.js";
import { OrreryFigure } from "./orreryFigure.js";
import { type BoardTask, type View } from "./state.js";

type Send = (message: ClientMessage) => void;

interface RunProps {
  view: View;
  send: Send;
  onSelect(taskId: string | null): void;
  pane: PaneKey;
  onPane(pane: PaneKey): void;
  timeline: readonly string[];
}

/** One second, shared by every clock on the page. Anything finer would repaint for a
 *  digit nobody reads; anything coarser makes a just-dispatched task look stuck. */
const TICK_MS = 1000;

/** The current time, as state, so a component that shows a duration re-renders itself
 *  and leaves its parent alone. */
function useNow(): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return now;
}

/** A duration that counts up. The smallest component in the app on purpose: it is the
 *  only thing that repaints between events, and what it repaints is one text node. */
function Ticker({ since }: { since: string }) {
  const now = useNow();
  return <>{elapsed(now - Date.parse(since))}</>;
}

/**
 * The status core (UI plan U7): the one element on the page that rotates, and the
 * answer to "what is this mission doing" from across a desk.
 *
 * It rides in the crown beside the goal rather than in a rail, because it is the one
 * thing that is true on every mission screen — the briefing, the sign-off and the run
 * view all want it and none of them wants two of it.
 */
export function StatusCore({ view }: { view: View }) {
  const state = core(view);

  return (
    <div class={`core core-${state.tone}${state.spin ? " core-spin" : ""}`}>
      <span class="core-ring" aria-hidden="true" />
      <span class="core-text">
        <strong>{state.label}</strong>
        {state.detail ? <span class="core-detail">{state.detail}</span> : null}
      </span>
    </div>
  );
}

/** The counters, and the elapsed clock that is the only one of them not driven by an
 *  event. `vitals()` decides which rows exist; this draws them. */
function Vitals({ view }: { view: View }) {
  const now = useNow();
  const rows = vitals(view, now);
  if (rows.length === 0) return null;

  return (
    <dl class="vitals">
      {rows.map((vital) => (
        <div class="vital" key={vital.label}>
          <dt>{vital.label}</dt>
          <dd class={vital.tone ? `tone-${vital.tone}` : undefined}>{vital.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The §13 ledger strip, as a rail panel: the counts that make a long run legible.
 *  Rendered only once a ledger exists. */
function Strip({ view }: { view: View }) {
  const ledger = view.ledger;
  if (!ledger) return null;
  const facts = ledger.factsGiven.length + ledger.factsVerified.length;

  return (
    <div class="strip">
      <span>✓ {facts} facts</span>
      <span>? {ledger.factsToLookUp.length} to look up</span>
      <span>⚠ {ledger.deadEnds.length} dead ends</span>
    </div>
  );
}

/** Which pane the centre rail shows. It moves a highlight and sends nothing — the
 *  same contract the task selection has. */
function PaneTabs({ view, pane, onPane }: { view: View; pane: PaneKey; onPane(pane: PaneKey): void }) {
  return (
    <nav class="tabs">
      {panes(view).map((choice) => (
        <button
          key={choice.key}
          class={`tab${choice.key === pane ? " tab-on" : ""}`}
          aria-current={choice.key === pane ? "true" : undefined}
          onClick={() => onPane(choice.key)}
        >
          {choice.label}
          {choice.badge ? <span class="tab-badge">{choice.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/**
 * The three controls that steer a mission without answering anything: a note, the
 * pause, and panic.
 *
 * In the rail rather than under the board because of what they are — always available,
 * never the next thing to do. Panic is not styled as an alarm for the same reason it
 * is not a primary button: a control that looks urgent gets pressed when nothing is
 * urgent.
 */
export function Controls({ view, send }: { view: View; send: Send }) {
  return (
    <div class="controls">
      <h3>Steer</h3>
      <input id="note" placeholder="e.g. stop using the staging database" />
      <div class="row">
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
          note
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
          {view.paused ? "unpause" : "pause"}
        </button>
        <button
          title="stop dispatching now — worktrees are left intact"
          onClick={() => send({ kind: "panic", reason: "panic from the dashboard" })}
        >
          panic
        </button>
      </div>
    </div>
  );
}

const COLUMNS: readonly [string, readonly string[]][] = [
  ["todo", ["waiting", "todo"]],
  ["running", ["running"]],
  ["verifying", ["verifying", "review"]],
  ["blocked", ["blocked"]],
  ["done", ["done", "failed", "conflicted", "cancelled"]],
];

const OUTCOME_MARK: Record<string, string> = {
  done: "✓",
  failed: "✗",
  conflicted: "⚠",
  cancelled: "⊘",
};

const MARK_CLASS: Record<string, string> = {
  done: "ok",
  failed: "bad",
  conflicted: "bad",
  cancelled: "quiet",
};

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: BoardTask;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  // The status is a class as well as a mark, because the stylesheet is where "a
  // running task is the only thing on the board that moves" is enforced.
  return (
    <div
      class={`task task-${task.status}${selected ? " task-on" : ""}`}
      tabIndex={0}
      onClick={() => onSelect(task.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(task.id);
        }
      }}
    >
      <span class="id">{task.id}</span>{" "}
      {OUTCOME_MARK[task.status] ? (
        <span class={MARK_CLASS[task.status]}>{OUTCOME_MARK[task.status]}</span>
      ) : null}
      {/* Who is on it, before what it is. A synthesized goal opens with the worktree
          path and the file list, so the first eighty characters of one card look like
          the first eighty of every other — the role is the line that tells them apart. */}
      {/* Optional, though the schema makes it required: this is the page's own fold,
          and the rule there is that a projection shows what it has and never throws.
          A card that crashes takes the whole board with it. */}
      {task.agentSpec ? <div class="task-role">{task.agentSpec.role}</div> : null}
      {/* Clamped in CSS rather than sliced, so the card shows whole words and the whole
          string is still there to select. */}
      <div class="task-goal">{task.goal}</div>
      <div class="meta">
        {task.worker}
        {/* The clock is its own component, so a second passing repaints these three
            characters and not the card around them. */}
        {task.status === "running" && task.startedAt ? (
          <>
            {" · "}
            <Ticker since={task.startedAt} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The board, under load.
 *
 * Every column scrolls on its own rather than growing the page, which is what keeps a
 * forty-task mission readable: the running column stays where the eye left it while
 * "done" fills up beneath a header that stays put. An empty column is still drawn — a
 * board that reflows as tasks move is a board you have to re-read every round.
 */
function Board({ view, onSelect }: { view: View; onSelect: (id: string) => void }) {
  const tasks = [...view.tasks.values()];
  if (tasks.length === 0) {
    return <p class="quiet">No tasks yet. The plan lands here the moment it is approved.</p>;
  }

  return (
    <div class="board">
      {COLUMNS.map(([title, statuses]) => {
        const cards = tasks.filter((task) => statuses.includes(task.status));
        return (
          <div class="col" key={title}>
            <h3>
              {title} <span class="count">{cards.length}</span>
            </h3>
            <div class="col-cards">
              {cards.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={task.id === view.selected}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Inbox({ view, send }: { view: View; send: Send }) {
  const items = [...view.inbox.entries()].filter(([, item]) => item.kind !== "intake");
  if (items.length === 0) return null;

  return (
    <>
      <h2>Inbox</h2>
      {items.map(([key, item]) => (
        <div class="card warn" key={key}>
          <strong>{item.kind}</strong> · {item.text}

          {item.kind === "question" && item.id ? (
            <div class="row">
              <input class="reply" data-qid={item.id} placeholder="answer…" />
              <button
                onClick={() => {
                  const box = document.querySelector<HTMLInputElement>(`input.reply[data-qid="${item.id}"]`);
                  const answer = box?.value.trim();
                  if (!answer || !item.id) return;
                  send({
                    kind: "answer",
                    questionId: item.id,
                    answer,
                    ...(view.watching ? { missionId: view.watching } : {}),
                  });
                }}
              >
                answer
              </button>
            </div>
          ) : null}

          {/* Two buttons and no text box: a permission is a yes or a no, and a worker
              is waiting on it (§12). Neither is the primary button — nothing here is
              the one you tap through without reading (§11). */}
          {item.kind === "permission" && item.id ? (
            <div class="row">
              <button onClick={() => resolve(send, view, item.id, true)}>allow</button>
              <button onClick={() => resolve(send, view, item.id, false)}>deny</button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** The watched mission's id rides along for the same reason an answer's does: a serve
 *  dashboard may be looking at a mission other than the one this tab started. */
function resolve(send: Send, view: View, requestId: string | undefined, approved: boolean): void {
  if (!requestId) return;
  send({
    kind: "resolve",
    requestId,
    approved,
    ...(view.watching ? { missionId: view.watching } : {}),
  });
}

/** The timeline, which is a pane rather than the foot of the page now. It is the one
 *  place the raw log is legible, and it is also four hundred lines of it — which is
 *  why it is behind a click and the board is not. */
function Timeline({ timeline }: { timeline: readonly string[] }) {
  if (timeline.length === 0) return <p class="quiet">Nothing has happened yet.</p>;

  return (
    <div class="log">
      {timeline.map((entry, index) => (
        <div key={index}>{entry}</div>
      ))}
    </div>
  );
}

/**
 * Three rails: what the mission is, what it is doing, and what it wants from you.
 *
 * The right rail is the one that earns the layout. An inbox at the foot of a growing
 * page is an inbox a person scrolls past; beside the board it is the only panel on the
 * page painted amber, and it is in the same place every time.
 */
export function RunView({ view, send, onSelect, pane, onPane, timeline }: RunProps) {
  // The dossier pane exists only while a task is selected, so closing one from the
  // dossier itself would otherwise leave the centre rail showing nothing at all. The
  // board is where a task is picked, so the board is where it falls back to.
  const shown: PaneKey =
    pane === "task" && !(view.selected && view.tasks.has(view.selected)) ? "board" : pane;

  return (
    <div class="hud">
      <aside class="rail rail-left">
        <Vitals view={view} />
        <Strip view={view} />
        <PaneTabs view={view} pane={pane} onPane={onPane} />
        <Controls view={view} send={send} />
      </aside>

      <section class="rail rail-main">
        {shown === "board" ? <Board view={view} onSelect={onSelect} /> : null}
        {/* One task, at the width of the board — which is what a two-thousand character
            goal and a system prompt need, and what a 20rem rail could never give them. */}
        {shown === "task" ? (
          <div class="column">
            <TaskDossier view={view} send={send} onSelect={onSelect} />
          </div>
        ) : null}
        {/* The same tasks, as one object. Picking a node selects the task exactly as
            clicking a card does, so the rail's card is about whichever of the two a
            person used. */}
        {shown === "map" ? (
          <div class="map">
            <OrreryFigure
              drawing={taskOrrery(view)}
              onPick={onSelect}
              selected={view.selected}
            />
          </div>
        ) : null}
        {/* The contract is prose and keeps a measure even in a rail that is wider than
            one. A criterion set a thousand pixels wide is a criterion nobody finishes,
            and this is the sentence a person reads before approving a payment. */}
        {shown === "contract" ? (
          <div class="column">
            <Contract view={view} />
          </div>
        ) : null}
        {shown === "timeline" ? <Timeline timeline={timeline} /> : null}
      </section>

      <aside class="rail rail-side">
        <Inbox view={view} send={send} />
        {/* The rail says which task is selected and what agent is on it; the dossier
            pane holds everything that does not fit in a rail. Hidden while the dossier
            is open — the same panel twice is the crowding U7 removed. */}
        {shown !== "task" ? (
          <TaskBrief view={view} onOpen={() => onPane("task")} onSelect={onSelect} />
        ) : null}
        {/* The contract is a pane, so the criteria are one click away — except for the
            verdicts, which are the mission's score and belong in sight of the board. */}
        {shown !== "contract" ? <Verdicts view={view} /> : null}
      </aside>
    </div>
  );
}

/** The outcome criteria as marks: is this mission winning. The statements are in the
 *  contract pane; what is here is only whether each one is met yet. */
function Verdicts({ view }: { view: View }) {
  if (view.criteria.length === 0) return null;

  return (
    <>
      <h2>Outcome</h2>
      <div class="card verdicts">
        {view.criteria.map((criterion) => (
          <p class="verdict" key={criterion.id}>
            <span class={criterion.met === true ? "ok" : criterion.met === false ? "bad" : "quiet"}>
              {criterion.met === true ? "✓" : criterion.met === false ? "✗" : "○"}
            </span>{" "}
            <span class="id">{criterion.id}</span> {criterion.statement}
          </p>
        ))}
      </div>
    </>
  );
}

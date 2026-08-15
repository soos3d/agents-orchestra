// What each screen says.
//
// Ported from `web/page/screens.ts`, where these were string-concatenating functions
// inside a template literal. Same screens, same words, same order — the port is
// mechanical on purpose, because a rewrite and a restyle in one diff is a diff nobody
// can review. The stylesheet is untouched, so every class name here is one
// `web/page/style.ts` already defines.
//
// Two things the port removes for free. `esc()` is gone: Preact escapes text nodes,
// and hand-rolled escaping was the kind of thing that only fails on the one input
// nobody tried. And the "no backticks, no dollar-brace" rule is gone with the
// template literal that needed it — `shell.test.ts` guarded that and retires with it.
//
// What U7 took out of it: everything that is only true while a mission is *running*
// now lives in `runView.tsx`, and the contract both halves draw lives in
// `contract.tsx`. This file is the road from a goal to a signed-off plan, plus home.
// The split is not tidying — the board and the contract had one copy each and two
// callers, and a component nobody can point at is the one that drifts.
import { Fragment } from "preact";
import { type WorkspaceProbe } from "../../config/workspaces.js";
import { type ClientMessage } from "../protocol.js";
import { briefing, isPreparing } from "./briefing.js";
import { Contract, Criteria } from "./contract.js";
import { type PaneKey } from "./hud.js";
import { Controls, Inbox, RunView } from "./runView.js";
import { type View } from "./state.js";

type Send = (message: ClientMessage) => void;

/** Picking a workspace is the page's own business, exactly as selecting a task is: it
 *  moves a highlight and sends nothing. What it *chooses* rides on the next compose,
 *  as an id. */
type Choose = (workspaceId: string) => void;

interface ScreenProps {
  view: View;
  send: Send;
  /** Selecting a task is the page's own business — it opens a panel and sends
   *  nothing. The only view state that is not a projection of the log. */
  onSelect(taskId: string | null): void;
  /** Which pane the run view's centre rail shows, and how to change it. Page state of
   *  exactly the same kind as `selected`: it sends nothing and decides nothing.
   *  Required rather than defaulted — an optional prop is a place a rail can be
   *  finished and switched off at once, which this codebase has paid for three times. */
  pane: PaneKey;
  onPane(pane: PaneKey): void;
  /** The rendered log lines, held by the app because they accumulate across frames
   *  rather than being folded from any one of them. */
  timeline: readonly string[];
}

/** A text box and two buttons, used by both sign-off screens. The words differ
 *  because "revise the plan" and "reject this change" are not the same thing to the
 *  person clicking, but from the port's side it is one decision. */
function ApproveOrRevise({ send, approve, reject, placeholder }: {
  send: Send;
  approve: string;
  reject: string;
  placeholder: string;
}) {
  return (
    <div class="row">
      <button
        class="primary"
        onClick={(event) => {
          (event.currentTarget as HTMLButtonElement).disabled = true;
          send({ kind: "approve" });
        }}
      >
        {approve}
      </button>
      <input id="feedback" placeholder={placeholder} />
      <button
        onClick={() => {
          const box = document.getElementById("feedback") as HTMLInputElement | null;
          const feedback = box?.value.trim();
          if (feedback) send({ kind: "revise", feedback });
        }}
      >
        {reject}
      </button>
    </div>
  );
}

/**
 * The briefing (UI plan U5): goal → scan → intake → spec → plan → sign-off as one
 * sequence, instead of four screens that appear minutes apart with dead air between.
 *
 * It is a trail, and it only ever *appends* — which is the whole mitigation for the
 * risk the plan names. Nothing above the approve button reorders as stages complete,
 * so the button does not slide into place under a pointer that was already moving, and
 * the contract a person read at `specifying` is the same contract in the same place
 * when the button arrives beneath it.
 *
 * Only the running row moves. `briefing()` guarantees there is exactly one.
 */
function Briefing({ view }: { view: View }) {
  const stages = briefing(view);

  return (
    <ol class="briefing">
      {stages.map((stage) => (
        <li class={`stage stage-${stage.state}`} key={stage.key}>
          <span class="stage-mark" aria-hidden="true">
            {stage.state === "done" ? "✓" : stage.state === "running" ? "▸" : "○"}
          </span>
          <span class="stage-label">{stage.label}</span>
          {stage.detail ? <span class="stage-detail">{stage.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

// §13's sign-off screen, returning mid-mission: the diff and the reasoning, above the
// spec they would edit.
function CriteriaChange({ view, send }: { view: View; send: Send }) {
  const change = view.pendingChange;
  if (!change) return null;

  return (
    <>
      <h2>A replan wants to change the contract</h2>
      <div class="card warn">
        <p>{change.reasoning}</p>
        <ul>
          {change.diff.map((op, index) =>
            op.op === "add" ? (
              <li key={index}>
                add <span class="id">{op.criterion.id}</span>
                <br />+ {op.criterion.statement}
              </li>
            ) : op.op === "remove" ? (
              <li key={index}>
                remove <span class="id">{op.criterionId}</span>
                <br />
                because {op.reason}
              </li>
            ) : (
              <li key={index}>
                amend <span class="id">{op.criterionId}</span>
                <br />− {op.from.statement}
                <br />+ {op.to.statement}
                <br />
                because {op.reason}
              </li>
            ),
          )}
        </ul>
      </div>
      <Criteria criteria={view.criteria} />
      <ApproveOrRevise
        send={send}
        approve="approve the change"
        reject="reject"
        placeholder="or say why the criteria should stand…"
      />
    </>
  );
}

/** The contract, and the one row of buttons that is the whole difference between
 *  watching a mission prepare and being asked about it. The buttons are last, under
 *  everything they approve — never where a click aimed at the previous screen lands. */
function Signoff({ view, send }: { view: View; send: Send }) {
  return (
    <>
      <Contract view={view} />
      <ApproveOrRevise
        send={send}
        approve="approve"
        reject="revise"
        placeholder="or say what should change…"
      />
    </>
  );
}

function Intake({ view, send }: { view: View; send: Send }) {
  return (
    <>
      <h2>A few questions before this is planned</h2>
      {view.questions.map((question, index) => (
        <div class="card" key={question.id}>
          <p>
            {index + 1}. {question.question}
          </p>
          {question.options ? <p class="quiet">{question.options.join("  /  ")}</p> : null}
          <input class="answer" data-qid={question.id} placeholder="leave blank to skip" />
        </div>
      ))}
      <div class="row">
        <button
          class="primary"
          onClick={(event) => {
            (event.currentTarget as HTMLButtonElement).disabled = true;
            const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("input.answer"));
            send({
              kind: "intake",
              answers: boxes.map((box) => ({ questionId: box.dataset.qid ?? "", answer: box.value })),
            });
          }}
        >
          send answers
        </button>
      </div>
    </>
  );
}

/** What discovery found for a directory, as one line per fact (UI plan U4). Every
 *  line is observed rather than settable — the UI shows what was probed and never
 *  offers a field to declare it (§2a rule 3). */
function Discovered({ probe }: { probe: WorkspaceProbe }) {
  return (
    <dl class="why">
      <dt>path</dt>
      <dd class="mono">{probe.path}</dd>
      <dt>git</dt>
      <dd>{probe.repoRoot ? `repo at ${probe.repoRoot}` : "not a git repo — research and computer missions still run"}</dd>
      <dt>verify</dt>
      <dd>{probe.verify ? `${probe.verify.command}  (from ${probe.verify.source})` : "none found — code tasks merge without a project gate"}</dd>
      <dt>workers</dt>
      <dd>{probe.agents.length > 0 ? probe.agents.join(", ") : "none on PATH — no code task can be dispatched"}</dd>
      <dt>state</dt>
      <dd class="mono">{probe.stateDir}</dd>
    </dl>
  );
}

/** The workspace picker and the add flow. Two steps, and the split is the design: a
 *  probe resolves and reports, and only then is there anything to confirm. The server
 *  refuses an add it did not just resolve, so this is the readable half of a rule that
 *  is enforced elsewhere. */
function Workspaces({ view, send, onChoose }: { view: View; send: Send; onChoose: Choose }) {
  const { list, probe, live, chosen, defaultId } = view.workspaces;
  if (!list) return null;

  return (
    <>
      <h2>Workspace</h2>
      {list.map((workspace) => {
        const busy = live[workspace.id];
        return (
          <div
            class={`card${workspace.id === chosen ? " chosen" : ""}`}
            key={workspace.id}
            onClick={() => onChoose(workspace.id)}
          >
            <strong class="mono">{workspace.path}</strong>
            <div class="quiet">
              {workspace.id === defaultId ? "where serve was started" : "added"}
              {busy ? ` · mission ${busy} is running here` : ""}
            </div>
            {workspace.id !== defaultId && !busy ? (
              <div class="row">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    send({ kind: "workspace_forget", workspaceId: workspace.id });
                  }}
                >
                  remove
                </button>
              </div>
            ) : null}
          </div>
        );
      })}

      <div class="card">
        <div class="row">
          <input id="workspace-path" placeholder="another directory, e.g. ~/code/ledger" />
          <button
            onClick={() => {
              const box = document.getElementById("workspace-path") as HTMLInputElement | null;
              const typed = box?.value.trim();
              if (typed) send({ kind: "workspace_probe", path: typed });
            }}
          >
            check
          </button>
        </div>

        {probe ? (
          <>
            <Discovered probe={probe} />
            {probe.problem ? <p class="bad">{probe.problem}</p> : null}
            {probe.registered ? <p class="quiet">already a workspace</p> : null}
            {!probe.problem && !probe.registered ? (
              <div class="row">
                <button
                  onClick={() =>
                    send({ kind: "workspace_add", path: probe.path, create: !probe.exists })
                  }
                >
                  {probe.exists ? "add this directory" : "create it and add it"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * `orchestra doctor`, on the page (UI plan U6).
 *
 * The same report the command prints, so the two cannot disagree about whether this
 * machine is ready — and the transports line is what this machine can *start*, never
 * the list the build ships (defect 21). Every line carries its fix, because a check
 * that cannot tell you what to type next has not helped (§2a rule 5).
 */
function Health({ view }: { view: View }) {
  const health = view.health;
  if (!health) return null;

  return (
    <>
      <h2>This machine {health.ready ? "" : "— not ready"}</h2>
      <div class={`card${health.ready ? "" : " warn"}`}>
        <dl class="why">
          {health.checks.map((check) => (
            // A keyed `Fragment` rather than `<>`: the pair is one row of the list and
            // Preact keys the outermost node of a mapped item, which here is neither
            // the `dt` nor the `dd`.
            <Fragment key={check.name}>
              <dt>
                <span class={check.level === "ok" ? "ok" : check.level === "warn" ? "quiet" : "bad"}>
                  {check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✗"}
                </span>{" "}
                {check.name}
              </dt>
              <dd>
                {check.detail}
                {check.fix ? (
                  <>
                    <br />
                    <span class="quiet mono">→ {check.fix}</span>
                  </>
                ) : null}
              </dd>
            </Fragment>
          ))}
          <dt>transports</dt>
          <dd>
            {health.transports.length > 0
              ? health.transports.join(", ")
              : "none — no worker CLI on PATH, so nothing can be dispatched"}
          </dd>
        </dl>
      </div>
    </>
  );
}

/** Statuses a mission cannot be carried on from. Everything else is parked at
 *  something — a question, a pause, a decision point that would not answer — and
 *  resume is what lifts it. The page only decides whether to *offer* the button; the
 *  server decides whether it runs, and refuses with a reason. */
const FINISHED = ["complete", "abandoned"];

/** §13's compose card, minus the envelope editor: a composed mission gets the default
 *  envelope, and widening it stays a deliberate act elsewhere. No unattended toggle
 *  either — skipping sign-off is a typed CLI flag (§17). */
function Home({ view, send, onChoose }: { view: View; send: Send; onChoose: Choose }) {
  const { chosen, live, list } = view.workspaces;
  const target = list?.find((workspace) => workspace.id === chosen);
  const busy = chosen ? live[chosen] : undefined;

  return (
    <>
      <Workspaces view={view} send={send} onChoose={onChoose} />

      <h2>New mission</h2>
      <div class="card">
        {target ? <p class="quiet mono">in {target.path}</p> : null}
        <textarea
          id="compose-goal"
          rows={3}
          placeholder="e.g. Reconcile June invoices across Xero and Ramp. Flag anything that does not match."
        />
        <div class="row">
          <input id="compose-budget" type="number" min="1" placeholder="budget minutes (240)" />
          {/* Research, spec, plan, estimate — then stop (U6). Not `--unattended`,
              which appears nowhere here and stays a flag somebody has to type. */}
          <label for="compose-plan-only">
            <input id="compose-plan-only" type="checkbox" /> plan only — dispatch nothing
          </label>
          <button
            class="primary"
            disabled={busy !== undefined}
            onClick={() => {
              const goalBox = document.getElementById("compose-goal") as HTMLTextAreaElement | null;
              const budgetBox = document.getElementById("compose-budget") as HTMLInputElement | null;
              const planBox = document.getElementById("compose-plan-only") as HTMLInputElement | null;
              const goal = goalBox?.value.trim();
              if (!goal) return;
              const budget = Number(budgetBox?.value);
              send({
                kind: "compose",
                goal,
                planOnly: planBox?.checked === true,
                // The one value that comes from the page's own state, and it is the
                // id of the workspace row that was clicked — the stated exception to
                // the containment rule, and an id rather than a path by design.
                ...(chosen ? { workspaceId: chosen } : {}),
                ...(Number.isFinite(budget) && budget > 0 ? { budgetMinutes: budget } : {}),
              });
            }}
          >
            start mission
          </button>
        </div>
        {busy ? (
          <p class="quiet">mission {busy} is running in this directory — one at a time per workspace.</p>
        ) : null}
      </div>

      <h2>Missions</h2>
      {view.missions && view.missions.length > 0 ? (
        view.missions.map((mission) => {
          const running = Object.values(live).includes(mission.id);
          return (
            <div class="card" key={mission.id}>
              <strong>{mission.goal}</strong>
              <div class="quiet mono">
                {mission.id} · {mission.status}
                {running ? " · running" : ""}
              </div>
              <div class="row">
                <button onClick={() => send({ kind: "watch", missionId: mission.id })}>watch</button>
                {/* The mission that was parked overnight, carried on from the browser
                    (U6). Which directory it runs in is the server's to work out from
                    the mission's own envelope — this button names only the mission. */}
                {!running && !FINISHED.includes(mission.status) ? (
                  <button onClick={() => send({ kind: "resume", missionId: mission.id })}>
                    resume
                  </button>
                ) : null}
                <button onClick={() => send({ kind: "forget", missionId: mission.id })}>
                  forget
                </button>
              </div>
              <div class="row">
                <input
                  class="save-name"
                  data-mission={mission.id}
                  placeholder="keep it as… (a name to replay)"
                />
                <button
                  onClick={() => {
                    const box = document.querySelector<HTMLInputElement>(
                      `input.save-name[data-mission="${mission.id}"]`,
                    );
                    const name = box?.value.trim();
                    if (name) send({ kind: "save", missionId: mission.id, name });
                  }}
                >
                  save
                </button>
              </div>
            </div>
          );
        })
      ) : (
        <p class="quiet">none yet</p>
      )}

      <Health view={view} />
    </>
  );
}

/**
 * Which screen, in priority order.
 *
 * `pendingChange` outranks `awaiting_signoff` deliberately: a reopened mission carries
 * the same status one field apart (§3), and showing the plan screen would put an
 * approve button under a contract change nobody was shown.
 */
export function Screen({ view, send, onSelect, pane, onPane, timeline }: ScreenProps) {
  // The briefing rides above intake and sign-off rather than replacing them: those
  // two *are* stages of it, and a person answering intake should be able to see what
  // the scan already turned up (U5).
  if (view.questions.length > 0) {
    return (
      <div class="column">
        <Briefing view={view} />
        <Intake view={view} send={send} />
        <Controls view={view} send={send} />
      </div>
    );
  }
  // No briefing here. A criteria change arrives long after preparing is over, and a
  // trail of finished stages above it would frame a contract change as routine.
  if (view.pendingChange) {
    return (
      <div class="column">
        <CriteriaChange view={view} send={send} />
      </div>
    );
  }
  if (view.status === "awaiting_signoff") {
    return (
      <div class="column">
        <Briefing view={view} />
        <Signoff view={view} send={send} />
      </div>
    );
  }
  // The minutes that used to be a blank page. Same trail, same contract components,
  // in the same order — the sign-off screen appends to this rather than replacing it.
  if (isPreparing(view)) {
    return (
      <div class="column">
        <Briefing view={view} />
        <Contract view={view} />
        {/* The inbox rides along here too. A permission can be requested before the
            board exists — a research worker dispatched by the scan is already out —
            and a card nobody is shown is a worker waiting for the session to time out. */}
        <Inbox view={view} send={send} />
        <Controls view={view} send={send} />
      </div>
    );
  }

  // Everything past sign-off. The single column is over: three rails, the board in
  // the middle, and whatever wants a human on the right (U7).
  return (
    <RunView
      view={view}
      send={send}
      onSelect={onSelect}
      pane={pane}
      onPane={onPane}
      timeline={timeline}
    />
  );
}

export { Home };

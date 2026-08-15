// The orrery: where every node sits, as a pure function of the folded view.
//
// The board answers "what is each task doing" and it answers it well — five columns and
// a card each, readable at forty tasks. What it cannot do is be *glanced* at: a person
// four hours into a run wants one object that says how far this is from finished, and a
// board says that only by being read. So the orrery is a second view of the same facts,
// and its whole content is two rules:
//
//  - **Angle is order.** A node's angle comes from its index in the plan, and nothing
//    else moves it. A task that starts running does not jump across the circle, so the
//    eye can keep a node it was watching.
//  - **Radius is lifecycle.** Waiting is the outer ring, in flight is the middle, and
//    settled is the inner one. Work falls inward as it finishes, so "nearly done" is a
//    shape rather than a count — which is the thing the board cannot show.
//
// It is a module rather than a pile of coordinates inside the SVG for the reason
// `hud.ts` is one: a layout can be wrong invisibly. A node drawn on the wrong ring
// still looks like a dashboard.
//
// Two feeds, one geometry. Home has no task list — the page only folds the mission it
// is watching — so there the nodes are the *missions* and the core is the server. Under
// a mission they are the tasks and the core is `hud.ts`'s. Neither knows about the
// other; both hand this file an ordered list.
import { core as missionStatus, type Core, type Tone } from "./hud.js";
import { type View } from "./state.js";

/** Where a node sits, and therefore what has happened to it. */
export type Ring = "outer" | "middle" | "inner";

export interface OrreryNode {
  id: string;
  /** Two or three characters — this is drawn at 9px beside a 5px dot. */
  label: string;
  /** The sentence a screen reader gets, and the hover title. */
  title: string;
  ring: Ring;
  tone: Tone;
  /** Whether this node is the one in flight. Only these are allowed to move. */
  active: boolean;
}

export interface OrreryEdge {
  from: string;
  to: string;
}

export interface PlacedNode extends OrreryNode {
  x: number;
  y: number;
}

export interface PlacedEdge {
  id: string;
  /** An SVG path, bowed toward the core so threads read as connections and not as a
   *  cat's cradle across the middle. */
  path: string;
  active: boolean;
}

export interface Orrery {
  /** The viewBox is square and in its own units; the SVG is scaled by CSS. */
  size: number;
  centre: number;
  coreRadius: number;
  /** The radii the rings are drawn at, outermost first — the SVG draws these as
   *  hairline circles whether or not anything sits on them, because an empty ring is
   *  what makes a full one legible. */
  rings: readonly number[];
  core: Core;
  nodes: readonly PlacedNode[];
  edges: readonly PlacedEdge[];
}

const SIZE = 240;
const CENTRE = SIZE / 2;
const CORE_RADIUS = 27;

const RADIUS: Record<Ring, number> = { outer: 101, middle: 74, inner: 47 };

/** Twelve o'clock, so the first task of a plan is at the top of the circle. */
const START = -90;

/** How far an edge bows toward the core. Zero would draw chords across the middle and
 *  through the core's own label. */
const BOW = 0.42;

const TASK_RING: Record<string, Ring> = {
  waiting: "outer",
  todo: "outer",
  running: "middle",
  verifying: "middle",
  review: "middle",
  blocked: "middle",
  done: "inner",
  failed: "inner",
  conflicted: "inner",
  cancelled: "inner",
};

const TASK_TONE: Record<string, Tone> = {
  running: "live",
  verifying: "live",
  review: "live",
  blocked: "attn",
  done: "met",
  failed: "fail",
  conflicted: "fail",
  cancelled: "idle",
};

const MISSION_RING: Record<string, Ring> = {
  complete: "inner",
  abandoned: "inner",
};

const MISSION_TONE: Record<string, Tone> = {
  complete: "met",
  abandoned: "fail",
  awaiting_signoff: "attn",
};

/** The last segment of a task or mission id, which is the part that differs. A mission
 *  id is a timestamp and a slug; three characters of the timestamp identify nothing. */
function shortLabel(id: string): string {
  const tail = id.split(/[-_/]/).filter(Boolean).at(-1) ?? id;
  return tail.slice(0, 4);
}

function place(nodes: readonly OrreryNode[]): readonly PlacedNode[] {
  const count = nodes.length;
  return nodes.map((node, index) => {
    // Index in the given order, never in a filtered or sorted one: this is the whole
    // of "angle is order", and sorting by status here would undo it.
    const angle = ((START + (360 * index) / Math.max(count, 1)) * Math.PI) / 180;
    const radius = RADIUS[node.ring];
    return {
      ...node,
      x: CENTRE + radius * Math.cos(angle),
      y: CENTRE + radius * Math.sin(angle),
    };
  });
}

function thread(from: PlacedNode, to: PlacedNode): string {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const controlX = midX + (CENTRE - midX) * BOW;
  const controlY = midY + (CENTRE - midY) * BOW;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

/** Geometry, given an ordered list and whatever the core says. Edges naming a node that
 *  is not there are dropped rather than drawn to the origin — a replan removes tasks,
 *  and a thread to the top-left corner is how that would look. */
export function layout(
  nodes: readonly OrreryNode[],
  edges: readonly OrreryEdge[],
  core: Core,
): Orrery {
  const placed = place(nodes);
  const byId = new Map(placed.map((node) => [node.id, node]));

  const drawn = edges.flatMap((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return [];
    return [{
      id: `${edge.from}->${edge.to}`,
      path: thread(from, to),
      active: from.active || to.active,
    }];
  });

  return {
    size: SIZE,
    centre: CENTRE,
    coreRadius: CORE_RADIUS,
    rings: [RADIUS.outer, RADIUS.middle, RADIUS.inner],
    core,
    nodes: placed,
    edges: drawn,
  };
}

/** The mission's tasks, in plan order — which is the Map's insertion order, since
 *  `fold` appends a task when it is planned and never re-inserts one. */
export function taskOrrery(view: View): Orrery {
  const tasks = [...view.tasks.values()];

  const nodes = tasks.map((task): OrreryNode => ({
    id: task.id,
    label: shortLabel(task.id),
    title: `${task.id} · ${task.status} · ${task.goal}`,
    ring: TASK_RING[task.status] ?? "outer",
    tone: TASK_TONE[task.status] ?? "idle",
    active: task.status === "running",
  }));

  const edges = tasks.flatMap((task) =>
    task.dependsOn.map((dependency): OrreryEdge => ({ from: dependency, to: task.id })),
  );

  return layout(nodes, edges, missionStatus(view));
}

/** What home has instead of tasks. No edges: missions do not depend on each other, and
 *  drawing threads between them would claim they do. */
export function missionOrrery(view: View): Orrery {
  const running = new Set(Object.values(view.workspaces.live));
  const missions = view.missions ?? [];

  const nodes = missions.map((mission): OrreryNode => ({
    id: mission.id,
    label: shortLabel(mission.id),
    title: `${mission.goal} · ${mission.status}`,
    ring: running.has(mission.id) ? "middle" : MISSION_RING[mission.status] ?? "outer",
    tone: running.has(mission.id) ? "live" : MISSION_TONE[mission.status] ?? "idle",
    active: running.has(mission.id),
  }));

  return layout(nodes, [], homeCore(missions.length, running.size));
}

/** The core of the home orrery. It is not `hud.ts`'s: no mission is being watched, so
 *  there is no status to report — only how many are running, which is the one number
 *  the server knows and the page came for. */
export function homeCore(missions: number, running: number): Core {
  if (running > 0) {
    return {
      label: running === 1 ? "1 running" : `${running} running`,
      tone: "live",
      spin: true,
      detail: missions === 1 ? "1 mission" : `${missions} missions`,
    };
  }
  if (missions === 0) {
    return { label: "standing by", tone: "idle", spin: false, detail: "no missions yet" };
  }
  return {
    label: "standing by",
    tone: "idle",
    spin: false,
    detail: missions === 1 ? "1 mission" : `${missions} missions`,
  };
}

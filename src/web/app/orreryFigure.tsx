// The orrery, drawn.
//
// Geometry is `orrery.ts`'s and none of it is decided here — this file turns a list of
// placed nodes into SVG and nothing else. The split is the same one `hud.ts` has with
// `runView.tsx`, and for the same reason: what a picture *claims* has to be assertable
// without rendering it.
//
// Two things about the drawing are rules rather than styling:
//
//  - **A node is a control, so it is reachable from a keyboard.** Every node is a
//    focusable `g` with an `aria-label` that says what it is and what it is doing, and
//    the whole figure carries a `title` a screen reader gets instead of the picture.
//    An SVG that only responds to a mouse is a part of the page that does not exist for
//    some people.
//  - **Only the active nodes and their threads move.** The sweep turns while the loop
//    is working, and the ambient ring drifts slowly enough to read as atmosphere rather
//    than as an event. `prefers-reduced-motion` stops all of it in the stylesheet.
import { type Orrery, type PlacedNode } from "./orrery.js";

interface OrreryProps {
  drawing: Orrery;
  /** What a click on a node means. Home watches the mission; the run view selects the
   *  task. Both are page state — the orrery sends no message of its own. */
  onPick(id: string): void;
  /** The node drawn as chosen, if any. */
  selected?: string | null;
}

function Node({ node, onPick, selected }: { node: PlacedNode; onPick(id: string): void; selected: boolean }) {
  return (
    <g
      class={`orb orb-${node.tone}${node.active ? " orb-on" : ""}${selected ? " orb-picked" : ""}`}
      tabIndex={0}
      role="button"
      aria-label={node.title}
      transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
      onClick={() => onPick(node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPick(node.id);
        }
      }}
    >
      <title>{node.title}</title>
      {/* The halo is a second circle rather than a filter: a blur on forty nodes is a
          repaint per frame, and this panel is open for hours. */}
      <circle class="orb-halo" r={node.active ? 11 : 8} />
      <circle class="orb-dot" r={node.active ? 5 : 3.5} />
      <text class="orb-label" y={-11}>
        {node.label}
      </text>
    </g>
  );
}

export function OrreryFigure({ drawing, onPick, selected }: OrreryProps) {
  const { size, centre, coreRadius, core } = drawing;
  const summary = `${core.label}${core.detail ? ` — ${core.detail}` : ""}, ${drawing.nodes.length} nodes`;

  return (
    <figure class={`orrery-wrap orrery-${core.tone}${core.spin ? " orrery-spin" : ""}`}>
    {/* `group`, not `img`. An image is a leaf: ARIA treats everything inside a
        role="img" as presentational, which would have hidden every node — and each
        node is a button. The label still summarises the figure for anyone who does not
        want to walk it. */}
    <svg
      class="orrery"
      viewBox={`0 0 ${size} ${size}`}
      role="group"
      aria-label={summary}
    >
      <title>{summary}</title>
      <defs>
        <radialGradient id="core-halo">
          <stop offset="0%" stop-color="var(--core)" stop-opacity=".55" />
          <stop offset="45%" stop-color="var(--live)" stop-opacity=".22" />
          <stop offset="100%" stop-color="var(--live)" stop-opacity="0" />
        </radialGradient>
      </defs>

      {/* The rings are drawn whether or not anything sits on them. An empty outer ring
          is the difference between "nothing is waiting" and "the picture is loading". */}
      {drawing.rings.map((radius, index) => (
        <circle
          class={`orbit${index === 0 ? " orbit-drift" : ""}`}
          key={radius}
          cx={centre}
          cy={centre}
          r={radius}
        />
      ))}

      {drawing.edges.map((edge) => (
        <path class={`thread${edge.active ? " thread-on" : ""}`} key={edge.id} d={edge.path} />
      ))}

      <circle class="core-halo" cx={centre} cy={centre} r={coreRadius * 2.6} fill="url(#core-halo)" />
      <circle class="core-shell" cx={centre} cy={centre} r={coreRadius} />
      {/* The sweep: one bright arc on a hairline circle, so turning is visible and
          standing still is unremarkable. The same idea as the crown's ring, at the
          size this panel can afford. */}
      <circle class="core-sweep" cx={centre} cy={centre} r={coreRadius + 7} />

      {drawing.nodes.map((node) => (
        <Node key={node.id} node={node} onPick={onPick} selected={node.id === selected} />
      ))}
    </svg>

    {/* The readout is HTML under the figure rather than SVG text inside the core, and
        that is a correction rather than a preference: a status is whatever the mission
        record says, so a label can be one word or it can be `awaiting_signoff`, and
        text centred in a 54px circle has no way to hold the second. Here it wraps,
        it is selectable, and it is read as text rather than as part of a picture. */}
    <figcaption class="orrery-read">
      <strong>{core.label}</strong>
      {core.detail ? <span>{core.detail}</span> : null}
    </figcaption>
    </figure>
  );
}

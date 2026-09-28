import { type PointerEvent, useRef, useState } from "react";
import "./graph.css";
import { capitalized, type LiveState, layoutTeam, type MemberDef, NODE_H, NODE_W, type Relation, RELATION_TITLE, type RelKind, type RoleDef } from "../model.ts";

const COLOR: Record<RelKind, string> = { handoff: "var(--accent-2)", returns: "var(--amber)", reports: "var(--muted)", consults: "var(--violet)" };

const STATE_TITLE: Record<LiveState, string> = { working: "работает", waiting: "ждёт", idle: "свободен", error: "ошибка", stopped: "остановлен" };

/**
 * The team of a template as a graph: who hands work to whom, who returns it,
 * who reports. With `live`, a running team: each member's state (and whom it
 * waits for); `pending` marks the handoffs still to come (`from->to` keys).
 * With `onConnect`, a relation is drawn by dragging from one member to another
 * (or to the orchestrator).
 */
export function TemplateGraph({
  members,
  relations,
  roles,
  problems = [],
  live,
  pending = [],
  onConnect,
}: {
  members: MemberDef[];
  relations: Relation[];
  roles: RoleDef[];
  problems?: string[];
  live?: Record<string, { state: LiveState; note?: string }>;
  pending?: string[];
  onConnect?: (from: string, to: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number }>();
  const title = (m: MemberDef) => roles.find((r) => r.id === m.role)?.title ?? m.role;
  const g = layoutTeam(
    members.map((m) => {
      const l = live?.[m.key];
      const sub = l
        ? l.state === "waiting" && l.note
          ? l.note
          : `${title(m).toLowerCase()} · ${STATE_TITLE[l.state]}`
        : m.name
          ? `${title(m)} · ${m.key}`
          : m.key;
      return { key: m.key, label: m.name ? capitalized(m.name) : title(m), sub };
    }),
    relations,
    problems,
  );
  const kinds = [...new Set(g.edges.map((e) => e.type))];
  /** The pointer in the graph's coordinates. */
  const at = (e: PointerEvent) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const nodeAt = (x: number, y: number) => g.nodes.find((n) => Math.abs(n.x - x) <= NODE_W / 2 && Math.abs(n.y - y) <= NODE_H / 2);
  const start = onConnect
    ? (key: string) => (e: PointerEvent) => {
        if (key === "orchestrator") return;
        svgRef.current?.setPointerCapture(e.pointerId);
        setDrag({ from: key, ...at(e) });
      }
    : undefined;
  const from = drag && g.nodes.find((n) => n.key === drag.from);
  return (
    <figure className="team-graph">
      <div className="team-graph-scroll">
        <svg
          ref={svgRef}
          width={g.width}
          height={g.height}
          viewBox={`0 0 ${g.width} ${g.height}`}
          role="img"
          aria-label="Связи участников"
          className={onConnect ? "connectable" : undefined}
          onPointerMove={drag ? (e) => setDrag({ ...drag, ...at(e) }) : undefined}
          onPointerUp={
            drag
              ? (e) => {
                  const p = at(e);
                  const target = nodeAt(p.x, p.y);
                  if (target && target.key !== drag.from) onConnect?.(drag.from, target.key);
                  setDrag(undefined);
                }
              : undefined
          }
          onPointerCancel={() => setDrag(undefined)}
        >
          <defs>
            {(Object.keys(COLOR) as RelKind[]).map((k) => (
              <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={COLOR[k]} />
              </marker>
            ))}
          </defs>
          {g.edges.map((e, i) => (
            <g key={i} className={`edge ${e.type}${pending.includes(`${e.from}->${e.to}`) ? " pending" : ""}`}>
              <title>{`${e.from} → ${e.to}: ${RELATION_TITLE[e.type]}${e.on ? `, когда задача в ${e.on}` : ""}${e.note ? ` — ${e.note}` : ""}`}</title>
              <path d={e.d} fill="none" stroke={COLOR[e.type]} strokeWidth={1.6} strokeDasharray={e.type === "consults" || e.type === "reports" ? "4 4" : undefined} markerEnd={`url(#arrow-${e.type})`} />
              {e.on && (
                <text x={e.lx} y={e.ly + (e.type === "returns" ? 13 : -5)} textAnchor="middle" className="edge-label">
                  {e.on}
                </text>
              )}
            </g>
          ))}
          {from && drag && <line className="drag-line" x1={from.x} y1={from.y} x2={drag.x} y2={drag.y} markerEnd="url(#arrow-handoff)" />}
          {g.nodes.map((n) => (
            <g
              key={n.key}
              className={`node${n.orchestrator ? " orch" : ""}${n.flagged ? " flagged" : ""}${live?.[n.key] ? ` live-${live[n.key].state}` : ""}`}
              transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}
              onPointerDown={start?.(n.key)}
            >
              {live?.[n.key] && <title>{`${n.label}: ${STATE_TITLE[live[n.key].state]}${live[n.key].note ? ` — ${live[n.key].note}` : ""}`}</title>}
              <rect width={NODE_W} height={NODE_H} rx={9} />
              <text x={NODE_W / 2} y={19} textAnchor="middle" className="nl">
                {n.label.length > 20 ? `${n.label.slice(0, 19)}…` : n.label}
              </text>
              <text x={NODE_W / 2} y={35} textAnchor="middle" className="ns">
                {n.sub.length > 25 ? `${n.sub.slice(0, 24)}…` : n.sub}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {kinds.length > 0 && (
        <figcaption className="team-graph-legend">
          {kinds.map((k) => (
            <span key={k}>
              <i style={{ background: COLOR[k] }} />
              {RELATION_TITLE[k]}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

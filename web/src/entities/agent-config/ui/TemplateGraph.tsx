import "./graph.css";
import { layoutTeam, type MemberDef, NODE_H, NODE_W, type Relation, RELATION_TITLE, type RelKind, type RoleDef } from "../model.ts";

const COLOR: Record<RelKind, string> = { handoff: "var(--accent-2)", returns: "var(--amber)", reports: "var(--muted)", consults: "var(--violet)" };

/** The team of a template as a graph: who hands work to whom, who returns it, who reports. */
export function TemplateGraph({ members, relations, roles, problems = [] }: { members: MemberDef[]; relations: Relation[]; roles: RoleDef[]; problems?: string[] }) {
  const title = (m: MemberDef) => roles.find((r) => r.id === m.role)?.title ?? m.role;
  const g = layoutTeam(
    members.map((m) => ({ key: m.key, label: m.name ?? title(m), sub: m.name ? `${title(m)} · ${m.key}` : m.key })),
    relations,
    problems,
  );
  const kinds = [...new Set(g.edges.map((e) => e.type))];
  return (
    <figure className="team-graph">
      <div className="team-graph-scroll">
        <svg width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label="Связи участников">
          <defs>
            {(Object.keys(COLOR) as RelKind[]).map((k) => (
              <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={COLOR[k]} />
              </marker>
            ))}
          </defs>
          {g.edges.map((e, i) => (
            <g key={i} className={`edge ${e.type}`}>
              <title>{`${e.from} → ${e.to}: ${RELATION_TITLE[e.type]}${e.on ? `, когда задача в ${e.on}` : ""}${e.note ? ` — ${e.note}` : ""}`}</title>
              <path d={e.d} fill="none" stroke={COLOR[e.type]} strokeWidth={1.6} strokeDasharray={e.type === "consults" || e.type === "reports" ? "4 4" : undefined} markerEnd={`url(#arrow-${e.type})`} />
              {e.on && (
                <text x={e.lx} y={e.ly + (e.type === "returns" ? 13 : -5)} textAnchor="middle" className="edge-label">
                  {e.on}
                </text>
              )}
            </g>
          ))}
          {g.nodes.map((n) => (
            <g key={n.key} className={`node${n.orchestrator ? " orch" : ""}${n.flagged ? " flagged" : ""}`} transform={`translate(${n.x - NODE_W / 2} ${n.y - NODE_H / 2})`}>
              <rect width={NODE_W} height={NODE_H} rx={9} />
              <text x={NODE_W / 2} y={19} textAnchor="middle" className="nl">
                {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
              </text>
              <text x={NODE_W / 2} y={35} textAnchor="middle" className="ns">
                {n.sub.length > 22 ? `${n.sub.slice(0, 21)}…` : n.sub}
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

import { Link } from "react-router";
import { capitalized, liveTeam, MAIL_TITLE, TemplateGraph, useAgentConfig } from "@/entities/agent-config";
import type { TeamDetail } from "@/entities/team";

/**
 * How a running team works, live: its members and relations as a graph, who
 * works now and who waits for whose handoff. The team keeps the snapshot it
 * took from its template; a later edit of the template is only noted.
 */
export function TeamScheme({ team }: { team: TeamDetail }) {
  const cfg = useAgentConfig().data;
  const spec = team.spec;
  if (!spec) return null;
  const status = team.taskInfo?.status ?? "ready";
  const { live, pending } = liveTeam(spec, team.members, status, team.state === "active");
  const waiting = spec.members.filter((m) => live[m.key]?.state === "waiting");
  return (
    <section className="team-scheme" aria-label="Схема команды">
      <div className="team-scheme-head">
        <span>
          {spec.title ? `Шаблон «${spec.title}»` : "Состав из ролей"}
          {spec.template && cfg?.teams.some((t) => t.id === spec.template) && (
            <>
              {" · "}
              <Link to={`/agents?tab=templates&id=${spec.template}`}>открыть</Link>
            </>
          )}
        </span>
        <span className="muted">почта: {MAIL_TITLE[spec.mail]}</span>
        {waiting.length > 0 && <span className="team-scheme-wait">{waiting.map((m) => `${capitalized(m.name)} ${live[m.key].note}`).join("; ")}</span>}
      </div>
      {team.templateChanged && (
        <p className="team-scheme-note">
          Шаблон изменён после запуска: команда работает по снимку, который взяла при старте. Новые настройки ролей участники получают после перезапуска.
        </p>
      )}
      <TemplateGraph
        members={spec.members.map((m) => ({ key: m.key, role: m.role, name: m.name }))}
        relations={spec.relations}
        roles={cfg?.roles ?? []}
        live={live}
        pending={pending}
      />
    </section>
  );
}

// Skills and MCP connections: what the library holds, who uses it, and the
// editors for administrators.

import { useState } from "react";
import { Link } from "react-router";
import { type Catalogue, splitFrontmatter, useDeleteConfig, useMcpConfig, useSkill } from "@/entities/agent-config";
import { ConfirmDialog, Icon, Markdown } from "@/shared/ui";
import { FileEditor, History, Problems, Section, useAction } from "./common.tsx";

export function SkillsTab({ cfg, selected, onSelect }: { cfg: Catalogue; selected?: string; onSelect: (name: string) => void }) {
  const current = selected ?? cfg.skills[0]?.name;
  const users = (name: string) => cfg.roles.filter((r) => r.skills?.includes(name));
  return (
    <div className="split">
      <section className="split-list" aria-label="Навыки">
        {cfg.skills.map((s) => (
          <button type="button" key={s.name} className={`pick${s.name === current ? " on" : ""}`} onClick={() => onSelect(s.name)} aria-current={s.name === current}>
            <span className="t">
              <span className="mono">{s.name}</span>
            </span>
            <span className="s">{s.description}</span>
            <span className="s">{users(s.name).length ? `роли: ${users(s.name).map((r) => r.id).join(", ")}` : "роли его не перечисляют"}</span>
          </button>
        ))}
        {!cfg.skills.length && (
          <p className="muted ag-list-note">
            Навыков пока нет. Навык — каталог с <span className="mono">SKILL.md</span> в <span className="mono">&lt;data&gt;/skills</span> или в каталогах{" "}
            <span className="mono">skills.paths</span>; готовые наборы (anthropics/skills, pi-skills) подключаются как есть.
          </p>
        )}
      </section>
      <section className="split-main" aria-label="Навык">
        {current ? <SkillPane key={current} name={current} cfg={cfg} /> : <div className="pane-empty">Выберите или добавьте навык</div>}
      </section>
    </div>
  );
}

function SkillPane({ name, cfg }: { name: string; cfg: Catalogue }) {
  const skill = useSkill(name);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteConfig();
  const act = useAction();
  const d = skill.data;
  if (!d) return <div className="pane-empty">{skill.error ? skill.error.message : "Загрузка…"}</div>;
  const body = d.content ? (splitFrontmatter(d.content)?.body ?? d.content) : "";
  return (
    <>
      <div className="pane-head">
        <div className="ttl">
          <h2 className="mono">{d.skill.name}</h2>
          <span className="sub">{d.skill.description}</span>
          <span className="sub mono">{d.skill.dir}</span>
        </div>
        {d.admin && d.editable && (
          <>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              <Icon.file size={13} />
              SKILL.md
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
              <Icon.trash size={13} />
              Удалить
            </button>
          </>
        )}
      </div>
      <div className="pane-body">
        {d.admin && !d.editable && <p className="muted ag-note">Навык из каталога skills.paths: его меняют там, где он лежит (например, в клоне репозитория с навыками).</p>}
        <Section title="Кто пользуется">
          {d.usedBy.length ? (
            <ul className="ag-links">
              {d.usedBy.map((r) => (
                <li key={r}>
                  <Link to={`/agents?tab=roles&id=${r}`}>{cfg.roles.find((x) => x.id === r)?.title ?? r}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted ag-empty">Роли его не перечисляют; его получают роли без своего списка навыков, если он установлен и для pi.</p>
          )}
        </Section>
        <Section title="Инструкции">
          <div className="ag-skill-body">
            <Markdown text={body} />
          </div>
        </Section>
        {d.files.length > 1 && (
          <Section title="Файлы">
            <ul className="ag-files mono">
              {d.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Section>
        )}
        {d.admin && (
          <Section title="История">
            <History item={`skill:${d.skill.name}`} admin={d.admin} />
          </Section>
        )}
      </div>
      {editing && (
        <FileEditor kind="skill" id={d.skill.name} title={`skills/${d.skill.name}/SKILL.md`} initial={d.content ?? ""} baseHash={d.hash} onClose={() => setEditing(false)} />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Удалить навык ${d.skill.name}?`}
          confirmLabel="Удалить"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void act(() => remove("skill", d.skill.name), "Навык удалён");
          }}
        >
          Каталог навыка удаляется целиком. Роли, которые его перечисляют, получат предупреждение.
        </ConfirmDialog>
      )}
    </>
  );
}

const MCP_EXAMPLE = `{
  "mcpServers": {
    "github": {
      "description": "GitHub: issues, pull requests, code",
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer \${env:GITHUB_MCP_TOKEN}" }
    }
  }
}
`;

export function McpTab({ cfg }: { cfg: Catalogue }) {
  const mcp = useMcpConfig();
  const [editing, setEditing] = useState(false);
  const d = mcp.data;
  const users = (id: string) => cfg.roles.filter((r) => r.mcp.some((g) => g === "*" || g === id || g.startsWith(`${id}:`)));
  return (
    <div className="ag-page">
      {!cfg.mcpAdapter && (
        <p className="ag-warn">
          pi-mcp-adapter не найден в настройках pi: агенты работают без MCP. Установите его: <span className="mono">pi install npm:pi-mcp-adapter</span> (или задайте{" "}
          <span className="mono">runtime.mcpAdapter</span>).
        </p>
      )}
      <div className="ag-page-head">
        <p className="muted">
          Подключения описаны в <span className="mono">&lt;data&gt;/mcp.json</span> (формат mcpServers). Агент получает только подключения своей роли; секреты — ссылками{" "}
          <span className="mono">{"${env:ИМЯ}"}</span> на окружение сервера.
        </p>
        {d?.admin && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            <Icon.file size={13} />
            mcp.json
          </button>
        )}
      </div>
      {d?.problems && <Problems items={d.problems} />}
      <div className="ag-table-wrap">
        <table className="ag-table">
          <thead>
            <tr>
              <th>Подключение</th>
              <th>Как</th>
              <th>Проекты</th>
              <th>Роли с доступом</th>
            </tr>
          </thead>
          <tbody>
            {(d?.servers ?? cfg.mcp).map((s) => (
              <tr key={s.id}>
                <td>
                  <span className="mono">{s.id}</span>
                  {s.description && <div className="muted">{s.description}</div>}
                </td>
                <td>{s.transport === "http" ? "HTTP" : "команда"}</td>
                <td>{s.projects?.join(", ") ?? "все"}</td>
                <td>
                  {users(s.id).map((r, i) => (
                    <span key={r.id}>
                      {i > 0 && ", "}
                      <Link to={`/agents?tab=roles&id=${r.id}`}>{r.id}</Link>
                    </span>
                  ))}
                  {!users(s.id).length && <span className="muted">—</span>}
                </td>
              </tr>
            ))}
            {!(d?.servers ?? cfg.mcp).length && (
              <tr>
                <td colSpan={4} className="muted">
                  Подключений пока нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {d?.admin && (
        <Section title="История">
          <History item="mcp" admin />
        </Section>
      )}
      {editing && d?.file && (
        <FileEditor
          kind="mcp"
          id=""
          title="mcp.json"
          hint={
            <>
              Поля genie: <span className="mono">description</span> и <span className="mono">projects</span>. Секреты не пишите в файл — только{" "}
              <span className="mono">{"${env:ИМЯ}"}</span>.
            </>
          }
          initial={d.file.content ?? MCP_EXAMPLE}
          baseHash={d.file.hash}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

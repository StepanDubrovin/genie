// Roles: the list, a role's page and its editors. Every edit rewrites fields of
// the role's file (`<data>/agents/<id>.md`); for a built-in role without a file
// that creates an override holding only the changed fields.

import { useState } from "react";
import { Link } from "react-router";
import {
  allowDeny,
  basePermissions,
  type Catalogue,
  CLASS_TITLE,
  FILES_TITLE,
  FIXED_PERMISSIONS,
  ORIGIN_TITLE,
  PERMISSION_GROUPS,
  type RoleDef,
  type RoleDetail,
  setBody,
  setFrontmatterKey,
  splitFrontmatter,
  STAGE_TITLE,
  useDeleteConfig,
  useRole,
  useSaveConfig,
} from "@/entities/agent-config";
import { ConfirmDialog, Icon, Markdown, Modal, useToast } from "@/shared/ui";
import { Badge, FileEditor, History, Problems, Section, useAction } from "./common.tsx";

export function RolesTab({ cfg, selected, onSelect }: { cfg: Catalogue; selected?: string; onSelect: (id: string) => void }) {
  const team = cfg.roles.filter((r) => r.class !== "orchestrator");
  const orch = cfg.roles.filter((r) => r.class === "orchestrator");
  const current = selected ?? team[0]?.id;
  // Where a role is used: templates of the catalogue, automations of the server.
  const used = (id: string) => {
    const templates = cfg.teams.filter((t) => t.members.some((m) => m.role === id)).length;
    const automations = cfg.automations?.roles[id] ?? 0;
    return [templates ? `шаблонов: ${templates}` : "", automations ? `автоматизаций: ${automations}` : ""].filter(Boolean).join(", ");
  };
  const pick = (r: RoleDef) => (
    <button type="button" key={r.id} className={`pick${r.id === current ? " on" : ""}`} onClick={() => onSelect(r.id)} aria-current={r.id === current}>
      <span className="t">
        <span className={`ag-class c-${r.class}`} aria-hidden="true">
          {r.class[0].toUpperCase()}
        </span>
        <span>{r.title}</span>
        {r.origin !== "builtin" && <Badge tone={r.origin === "custom" ? "accent" : "amber"}>{ORIGIN_TITLE[r.origin]}</Badge>}
      </span>
      <span className="s">
        {[
          r.id,
          CLASS_TITLE[r.class],
          r.model ?? "",
          r.skills ? `навыков: ${r.skills.length}` : "",
          r.mcp.length ? `MCP: ${r.mcp.length}` : "",
          r.projects ? `проекты: ${r.projects.join(", ")}` : "",
          used(r.id),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {r.description && <span className="s">{r.description}</span>}
    </button>
  );
  return (
    <div className="split">
      <section className="split-list" aria-label="Роли">
        {team.map(pick)}
        {orch.length > 0 && <span className="label">Оркестратор</span>}
        {orch.map(pick)}
      </section>
      <section className="split-main" aria-label="Роль">
        {current ? <RolePane key={current} id={current} cfg={cfg} /> : <div className="pane-empty">Ролей нет</div>}
      </section>
    </div>
  );
}

function RolePane({ id, cfg }: { id: string; cfg: Catalogue }) {
  const detail = useRole(id);
  const [editing, setEditing] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteConfig();
  const act = useAction();
  const d = detail.data;
  if (!d) return <div className="pane-empty">{detail.error ? detail.error.message : "Загрузка…"}</div>;
  const r = d.role;
  const admin = d.admin;
  const hasFile = d.file.content !== null;
  return (
    <>
      <div className="pane-head">
        <div className="ttl">
          <h2>{r.title}</h2>
          <span className="sub">
            <span className="mono">{r.id}</span> · класс {CLASS_TITLE[r.class]}
            {r.extends ? ` · на основе ${r.extends}` : ""} · {ORIGIN_TITLE[r.origin]}
            {r.path ? ` · ${r.path}` : ""}
          </span>
          {r.description && <span className="sub">{r.description}</span>}
        </div>
        {admin && (
          <>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              <Icon.file size={13} />
              Файл
            </button>
            {hasFile && d.builtin !== null && (
              <button type="button" className="btn" onClick={() => void act(() => remove("role", r.id, d.file.hash), "Роль снова встроенная")}>
                Вернуть встроенную
              </button>
            )}
            {hasFile && d.builtin === null && (
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
                <Icon.trash size={13} />
                Удалить
              </button>
            )}
          </>
        )}
      </div>
      <div className="pane-body">
        <Problems items={d.problems} />
        {r.class === "orchestrator" ? (
          <Section title="Разрешения">
            <p className="muted ag-empty">Права оркестратора фиксированы: он разбирает задачи, собирает команды и принимает работу.</p>
          </Section>
        ) : (
          <Permissions detail={d} cfg={cfg} />
        )}
        <Settings detail={d} />
        <Skills detail={d} cfg={cfg} />
        <Mcp detail={d} cfg={cfg} />
        <Section
          title="Промпт"
          aside={
            admin && (
              <button type="button" className="btn" onClick={() => setPrompting(true)}>
                Изменить промпт
              </button>
            )
          }
        >
          <details className="ag-prompt">
            <summary>Показать промпт роли{r.instructions ? " и особенности" : ""}</summary>
            <Markdown text={r.prompt ?? ""} />
            {r.instructions && (
              <>
                <h4>Особенности роли</h4>
                <Markdown text={r.instructions} />
              </>
            )}
          </details>
        </Section>
        <Section title="Где используется">
          {!d.usedBy.templates.length && !d.usedBy.automations.length ? (
            <p className="muted ag-empty">Ни в шаблонах, ни в автоматизациях.</p>
          ) : (
            <ul className="ag-links">
              {d.usedBy.templates.map((t) => (
                <li key={t}>
                  шаблон <Link to={`/agents?tab=templates&id=${t}`}>{cfg.teams.find((x) => x.id === t)?.title ?? t}</Link>
                </li>
              ))}
              {d.usedBy.automations.map((a) => (
                <li key={a.id}>
                  автоматизация <Link to={`/automations?rule=${a.id}`}>{a.name}</Link>
                  {a.project ? <span className="muted"> · {a.project}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {admin && (
          <Section title="История">
            <History item={`role:${r.id}`} admin={admin} />
          </Section>
        )}
      </div>
      {editing && (
        <FileEditor
          kind="role"
          id={r.id}
          title={`agents/${r.id}.md`}
          hint={
            hasFile
              ? "Настройки во frontmatter, промпт — в теле файла."
              : "Файла ещё нет: сохранение создаст переопределение встроенной роли. Незаданные поля и пустое тело оставят встроенные значения."
          }
          initial={d.file.content ?? "---\n---\n"}
          baseHash={d.file.hash}
          problems={d.problems}
          onClose={() => setEditing(false)}
        />
      )}
      {prompting && <PromptEditor detail={d} onClose={() => setPrompting(false)} />}
      {confirmDelete && (
        <ConfirmDialog
          title={`Удалить роль ${r.id}?`}
          confirmLabel="Удалить"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void act(() => remove("role", r.id, d.file.hash), "Роль удалена");
          }}
        >
          Сервер откажет, если роль используют шаблоны или автоматизации. Участники идущих команд с этой ролью остановятся с ошибкой.
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * The role's prompt (the body of its file) with a live preview. An empty text
 * leaves the built-in prompt, or the parent role's, in force; the built-in text
 * is at hand to start from.
 */
function PromptEditor({ detail, onClose }: { detail: RoleDetail; onClose: () => void }) {
  const r = detail.role;
  const file = detail.file.content;
  const builtin = detail.builtin === null ? undefined : (splitFrontmatter(detail.builtin)?.body ?? detail.builtin).trim();
  const [text, setText] = useState(() => (file === null ? "" : (splitFrontmatter(file)?.body ?? file).trim()));
  const [view, setView] = useState<"text" | "preview">("text");
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = useSaveConfig();
  const toast = useToast();
  const fallback = r.extends ? `промпт роли ${r.extends}` : builtin !== undefined ? "встроенный промпт" : undefined;
  const shown = text.trim() || (r.extends ? (r.prompt ?? "") : (builtin ?? ""));
  const submit = async () => {
    setBusy(true);
    try {
      await save("role", r.id, { content: setBody(file ?? "---\n---\n", text) }, detail.file.hash);
      toast("Промпт сохранён: агенты получат его со следующего старта сессии");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal label={`Промпт роли ${r.id}`} onClose={onClose} wide>
      <div className="mh">
        <Icon.file size={13} />
        <span className="ag-prompt-title">
          Промпт роли <span className="mono">{r.id}</span>
        </span>
        <div className="seg ag-prompt-seg" role="tablist" aria-label="Вид">
          <button type="button" role="tab" aria-selected={view === "text"} className={view === "text" ? "on" : ""} onClick={() => setView("text")}>
            Текст
          </button>
          <button type="button" role="tab" aria-selected={view === "preview"} className={view === "preview" ? "on" : ""} onClick={() => setView("preview")}>
            Просмотр
          </button>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <Icon.close />
        </button>
      </div>
      <div className="mb">
        <p className="muted ag-hint">
          Markdown. Промпт идёт в системный промпт агента после общих правил genie; настройки роли (разрешения, навыки, MCP) задаются отдельно.
          {fallback ? ` Пустой текст — действует ${fallback}.` : ""}
        </p>
        <div className={`ag-prompt-edit show-${view}`}>
          <textarea
            className="mono code-edit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="Текст промпта"
            placeholder={fallback ? `Пусто — ${fallback}` : "Кто ты в команде, как работаешь, что сдаёшь"}
          />
          <div className="ag-prompt-preview" aria-label="Предпросмотр">
            {!text.trim() && fallback && <div className="ag-hint muted">Сейчас действует {fallback}:</div>}
            {shown ? <Markdown text={shown} /> : <p className="muted">Промпта нет.</p>}
          </div>
        </div>
        {builtin !== undefined && (
          <details className="ag-prompt" open={showBuiltin} onToggle={(e) => setShowBuiltin(e.currentTarget.open)}>
            <summary>Встроенный текст роли</summary>
            <pre className="ag-file-text ag-builtin">{builtin}</pre>
            <button type="button" className="btn" onClick={() => setText(builtin)} disabled={text.trim() === builtin}>
              Взять встроенный
            </button>
          </details>
        )}
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="mf">
        {file === null ? "Сохранение создаст файл роли с этим промптом" : `agents/${r.id}.md`}
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}

/** Save changed fields of the role file. */
function useRoleEdit(detail: RoleDetail) {
  const save = useSaveConfig();
  return (fields: [string, string | string[] | undefined][]) => {
    let text = detail.file.content ?? "---\n---\n";
    for (const [k, v] of fields) text = setFrontmatterKey(text, k, v);
    return save("role", detail.role.id, { content: text }, detail.file.hash);
  };
}

function Permissions({ detail, cfg }: { detail: RoleDetail; cfg: Catalogue }) {
  const r = detail.role;
  const base = basePermissions(r, cfg.roles, cfg.classes);
  const [wanted, setWanted] = useState<string[]>(r.capabilities);
  const edit = useRoleEdit(detail);
  const act = useAction();
  const changed = wanted.length !== r.capabilities.length || wanted.some((c) => !r.capabilities.includes(c));
  const toggle = (c: string, on: boolean) => setWanted((w) => (on ? [...w, c] : w.filter((x) => x !== c)));
  const baseName = r.extends ? `роли ${r.extends}` : `класса ${CLASS_TITLE[r.class]}`;
  const save = () => {
    const { allow, deny } = allowDeny(base, wanted, cfg.permissions);
    void act(() => edit([["allow", allow], ["deny", deny]]), "Разрешения сохранены: сервер применяет их сразу");
  };
  return (
    <Section
      title="Разрешения"
      aside={
        detail.admin &&
        changed && (
          <span className="ag-actions">
            <button type="button" className="btn ghost" onClick={() => setWanted(r.capabilities)}>
              Отменить
            </button>
            <button type="button" className="btn primary" onClick={save}>
              Сохранить разрешения
            </button>
          </span>
        )
      }
    >
      <p className="muted ag-note">
        Отмечено то, что роль может; <span className="ag-mark">·</span> — есть у {baseName}. Проверяет сервер, отзыв действует сразу.
      </p>
      <div className="ag-perms">
        {PERMISSION_GROUPS.map((g) => (
          <fieldset key={g.title} disabled={!detail.admin}>
            <legend>{g.title}</legend>
            {g.items.map((p) => {
              const on = wanted.includes(p.id);
              const inBase = base.includes(p.id);
              const diff = on !== inBase ? (on ? " plus" : " minus") : "";
              return (
                <label key={p.id} className={`ag-perm${diff}`}>
                  <input type="checkbox" checked={on} onChange={(e) => toggle(p.id, e.target.checked)} />
                  <span className="mono">{p.id}</span>
                  <span className="ag-mark" title={inBase ? `есть у ${baseName}` : undefined}>
                    {inBase ? "·" : ""}
                  </span>
                  <span className="muted">{p.text}</span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      <p className="muted ag-note">{FIXED_PERMISSIONS}</p>
    </Section>
  );
}

const THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function Settings({ detail }: { detail: RoleDetail }) {
  const r = detail.role;
  const initial = {
    title: r.title,
    description: r.description,
    model: r.model ?? "",
    thinking: r.thinking ?? "",
    files: r.files as string,
    stages: r.stages as string[],
    projects: (r.projects ?? []).join(", "),
    denyCommands: r.denyCommands.join("\n"),
    names: r.names.join(", "),
    instructions: r.instructions ?? "",
  };
  const [f, setF] = useState(initial);
  const [open, setOpen] = useState(false);
  const edit = useRoleEdit(detail);
  const act = useAction();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const fields: [string, string | string[] | undefined][] = [];
    const text = (k: "title" | "description" | "model" | "thinking" | "instructions") => {
      if (f[k] !== initial[k]) fields.push([k, f[k].trim() ? f[k].trim() : undefined]);
    };
    text("title");
    text("description");
    text("model");
    text("thinking");
    text("instructions");
    if (f.files !== initial.files) fields.push(["files", f.files]);
    if (f.stages.join() !== initial.stages.join()) fields.push(["stages", f.stages]);
    if (f.projects !== initial.projects) fields.push(["projects", list(f.projects).length ? list(f.projects) : undefined]);
    if (f.denyCommands !== initial.denyCommands) fields.push(["denyCommands", list(f.denyCommands).length ? list(f.denyCommands) : undefined]);
    if (f.names !== initial.names) fields.push(["names", list(f.names).length ? list(f.names) : undefined]);
    if (!fields.length) return setOpen(false);
    if (await act(() => edit(fields), "Настройки роли сохранены")) setOpen(false);
  };
  // [label, value, a restriction only the harness keeps (an agent with a shell can get round it until containers)]
  const facts: [string, string, boolean?][] = [
    ["Файлы", FILES_TITLE[r.files], r.files !== "write"],
    ["Стадии", r.stages.map((s) => STAGE_TITLE[s]).join(", ") || "—"],
    ["Модель", r.model ? `${r.model}${r.thinking ? ` · ${r.thinking}` : ""}` : "из roleModels или модель харнесса"],
    ["Запрещённые команды", r.denyCommands.join(", ") || "—", r.denyCommands.length > 0],
    ["Проекты", r.projects?.join(", ") ?? "все"],
    ["Имена", r.names.join(", ") || "по классу"],
  ];
  return (
    <Section
      title="Настройки"
      aside={
        detail.admin &&
        !open && (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Изменить
          </button>
        )
      }
    >
      {!open ? (
        <dl className="ag-facts">
          {facts.map(([k, v, soft]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                {v}
                {soft && (
                  <span className="ag-soft" title="Соблюдает харнесс агента: через shell агент может обойти это ограничение, пока агенты не работают в контейнерах">
                    <Badge tone="amber">мягкое</Badge>
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <form
          className="ag-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            Название
            <input value={f.title} onChange={(e) => set("title", e.target.value)} required />
          </label>
          <label className="field">
            Описание — видят оркестратор и люди при выборе роли
            <textarea rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          <div className="ag-row">
            <label className="field">
              Модель — provider/id
              <input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="из roleModels" />
            </label>
            <label className="field">
              Размышление
              <select value={f.thinking} onChange={(e) => set("thinking", e.target.value)}>
                {THINKING.map((t) => (
                  <option key={t} value={t}>
                    {t || "по умолчанию"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Файлы
              <select value={f.files} onChange={(e) => set("files", e.target.value)}>
                {(["write", "read", "none"] as const).map((x) => (
                  <option key={x} value={x}>
                    {FILES_TITLE[x]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="ag-inline">
            <legend>Стадии задачи</legend>
            {(["refinement", "delivery"] as const).map((s) => (
              <label key={s}>
                <input
                  type="checkbox"
                  checked={f.stages.includes(s)}
                  onChange={(e) => set("stages", e.target.checked ? [...f.stages, s] : f.stages.filter((x) => x !== s))}
                />
                {STAGE_TITLE[s]}
              </label>
            ))}
          </fieldset>
          <label className="field">
            Запрещённые команды shell — по одной в строке, * — любой текст
            <textarea rows={3} className="mono" value={f.denyCommands} onChange={(e) => set("denyCommands", e.target.value)} placeholder="git push*" />
          </label>
          <div className="ag-row">
            <label className="field">
              Проекты — пусто: все
              <input value={f.projects} onChange={(e) => set("projects", e.target.value)} placeholder="shop, erp" />
            </label>
            <label className="field">
              Имена участников
              <input value={f.names} onChange={(e) => set("names", e.target.value)} placeholder="по классу" />
            </label>
          </div>
          <label className="field">
            Особенности роли — дописываются к промпту
            <textarea rows={4} value={f.instructions} onChange={(e) => set("instructions", e.target.value)} />
          </label>
          <div className="ag-actions">
            <span className="muted">Промпт, модель и навыки дойдут до агентов со следующего старта их сессии.</span>
            <span className="grow" />
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setF(initial);
                setOpen(false);
              }}
            >
              Отмена
            </button>
            <button type="submit" className="btn primary">
              Сохранить
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}

function Skills({ detail, cfg }: { detail: RoleDetail; cfg: Catalogue }) {
  const r = detail.role;
  const [only, setOnly] = useState(r.skills !== undefined);
  const [chosen, setChosen] = useState<string[]>(r.skills ?? []);
  const edit = useRoleEdit(detail);
  const act = useAction();
  const changed = only !== (r.skills !== undefined) || (only && chosen.join() !== (r.skills ?? []).join());
  const missing = (r.skills ?? []).filter((s) => !cfg.skills.some((x) => x.name === s));
  return (
    <Section
      title="Навыки"
      aside={
        detail.admin &&
        changed && (
          <button type="button" className="btn primary" onClick={() => void act(() => edit([["skills", only ? chosen : undefined]]), "Навыки роли сохранены")}>
            Сохранить навыки
          </button>
        )
      }
    >
      {detail.admin ? (
        <div className="ag-choice">
          <label>
            <input type="radio" checked={!only} onChange={() => setOnly(false)} />
            Все навыки, установленные для pi, и навыки репозитория
          </label>
          <label>
            <input type="radio" checked={only} onChange={() => setOnly(true)} />
            Только выбранные и навыки репозитория
          </label>
          {only && (
            <div className="ag-checks">
              {cfg.skills.map((s) => (
                <label key={s.name} title={s.description}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(s.name)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, s.name] : c.filter((x) => x !== s.name)))}
                  />
                  <span className="mono">{s.name}</span>
                  <span className="muted">{s.description}</span>
                </label>
              ))}
              {!cfg.skills.length && <span className="muted">В библиотеке пока нет навыков: добавьте их на вкладке «Навыки».</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="ag-empty">
          {r.skills === undefined ? "Все навыки, установленные для pi, и навыки репозитория." : r.skills.length ? r.skills.join(", ") : "Только навыки репозитория."}
        </p>
      )}
      {missing.length > 0 && <p className="ag-warn">Не установлены: {missing.join(", ")} — агент их не получит.</p>}
    </Section>
  );
}

type Grant = { mode: "none" | "all" | "tools"; tools: string };

function Mcp({ detail, cfg }: { detail: RoleDetail; cfg: Catalogue }) {
  const r = detail.role;
  const initial = (): Record<string, Grant> =>
    Object.fromEntries(
      cfg.mcp.map((s) => {
        const whole = r.mcp.includes(s.id) || r.mcp.includes("*");
        const tools = r.mcp.filter((g) => g.startsWith(`${s.id}:`)).map((g) => g.slice(s.id.length + 1));
        return [s.id, { mode: whole ? "all" : tools.length ? "tools" : "none", tools: tools.join(", ") } satisfies Grant];
      }),
    );
  const [grants, setGrants] = useState(initial);
  const [open, setOpen] = useState(false);
  const edit = useRoleEdit(detail);
  const act = useAction();
  const unknown = r.mcp.filter((g) => g !== "*" && !cfg.mcp.some((s) => s.id === g.split(":")[0]));
  const save = async () => {
    const out: string[] = [...unknown];
    for (const s of cfg.mcp) {
      const g = grants[s.id];
      if (g.mode === "all") out.push(s.id);
      if (g.mode === "tools") out.push(...list(g.tools).map((t) => `${s.id}:${t}`));
    }
    if (await act(() => edit([["mcp", out.length ? out : undefined]]), "Доступ к MCP сохранён")) setOpen(false);
  };
  return (
    <Section
      title="MCP-подключения"
      aside={
        detail.admin &&
        !open &&
        cfg.mcp.length > 0 && (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Изменить
          </button>
        )
      }
    >
      {!cfg.mcpAdapter && r.mcp.length > 0 && <p className="ag-warn">pi-mcp-adapter не найден: агенты работают без MCP (pi install npm:pi-mcp-adapter).</p>}
      {!open ? (
        r.mcp.length ? (
          <ul className="ag-links">
            {r.mcp.map((g) => {
              const [server, tools] = g.includes(":") ? [g.slice(0, g.indexOf(":")), g.slice(g.indexOf(":") + 1)] : [g, ""];
              const s = cfg.mcp.find((x) => x.id === server);
              return (
                <li key={g}>
                  <span className="mono">{g === "*" ? "все подключения" : server}</span>
                  {tools && <span className="muted"> · инструменты {tools}</span>}
                  {s?.description && <span className="muted"> — {s.description}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted ag-empty">Нет доступа к MCP.{!cfg.mcp.length ? " Подключений пока нет — добавьте их на вкладке «MCP»." : ""}</p>
        )
      ) : (
        <div className="ag-grants">
          {cfg.mcp.map((s) => {
            const g = grants[s.id];
            const set = (v: Partial<Grant>) => setGrants((x) => ({ ...x, [s.id]: { ...x[s.id], ...v } }));
            return (
              <div key={s.id} className="ag-grant">
                <span className="mono">{s.id}</span>
                <span className="muted">{s.description}</span>
                <select value={g.mode} onChange={(e) => set({ mode: e.target.value as Grant["mode"] })} aria-label={`Доступ к ${s.id}`}>
                  <option value="none">нет доступа</option>
                  <option value="all">все инструменты</option>
                  <option value="tools">только инструменты…</option>
                </select>
                {g.mode === "tools" && <input value={g.tools} onChange={(e) => set({ tools: e.target.value })} placeholder="get_*, list_commits" aria-label={`Инструменты ${s.id}`} />}
              </div>
            );
          })}
          <div className="ag-actions">
            <span className="muted">Закрытое подключение перестаёт работать сразу; новое агент получит со следующего старта сессии.</span>
            <span className="grow" />
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setGrants(initial());
                setOpen(false);
              }}
            >
              Отмена
            </button>
            <button type="button" className="btn primary" onClick={() => void save()}>
              Сохранить
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

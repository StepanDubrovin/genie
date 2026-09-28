import { useState } from "react";
import "./spawn.css";
import { useNavigate } from "react-router";
import { STAGE_TITLE, TemplateGraph, templatesFor, useAgentConfig, WORKSPACE_TITLE } from "@/entities/agent-config";
import { useMeta } from "@/entities/project";
import { useInvalidating, request } from "@/shared/api";
import { Icon, Modal, useToast } from "@/shared/ui";

/**
 * Assemble a team for a task: a template (its members and relations; models can
 * be changed for this team) or roles picked one by one, and a note for the kickoff.
 */
export function SpawnTeamDialog({ task, onClose }: { task: { id: string; title: string; status: string }; onClose: () => void }) {
  const cfg = useAgentConfig().data;
  const meta = useMeta().data;
  const toast = useToast();
  const navigate = useNavigate();
  const early = ["inbox", "draft", "refining"].includes(task.status);
  const templates = cfg ? templatesFor(cfg.teams, task.status) : [];
  const [mode, setMode] = useState<"template" | "roles">("template");
  const [picked, setPicked] = useState<string>();
  const [models, setModels] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<{ role: string; model: string }[]>([]);
  const [note, setNote] = useState("");
  const spawn = useInvalidating((body: unknown) => request<{ id: string }>("POST", "/api/teams", body));
  const template = templates.find((t) => t.id === (picked ?? templates[0]?.id));
  const roles = (cfg?.roles ?? []).filter((r) => r.class !== "orchestrator" && r.stages.includes(early ? "refinement" : "delivery"));
  const defaultModel = (role: string) => meta?.roleModels?.[role]?.model ?? cfg?.roles.find((r) => r.id === role)?.model;

  const submit = () => {
    const body =
      mode === "template"
        ? { task: task.id, template: template?.id, models: Object.fromEntries(Object.entries(models).filter(([, m]) => m.trim())), note: note.trim() || undefined }
        : { task: task.id, members: members.map((m) => ({ role: m.role, model: m.model.trim() || undefined })), note: note.trim() || undefined };
    spawn.mutate(body, {
      onSuccess: (team) => {
        toast(`Команда ${team.id} собрана и получила задачу`);
        onClose();
        navigate(`/team/${encodeURIComponent(team.id)}`);
      },
      onError: (e) => toast(`Не собрана: ${e.message}`, "error"),
    });
  };
  const ready = mode === "template" ? !!template : members.length > 0;

  return (
    <Modal label="Собрать команду" onClose={onClose} wide>
      <div className="mh">
        <Icon.userPlus />
        Собрать команду для {task.id}
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <Icon.close />
        </button>
      </div>
      <div className="mb spawn-team">
        <div className="seg" role="tablist" aria-label="Как собрать">
          <button type="button" role="tab" aria-selected={mode === "template"} className={mode === "template" ? "on" : ""} onClick={() => setMode("template")}>
            По шаблону
          </button>
          <button type="button" role="tab" aria-selected={mode === "roles"} className={mode === "roles" ? "on" : ""} onClick={() => setMode("roles")}>
            Из ролей
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {early
            ? `${task.id} ещё не готова к работе (${task.status}): подходят шаблоны разбора и роли, которые работают до ready.`
            : `${task.id} готова к работе: подходят рабочие шаблоны.`}
        </p>
        {!cfg ? (
          <p className="muted">Загрузка…</p>
        ) : mode === "template" ? (
          <>
            <div className="spawn-templates" role="radiogroup" aria-label="Шаблон">
              {templates.map((t) => (
                <label key={t.id} className={`spawn-template${t.id === template?.id ? " on" : ""}`}>
                  <input type="radio" name="template" checked={t.id === template?.id} onChange={() => setPicked(t.id)} />
                  <span className="t">
                    {t.title} <span className="mono muted">{t.id}</span>
                  </span>
                  <span className="s">{t.description}</span>
                  <span className="s">
                    {STAGE_TITLE[t.stage]} · {WORKSPACE_TITLE[t.workspace]} · {t.members.map((m) => cfg.roles.find((r) => r.id === m.role)?.title ?? m.role).join(", ")}
                  </span>
                </label>
              ))}
              {!templates.length && <p className="muted">Подходящих шаблонов нет — соберите команду из ролей.</p>}
            </div>
            {template && (
              <>
                <TemplateGraph members={template.members} relations={template.relations} roles={cfg.roles} />
                <div className="spawn-models">
                  {template.members.map((m) => (
                    <label key={m.key} className="field">
                      {m.key} — модель
                      <input
                        value={models[m.key] ?? ""}
                        onChange={(e) => setModels((x) => ({ ...x, [m.key]: e.target.value }))}
                        placeholder={m.model ?? defaultModel(m.role) ?? "модель pi по умолчанию"}
                      />
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {members.map((m, i) => (
              <div key={i} className="spawn-member">
                <select value={m.role} onChange={(e) => setMembers((x) => x.map((y, j) => (j === i ? { ...y, role: e.target.value } : y)))} aria-label="Роль">
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title} ({r.id})
                    </option>
                  ))}
                </select>
                <input
                  value={m.model}
                  onChange={(e) => setMembers((x) => x.map((y, j) => (j === i ? { ...y, model: e.target.value } : y)))}
                  placeholder={defaultModel(m.role) ?? "модель pi по умолчанию"}
                  aria-label="Модель"
                />
                <button type="button" className="icon-btn" aria-label="Убрать" onClick={() => setMembers((x) => x.filter((_, j) => j !== i))}>
                  <Icon.trash size={13} />
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost" style={{ alignSelf: "flex-start" }} disabled={!roles.length} onClick={() => setMembers((x) => [...x, { role: roles[0].id, model: "" }])}>
              <Icon.plus size={13} />
              Роль
            </button>
            <p className="muted" style={{ margin: 0 }}>
              Связи между участниками выводятся из их классов: исполнитель сдаёт ревьюеру, ревьюер возвращает на доработку.
            </p>
          </>
        )}
        <label className="field">
          Заметка для команды — попадёт в kickoff
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: сначала покажите план" />
        </label>
      </div>
      <div className="mf">
        Участники получат kickoff, оркестратор — сообщение
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn primary" disabled={!ready || spawn.isPending} onClick={submit}>
          Собрать
        </button>
      </div>
    </Modal>
  );
}

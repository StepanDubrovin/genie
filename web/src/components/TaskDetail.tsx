import { useEffect, useState } from "react";
import { Link } from "react-router";
import { fetchArtifact, useCheck, useComment, useMoveTask, usePatchTask, useTask } from "../lib/api.ts";
import { bytes, timeAgo } from "../lib/format.ts";
import { Markdown } from "../lib/markdown.tsx";
import { PRIORITY_NAME, type Status, STATUS_NAME, type Task, type Team } from "../lib/model.ts";
import { Avatar, Avatars, Labels, Modal, useTick, useToast } from "./bits.tsx";
import { Icon, PriorityIcon, StatusIcon } from "./icons.tsx";

const KIND_NAME: Record<string, string> = { note: "заметка", progress: "прогресс", question: "вопрос", decision: "решение", review: "ревью", handoff: "передача", owner: "владелец" };

export function TaskDetail({ id, team, onClose }: { id: string; team?: Team; onClose: () => void }) {
  useTick();
  const q = useTask(id);
  const toast = useToast();
  const move = useMoveTask();
  const patch = usePatchTask();
  const comment = useComment();
  const check = useCheck();
  const [answer, setAnswer] = useState("");
  const [draft, setDraft] = useState("");
  const [artifact, setArtifact] = useState<{ name: string; kind: string; size: number; text?: string; n: number } | undefined>();
  const [editDesc, setEditDesc] = useState<string | undefined>();

  useEffect(() => {
    setAnswer("");
    setDraft("");
    setEditDesc(undefined);
  }, [id]);

  const fail = (e: Error) => toast(`Не удалось: ${e.message}`, "error");

  if (q.isPending) return <aside className="detail"><div className="empty">Загрузка…</div></aside>;
  if (q.isError) return <aside className="detail"><div className="empty">{q.error.message}</div></aside>;
  const t: Task = q.data;

  const setStatus = (status: Status, note?: string) =>
    move.mutate({ id: t.id, status, note }, { onSuccess: () => toast(`${t.id} → ${STATUS_NAME[status]} · оркестратор уведомлён`), onError: fail });

  const sendAnswer = (andReturn: boolean) => {
    const text = answer.trim();
    if (!text) return;
    comment.mutate(
      { id: t.id, text },
      {
        onSuccess: () => {
          setAnswer("");
          if (andReturn && t.needsOwner) setStatus(t.needsOwner.previous, "Owner answered");
          else toast("Ответ отправлен оркестратору");
        },
        onError: fail,
      },
    );
  };

  const activity = [
    ...t.history.map((h) => ({ kind: "event" as const, at: h.at, h })),
    ...t.comments.map((c) => ({ kind: "comment" as const, at: c.at, c })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <aside className="detail" aria-label={`Задача ${t.id}`}>
      <header className="topbar">
        <button type="button" className="icon-btn m-only" onClick={onClose} aria-label="Назад">
          <Icon.back />
        </button>
        <span className="crumbs">
          {t.parent ? `${t.parent} / ` : ""}
          {t.id}
        </span>
        <span className="grow" />
        {team && (
          <Link to={`/team/${encodeURIComponent(team.id)}`} style={{ fontSize: 12 }}>
            Чат команды {team.id}
          </Link>
        )}
        <button type="button" className="icon-btn d-only" onClick={onClose} aria-label="Закрыть">
          <Icon.close />
        </button>
      </header>

      <div className="detail-body">
        <h2
          className="title"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            const title = e.currentTarget.textContent?.trim() ?? "";
            if (title && title !== t.title) patch.mutate({ id: t.id, patch: { title } }, { onError: fail });
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
        >
          {t.title}
        </h2>

        <div className="props">
          <span className="k">Статус</span>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <StatusIcon status={t.status} size={13} />
            <select aria-label="Статус" value={t.status} onChange={(e) => setStatus(e.target.value as Status)}>
              {(Object.keys(STATUS_NAME) as Status[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_NAME[s]}
                </option>
              ))}
            </select>
          </span>
          <span className="k">Приоритет</span>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <PriorityIcon priority={t.priority} size={13} />
            <select aria-label="Приоритет" value={t.priority} onChange={(e) => patch.mutate({ id: t.id, patch: { priority: Number(e.target.value) } }, { onError: fail })}>
              {PRIORITY_NAME.map((p, i) => (
                <option key={p} value={i}>
                  {p}
                </option>
              ))}
            </select>
          </span>
          <span className="k">Команда</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {team ? (
              <>
                <Avatars members={team.members} />
                <span className="muted">{team.state === "active" ? `${team.id} · ${team.members.filter((m) => m.activity === "working").length} работают` : `${team.id} · остановлена`}</span>
              </>
            ) : (
              <span className="muted">не назначена</span>
            )}
          </span>
          <span className="k">Метки</span>
          <span>{t.labels.length ? <Labels labels={t.labels} /> : <span className="muted">—</span>}</span>
          <span className="k">Интеграция</span>
          <span className="wide">
            <input
              key={`${t.id}-merge-${t.mergeStrategy}`}
              aria-label="Интеграция"
              defaultValue={t.mergeStrategy}
              placeholder="как результат попадёт в систему — договоритесь с оркестратором"
              onBlur={(e) => e.target.value !== t.mergeStrategy && patch.mutate({ id: t.id, patch: { mergeStrategy: e.target.value } }, { onError: fail })}
            />
          </span>
          {t.worktree && (
            <>
              <span className="k">Worktree</span>
              <span className="wide mono" style={{ fontSize: 12 }}>
                {t.worktree.branch ? `⎇ ${t.worktree.branch} · ` : ""}
                {t.worktree.path}
              </span>
            </>
          )}
          {(t.deps.length > 0 || t.children.length > 0) && (
            <>
              <span className="k">Связи</span>
              <span className="wide muted">
                {t.deps.length > 0 && `зависит от ${t.deps.join(", ")}`}
                {t.deps.length > 0 && t.children.length > 0 && " · "}
                {t.children.length > 0 && `подзадачи ${t.children.join(", ")}`}
              </span>
            </>
          )}
        </div>

        {t.needsOwner && (
          <section className="owner-box" aria-label="Нужно ваше решение">
            <div className="h">
              <StatusIcon status="needs_owner" size={15} />
              Нужно ваше решение
              <span className="when">
                {t.needsOwner.by} · {timeAgo(t.needsOwner.at)}
              </span>
            </div>
            <p>{t.needsOwner.question}</p>
            <textarea
              aria-label="Ваш ответ"
              placeholder="Ваш ответ уйдёт оркестратору и команде"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && sendAnswer(true)}
            />
            <div className="actions">
              <span>⌘↵ ответить и вернуть в «{STATUS_NAME[t.needsOwner.previous]}»</span>
              <span className="grow" />
              <button type="button" className="btn ghost" disabled={!answer.trim()} onClick={() => sendAnswer(false)}>
                Только ответить
              </button>
              <button type="button" className="btn amber" disabled={!answer.trim()} onClick={() => sendAnswer(true)}>
                Ответить и вернуть в работу
              </button>
            </div>
          </section>
        )}

        <section className="sec">
          <h3>
            Описание
            {editDesc === undefined ? (
              <button type="button" className="btn ghost" style={{ height: 24 }} onClick={() => setEditDesc(t.description)}>
                Изменить
              </button>
            ) : null}
          </h3>
          {editDesc === undefined ? (
            <Markdown text={t.description} empty="Описания нет" />
          ) : (
            <div className="composer">
              <textarea aria-label="Описание" rows={8} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
              <div className="bar">
                markdown
                <span className="grow" />
                <button type="button" className="btn ghost" onClick={() => setEditDesc(undefined)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => patch.mutate({ id: t.id, patch: { description: editDesc } }, { onSuccess: () => setEditDesc(undefined), onError: fail })}
                >
                  Сохранить
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="sec">
          <h3>
            Критерии приёмки
            <span className="n">
              {t.acceptance.filter((a) => a.done).length} / {t.acceptance.length}
            </span>
          </h3>
          {t.acceptance.length ? (
            <div className="criteria">
              {t.acceptance.map((a) => (
                <label key={a.id} className={a.done ? "done" : ""}>
                  <input type="checkbox" checked={a.done} onChange={(e) => check.mutate({ id: t.id, n: a.id, done: e.target.checked }, { onError: fail })} />
                  <span className="t">{a.text}</span>
                  {a.checkedBy && <span className="by">{a.checkedBy}</span>}
                </label>
              ))}
            </div>
          ) : (
            <span className="muted">Оркестратор сформулирует критерии при уточнении</span>
          )}
        </section>

        {t.plan.trim() && (
          <section className="sec">
            <h3>План</h3>
            <Markdown text={t.plan} />
          </section>
        )}
        {t.notes.trim() && (
          <section className="sec">
            <h3>Заметки</h3>
            <Markdown text={t.notes} />
          </section>
        )}

        {t.artifacts.length > 0 && (
          <section className="sec">
            <h3>
              Артефакты <span className="n">{t.artifacts.length}</span>
            </h3>
            <div className="artifacts">
              {t.artifacts.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  className="artifact"
                  onClick={() => fetchArtifact(t.id, a.id).then((r) => setArtifact({ ...r, n: a.id }), fail)}
                >
                  <Icon.file />
                  <span className="nm">{a.name}</span>
                  <span className="who">
                    {a.kind} · {a.author}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="sec">
          <h3>Активность</h3>
          {activity.map((a) =>
            a.kind === "event" ? (
              <div key={`h${a.at}${a.h.event}`} className="ev">
                <i />
                <span>
                  <span style={{ color: "var(--text-2)" }}>{a.h.actor}</span> {eventText(a.h)} · {timeAgo(a.at)}
                </span>
              </div>
            ) : (
              <div key={`c${a.c.id}`} className={`comment${a.c.role === "human" ? " mine" : ""}`}>
                <div className="head">
                  <Avatar role={a.c.role} name={a.c.author} size="solo" />
                  <span style={{ fontWeight: 500 }}>{a.c.author}</span>
                  <span className="k">{KIND_NAME[a.c.kind] ?? a.c.kind}</span>
                  <span className="when">{timeAgo(a.c.at)}</span>
                </div>
                <Markdown text={a.c.text} />
              </div>
            ),
          )}
          <div className="composer">
            <textarea
              aria-label="Комментарий"
              placeholder="Комментарий для оркестратора и команды"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) comment.mutate({ id: t.id, text: draft.trim() }, { onSuccess: () => setDraft(""), onError: fail });
              }}
            />
            <div className="bar">
              ⌘↵ отправить · оркестратор получит уведомление
              <span className="grow" />
              <button
                type="button"
                className="btn primary"
                disabled={!draft.trim() || comment.isPending}
                onClick={() => comment.mutate({ id: t.id, text: draft.trim() }, { onSuccess: () => setDraft(""), onError: fail })}
              >
                Отправить
              </button>
            </div>
          </div>
        </section>
      </div>

      {artifact && (
        <Modal label={artifact.name} wide onClose={() => setArtifact(undefined)}>
          <div className="mh">
            <Icon.file />
            <span className="mono">{artifact.name}</span>
            <span>
              {artifact.kind} · {bytes(artifact.size)}
            </span>
            <span className="grow" />
            <a href={`/api/tasks/${encodeURIComponent(t.id)}/artifacts/${artifact.n}?download=1`}>Скачать</a>
            <button type="button" className="icon-btn" onClick={() => setArtifact(undefined)} aria-label="Закрыть">
              <Icon.close />
            </button>
          </div>
          <div className="mb">
            {artifact.text === undefined ? (
              <span className="muted">Двоичный файл — скачайте его.</span>
            ) : /\.(md|markdown)$/i.test(artifact.name) ? (
              <Markdown text={artifact.text} />
            ) : (
              <pre className="view">{artifact.text}</pre>
            )}
          </div>
        </Modal>
      )}
    </aside>
  );
}

function eventText(h: Task["history"][number]): string {
  if (h.event === "status" && h.from && h.to) return `${STATUS_NAME[h.from as Status] ?? h.from} → ${STATUS_NAME[h.to as Status] ?? h.to}`;
  if (h.event === "created") return "создал задачу";
  return h.event;
}

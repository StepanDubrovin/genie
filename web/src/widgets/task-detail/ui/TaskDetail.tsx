import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { DocDiagBadge, DocStaleBadge, DocStatusBadge } from "@/entities/doc";
import { Avatar, Avatars } from "@/entities/member";
import type { DocsImpactReason, DocsImpactResult } from "../../../../../src/docs/impact.ts";
import {
  ArtifactThumb,
  EpicIcon,
  EpicProgress,
  historyText,
  Labels,
  PRIORITY_NAME,
  PriorityIcon,
  type Status,
  STATUS_NAME,
  StatusIcon,
  type Task,
  useArtifactViewer,
  useCheck,
  useComment,
  useDocsImpact,
  useEpicMap,
  useMoveTask,
  usePatchTask,
  useTask,
  useTasks,
} from "@/entities/task";
import type { Team } from "@/entities/team";
import { timeAgo, useTick } from "@/shared/lib";
import { Icon, Markdown, useToast } from "@/shared/ui";

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
  const [editDesc, setEditDesc] = useState<string | undefined>();
  const epics = useEpicMap();
  const impactEnabled = q.data?.status === "review" || q.data?.status === "done";
  const impact = useDocsImpact(id, impactEnabled);

  useEffect(() => {
    setAnswer("");
    setDraft("");
    setEditDesc(undefined);
  }, [id]);

  const fail = (e: Error) => toast(`Не удалось: ${e.message}`, "error");
  const viewer = useArtifactViewer(fail);

  if (q.isPending) return <aside className="detail"><div className="empty">Загрузка…</div></aside>;
  if (q.isError) return <aside className="detail"><div className="empty">{q.error.message}</div></aside>;
  const t: Task = q.data;
  const isEpic = t.type === "epic";
  const epic = t.parent ? epics.get(t.parent) : undefined;
  const epicChoices = [...epics.values()].filter((e) => e.id === t.parent || (e.status !== "done" && e.status !== "cancelled"));

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
          {t.parent && (
            <>
              {epic ? <Link to={`/epic/${encodeURIComponent(t.parent)}`}>{t.parent}</Link> : t.parent}
              {" / "}
            </>
          )}
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
          {!isEpic && (
            <>
              <span className="k">Эпик</span>
              <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <EpicIcon size={13} empty={!epic} />
                <select
                  aria-label="Эпик"
                  value={epic ? epic.id : ""}
                  onChange={(e) =>
                    patch.mutate(
                      { id: t.id, patch: { parent: e.target.value || null } },
                      { onSuccess: () => toast(e.target.value ? `${t.id} теперь в эпике ${e.target.value}` : `${t.id} больше не в эпике`), onError: fail },
                    )
                  }
                >
                  <option value="">Без эпика</option>
                  {epicChoices.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.id} · {e.title}
                    </option>
                  ))}
                </select>
              </span>
            </>
          )}
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
          {(t.deps.length > 0 || (!isEpic && t.children.length > 0)) && (
            <>
              <span className="k">Связи</span>
              <span className="wide muted">
                {t.deps.length > 0 && `зависит от ${t.deps.join(", ")}`}
                {t.deps.length > 0 && t.children.length > 0 && " · "}
                {!isEpic && t.children.length > 0 && `подзадачи ${t.children.join(", ")}`}
              </span>
            </>
          )}
        </div>

        {isEpic && (
          <Link className="epic-box link" to={`/epic/${encodeURIComponent(t.id)}`}>
            <EpicIcon />
            Это эпик: его задачи, прогресс и общие артефакты — на странице эпика
            <Icon.chevron size={12} style={{ marginLeft: "auto" }} />
          </Link>
        )}
        {epic && <EpicBox id={epic.id} onArtifact={viewer.show} />}
        {impactEnabled && <DocsImpactBlock result={impact.data} />}

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
            {isEpic ? "Цель" : "Описание"}
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
            {isEpic ? "Критерии успеха" : "Критерии приёмки"}
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
            <h3>{isEpic ? "Дорожная карта" : "План"}</h3>
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
                  onClick={() => viewer.show(t.id, a.id)}
                >
                  <ArtifactThumb task={t.id} artifact={a} />
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
                  <span style={{ color: "var(--text-2)" }}>{a.h.actor}</span> {historyText(a.h, isEpic)} · {timeAgo(a.at)}
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

      {viewer.modal}
    </aside>
  );
}


/** Russian phrasing of the structured impact reasons; matching stays server-side (G-12 lesson). */
function impactReasonText(reasons: DocsImpactReason[]): string {
  return reasons
    .map((reason) => (reason.kind === "changed-path" ? `меняет ${reason.path} — под paths: ${reason.pattern}` : `ссылается на задачу ${reason.id} в related`))
    .join("; ");
}

/**
 * Russian phrasing of the degradation notes (G-39 F2). The core keeps its note
 * vocabulary stable and English for the CLI and logs, so the only Russian surface
 * maps that fixed vocabulary here. An unmapped note falls back to a generic
 * Russian line; the raw English string stays in the element's `title`.
 */
function impactNoteText(note: string): string {
  const mapping: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^no team worktree for this task$/, () => "у задачи нет рабочей копии команды"],
    [/^worktree (.+) does not exist$/, (m) => `рабочая копия ${m[1]} не найдена`],
    [/^worktree (.+) is not a git working tree$/, (m) => `${m[1]} — не git-рабочая копия`],
    [/^worktree (.+) could not be inspected: .*$/, (m) => `рабочую копию ${m[1]} не удалось проверить`],
    [/^no base commit recorded for the team$/, () => "для команды не записан базовый коммит"],
    [/^base (.+) is not reachable from the worktree$/, (m) => `базовый коммит ${m[1]} недоступен из рабочей копии`],
    [/^no changes found between (.+) and HEAD$/, (m) => `между ${m[1]} и HEAD изменений не найдено`],
    [/^docs index unavailable: .*$/, () => "индекс документации недоступен"],
  ];
  for (const [pattern, render] of mapping) {
    const match = pattern.exec(note);
    if (match) return render(match);
  }
  return "не удалось получить данные об изменениях";
}

/** Mockup screen 9: pages the task's changes may have made stale. A hint, never a gate. */
function DocsImpactBlock({ result }: { result: DocsImpactResult | undefined }) {
  const navigate = useNavigate();
  if (!result) return null;
  const candidates = result.candidates;
  const note = result.notes[0];
  return (
    <section className="doc-impact" aria-label="Документация, которую могла затронуть задача">
      <div className="h">
        <Icon.file size={14} />
        Документация, которую могла затронуть задача
        {candidates.length > 0 && <span className="n">{candidates.length}</span>}
        <span className="hint">подсказка · не блокирует</span>
      </div>
      {candidates.length > 0 ? (
        <div className="rows">
          {candidates.map((candidate) => (
            <button
              type="button"
              key={candidate.path}
              className="row"
              onClick={() => navigate(`/docs?page=${encodeURIComponent(candidate.path)}`)}
            >
              {/*
                Screen 9: title + badges on the first line, the full reason on its
                own wrapping line, so the matched pattern is never cut off (G-39 F1).
                F5: `DocMarks` from `@/entities/doc` renders icon-only tree/search
                marks and always draws a status icon (including «актуальна»/«без
                статуса»), while the mockup wants text badges and only for
                draft/deprecated — so the block reuses that module's badge
                components instead of `DocMarks`.
              */}
              <span className="line">
                <Icon.file size={13} />
                <span className="nm">{candidate.title}</span>
                {(candidate.status === "draft" || candidate.status === "deprecated") && <DocStatusBadge status={candidate.status} />}
                {candidate.stale && <DocStaleBadge count={candidate.staleReasons.length} />}
                {candidate.diagnostics.length > 0 && <DocDiagBadge count={candidate.diagnostics.length} />}
              </span>
              <span className="why">{impactReasonText(candidate.reasons)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="muted">Затронутой документации не найдено</div>
      )}
      {note && (
        <div className="why note" title={note}>
          {result.changedPathsAvailable ? `замечание: ${impactNoteText(note)}` : `нет данных об изменениях: ${impactNoteText(note)}`}
        </div>
      )}
    </section>
  );
}


/** The epic a task belongs to: its goal, progress and the artifacts shared by all its tasks. */
function EpicBox({ id, onArtifact }: { id: string; onArtifact: (task: string, n: number) => void }) {
  const epic = useTask(id).data;
  const tasks = (useTasks().data ?? []).filter((x) => x.parent === id);
  if (!epic) return null;
  const goal = epic.description.trim().split(/\n\s*\n/)[0];
  return (
    <section className="epic-box" aria-label={`Эпик ${epic.id}`}>
      <div className="h">
        <EpicIcon />
        <span className="kind">Эпик</span>
        <Link to={`/epic/${encodeURIComponent(epic.id)}`} className="nm">
          {epic.id} · {epic.title}
        </Link>
        {tasks.length > 0 && (
          <span className="mini">
            <EpicProgress tasks={tasks} />
            {tasks.filter((x) => x.status === "done" || x.status === "cancelled").length} из {tasks.length}
          </span>
        )}
      </div>
      {goal ? <Markdown text={goal} /> : <span className="muted">Цель эпика ещё не записана</span>}
      {epic.artifacts.length > 0 && (
        <div className="shared">
          <span className="lbl">Общие артефакты эпика</span>
          <div className="files">
            {epic.artifacts.map((a) => (
              <button type="button" key={a.id} className="artifact small" onClick={() => onArtifact(epic.id, a.id)} title={a.note ?? `${a.kind} · ${a.author}`}>
                <Icon.file size={13} />
                <span className="nm">{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState } from "react";
import { Link } from "react-router";
import { Avatar, Avatars, memberLabel } from "@/entities/member";
import { COLUMNS, type Column, EpicChip, EpicIcon, Labels, PriorityIcon, type Status, STATUS_NAME, StatusIcon, type TaskSummary, useMoveTask } from "@/entities/task";
import type { Team } from "@/entities/team";
import { Icon, Modal, useToast } from "@/shared/ui";

const columnOf = (status: Status): Column => COLUMNS.find((c) => c.statuses.includes(status)) ?? COLUMNS[0];

function CardBody({ t, team }: { t: TaskSummary; team?: Team }) {
  const working = team?.state === "active" && team.members.some((m) => m.activity === "working");
  return (
    <>
      <span className="meta">
        <span className="mono">{t.id}</span>
        {t.priority === 0 ? <span className="urgent-tag">срочно</span> : <PriorityIcon priority={t.priority} size={12} />}
        {t.status === "changes_requested" && <span style={{ color: "var(--amber)" }}>доработка</span>}
        {working && (
          <span className="team">
            <span className="spin" style={{ width: 9, height: 9 }} />
            {team!.id}
          </span>
        )}
      </span>
      <span className="t">
        {t.type === "epic" && (
          <span className="epic-mark">
            <EpicIcon size={12} />
            эпик
          </span>
        )}
        {t.title}
      </span>
      {t.needsOwner && <span className="q">{t.needsOwner.question}</span>}
      {t.openDeps.length > 0 && <span className="muted" style={{ fontSize: 12 }}>ждёт {t.openDeps.join(", ")}</span>}
      <span className="foot">
        <EpicChip id={t.parent} text />
        <Labels labels={t.labels} />
        {t.acceptanceTotal > 0 && (
          <span className="muted" style={{ fontSize: 11 }}>
            ✓ {t.acceptanceDone}/{t.acceptanceTotal}
          </span>
        )}
        <span className="grow" />
        {team && <Avatars members={team.members} />}
      </span>
    </>
  );
}

function Card({ t, team, selected, onSelect }: { t: TaskSummary; team?: Team; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: t.id });
  const cls = ["card", selected ? "sel" : "", t.status === "needs_owner" ? "owner" : "", isDragging ? "dragging" : ""].filter(Boolean).join(" ");
  return (
    <button type="button" ref={setNodeRef} className={cls} onClick={onSelect} {...attributes} {...listeners} aria-pressed={selected} aria-roledescription="карточка задачи">
      <CardBody t={t} team={team} />
    </button>
  );
}

function BoardColumn({ col, tasks, teams, selected, onSelect, collapsed, onExpand }: {
  col: Column;
  tasks: TaskSummary[];
  teams: Map<string, Team>;
  selected?: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const cls = ["col", col.id === "needs_owner" ? "owner" : "", isOver ? "over" : "", collapsed ? "collapsed" : ""].filter(Boolean).join(" ");
  return (
    <section ref={setNodeRef} className={cls} aria-label={col.name}>
      {collapsed ? (
        <button type="button" className="expand" onClick={onExpand} aria-label={`Показать колонку ${col.name}`}>
          <StatusIcon status={col.target} size={13} />
          <span className="v">
            {col.name} · {tasks.length}
          </span>
        </button>
      ) : (
        <>
          <header>
            <StatusIcon status={col.target} size={13} />
            {col.name}
            <span className="n">{tasks.length}</span>
          </header>
          <div className="cards">
            {tasks.map((t) => (
              <Card key={t.id} t={t} team={t.team ? teams.get(t.team) : undefined} selected={selected === t.id} onSelect={() => onSelect(t.id)} />
            ))}
            {!tasks.length && <div className="drop-here">Перетащите сюда</div>}
          </div>
        </>
      )}
    </section>
  );
}

function Peek({ t, team, onClose, onOpen, onMove }: { t: TaskSummary; team?: Team; onClose: () => void; onOpen: () => void; onMove: (s: Status) => void }) {
  return (
    <aside className="peek" aria-label={`Задача ${t.id}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono muted" style={{ fontSize: 12 }}>
          {t.id}
        </span>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <Icon.close />
        </button>
      </div>
      <h2>{t.title}</h2>
      <label className="field">
        Статус
        <select value={t.status} onChange={(e) => onMove(e.target.value as Status)}>
          {(Object.keys(STATUS_NAME) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_NAME[s]}
            </option>
          ))}
        </select>
      </label>
      {t.needsOwner && (
        <div className="owner-box" style={{ padding: "10px 12px", fontSize: 12.5 }}>
          {t.needsOwner.question}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="nav-section" style={{ margin: 0 }}>
          Команда {team?.id ?? ""}
        </span>
        {team ? (
          team.members.map((m) => (
            <span key={m.name} className="member-line">
              <Avatar role={m.role} name={m.name} activity={m.activity} state={m.state} size="solo" />
              {memberLabel(m.name, m.role)}
              <span className="st">{m.activity === "working" ? "работает" : m.activity === "error" ? "ошибка" : m.state === "lost" ? "нет связи" : m.state === "stopped" ? "остановлен" : "ждёт"}</span>
            </span>
          ))
        ) : (
          <span className="muted">Команда не назначена</span>
        )}
      </div>
      <span className="grow" />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn primary grow" style={{ justifyContent: "center", height: 34 }} onClick={onOpen}>
          Открыть задачу
        </button>
        {team && (
          <Link className="btn" style={{ height: 34 }} to={`/team/${encodeURIComponent(team.id)}`}>
            Чат команды
          </Link>
        )}
      </div>
    </aside>
  );
}

export function Board({ tasks, teams, showDone, onShowDone, onOpen }: { tasks: TaskSummary[]; teams: Map<string, Team>; showDone: boolean; onShowDone: () => void; onOpen: (id: string) => void }) {
  const move = useMoveTask();
  const toast = useToast();
  const [selected, setSelected] = useState<string | undefined>();
  const [dragging, setDragging] = useState<string | undefined>();
  const [ask, setAsk] = useState<{ id: string; note: string } | undefined>();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const doMove = (id: string, status: Status, note?: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === status) return;
    move.mutate(
      { id, status, note },
      {
        onSuccess: () => toast(`${id} → ${STATUS_NAME[status]} · оркестратор уведомлён`),
        onError: (e) => toast(`Не удалось: ${e.message}`, "error"),
      },
    );
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(undefined);
    const id = String(e.active.id);
    const col = COLUMNS.find((c) => c.id === e.over?.id);
    const t = tasks.find((x) => x.id === id);
    if (!col || !t || col.statuses.includes(t.status)) return;
    if (col.target === "needs_owner") setAsk({ id, note: "" });
    else doMove(id, col.target);
  };

  const sel = tasks.find((t) => t.id === selected);
  const draggingTask = tasks.find((t) => t.id === dragging);

  return (
    <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(undefined)}>
      <div className="board">
        {COLUMNS.map((col) => (
          <BoardColumn
            key={col.id}
            col={col}
            tasks={tasks.filter((t) => columnOf(t.status).id === col.id)}
            teams={teams}
            selected={selected}
            onSelect={(id) => setSelected((cur) => (cur === id ? undefined : id))}
            collapsed={col.id === "done" && !showDone}
            onExpand={onShowDone}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {draggingTask && (
          <div className="card" style={{ cursor: "grabbing", boxShadow: "var(--shadow)", width: 244 }}>
            <CardBody t={draggingTask} team={draggingTask.team ? teams.get(draggingTask.team) : undefined} />
          </div>
        )}
      </DragOverlay>
      {sel && (
        <Peek
          t={sel}
          team={sel.team ? teams.get(sel.team) : undefined}
          onClose={() => setSelected(undefined)}
          onOpen={() => onOpen(sel.id)}
          onMove={(s) => (s === "needs_owner" ? setAsk({ id: sel.id, note: "" }) : doMove(sel.id, s))}
        />
      )}
      {ask && (
        <Modal label="Вопрос к владельцу" onClose={() => setAsk(undefined)}>
          <div className="mh">
            <StatusIcon status="needs_owner" size={13} /> {ask.id} → Нужно решение
          </div>
          <div className="mb">
            <label className="field">
              Что нужно решить
              <textarea autoFocus rows={3} value={ask.note} onChange={(e) => setAsk({ ...ask, note: e.target.value })} />
            </label>
          </div>
          <div className="mf">
            <span className="grow" />
            <button type="button" className="btn ghost" onClick={() => setAsk(undefined)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn amber"
              disabled={!ask.note.trim()}
              onClick={() => {
                doMove(ask.id, "needs_owner", ask.note.trim());
                setAsk(undefined);
              }}
            >
              Перенести
            </button>
          </div>
        </Modal>
      )}
    </DndContext>
  );
}

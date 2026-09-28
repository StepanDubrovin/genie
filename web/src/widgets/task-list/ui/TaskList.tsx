import { useEffect, useRef } from "react";
import { Avatars } from "@/entities/member";
import { EpicChip, EpicIcon, Labels, PriorityIcon, StatusIcon, type Status, STATUS_NAME, STATUS_ORDER, type TaskSummary } from "@/entities/task";
import type { Team } from "@/entities/team";
import { timeAgo } from "@/shared/lib";

export function TaskList({
  tasks,
  statuses,
  teams,
  focused,
  selected,
  onOpen,
  onFocus,
}: {
  tasks: TaskSummary[];
  statuses: Status[];
  teams: Map<string, Team>;
  focused?: string;
  selected?: string;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => focusRef.current?.scrollIntoView({ block: "nearest" }), [focused]);

  const groups = STATUS_ORDER.filter((s) => statuses.includes(s))
    .map((s) => ({ status: s, items: tasks.filter((t) => t.status === s) }))
    .filter((g) => g.items.length);

  if (!groups.length) {
    return (
      <div className="empty">
        <StatusIcon status="done" size={26} />
        Здесь пусто
      </div>
    );
  }

  return (
    <div role="list" aria-label="Задачи" className="task-groups">
      {groups.map((g) => (
        <section key={g.status} aria-label={STATUS_NAME[g.status]}>
          <div className="group-head">
            <StatusIcon status={g.status} />
            {STATUS_NAME[g.status]} <span className="n">{g.items.length}</span>
          </div>
          {g.items.map((t) => {
            const team = t.team ? teams.get(t.team) : undefined;
            const cls = ["row", focused === t.id ? "focus" : "", selected === t.id ? "sel" : ""].filter(Boolean).join(" ");
            return (
              <div
                key={t.id}
                ref={focused === t.id ? focusRef : undefined}
                role="listitem"
                className={cls}
                onMouseEnter={() => onFocus(t.id)}
                onClick={() => onOpen(t.id)}
              >
                <StatusIcon status={t.status} />
                <span className="id">{t.id}</span>
                <span className="prio">
                  <PriorityIcon priority={t.priority} />
                </span>
                <button type="button" className="title" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}>
                  {t.type === "epic" && (
                    <span className="epic-mark">
                      <EpicIcon size={12} />
                      эпик
                    </span>
                  )}
                  {t.title}
                  {t.needsOwner && <span className="q">{t.needsOwner.question}</span>}
                  {t.openDeps.length > 0 && <span className="w">ждёт {t.openDeps.join(", ")}</span>}
                  {t.blocked && <span className="q">заблокировано: {t.blocked.reason}</span>}
                </button>
                <span className="tags">
                  <EpicChip id={t.parent} />
                  <Labels labels={t.labels} />
                </span>
                {team ? <Avatars members={team.members} /> : <span className="muted" style={{ fontSize: 12 }}>{t.status === "inbox" ? "ждёт оркестратора" : "без команды"}</span>}
                <span className="when">{timeAgo(t.updated)}</span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

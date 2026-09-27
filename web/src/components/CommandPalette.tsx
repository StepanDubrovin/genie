import { type ReactNode, useMemo, useState } from "react";
import { useTasks, useTeams } from "../lib/api.ts";
import { type ViewId, VIEWS } from "../lib/model.ts";
import { Modal } from "./bits.tsx";
import { Icon, StatusIcon } from "./icons.tsx";

export interface PaletteActions {
  newTask: () => void;
  go: (view: ViewId) => void;
  layout: (l: "list" | "board") => void;
  openTask: (id: string) => void;
  openTeam: (id: string) => void;
}

interface Item {
  key: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ onClose, actions }: { onClose: () => void; actions: PaletteActions }) {
  const tasks = useTasks().data ?? [];
  const teams = useTeams().data ?? [];
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const items = useMemo<Item[]>(() => {
    const base: Item[] = [
      { key: "new", icon: <Icon.plus />, label: "Новая задача", hint: "C", run: actions.newTask },
      { key: "list", icon: <Icon.list />, label: "Показать списком", run: () => actions.layout("list") },
      { key: "board", icon: <Icon.board />, label: "Показать доской", hint: "B", run: () => actions.layout("board") },
      ...(Object.keys(VIEWS) as ViewId[]).map((v) => ({ key: `v-${v}`, icon: <Icon.chevron />, label: `Перейти: ${VIEWS[v].name}`, run: () => actions.go(v) })),
      ...teams.filter((t) => t.state === "active").map((t) => ({ key: `t-${t.id}`, icon: <span className="spin" />, label: `Команда ${t.id}`, hint: t.taskInfo?.title, run: () => actions.openTeam(t.id) })),
      ...tasks.map((t) => ({ key: t.id, icon: <StatusIcon status={t.status} />, label: `${t.id}  ${t.title}`, hint: t.labels.join(", "), run: () => actions.openTask(t.id) })),
    ];
    const s = q.trim().toLowerCase();
    return (s ? base.filter((i) => i.label.toLowerCase().includes(s) || (i.hint ?? "").toLowerCase().includes(s)) : base).slice(0, 60);
  }, [q, tasks, teams, actions]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  return (
    <Modal label="Команды" onClose={onClose}>
      <div className="palette">
        <input
          autoFocus
          aria-label="Поиск команд и задач"
          placeholder="Задача, команда или действие…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIdx((i) => Math.min(items.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIdx((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") run(items[idx]);
            else return;
            e.preventDefault();
          }}
        />
        <div className="items" role="listbox">
          {items.map((i, n) => (
            <button key={i.key} type="button" role="option" aria-selected={n === idx} className={`item${n === idx ? " on" : ""}`} onMouseEnter={() => setIdx(n)} onClick={() => run(i)}>
              {i.icon}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label}</span>
              {i.hint && <span className="hint">{i.hint}</span>}
            </button>
          ))}
          {!items.length && <div className="empty" style={{ padding: 30 }}>Ничего не найдено</div>}
        </div>
      </div>
    </Modal>
  );
}

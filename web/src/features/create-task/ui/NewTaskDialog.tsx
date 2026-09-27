import { useState } from "react";
import { useMeta } from "@/entities/project";
import { PRIORITY_NAME, PriorityIcon, StatusIcon, useCreateTask } from "@/entities/task";
import { Icon, Modal, useToast } from "@/shared/ui";

const TYPES: [string, string][] = [
  ["task", "Задача"],
  ["bug", "Баг"],
  ["spike", "Исследование"],
  ["epic", "Эпик"],
];

export function NewTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const meta = useMeta().data;
  const create = useCreateTask();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [priority, setPriority] = useState(2);
  const [type, setType] = useState("task");
  const [labels, setLabels] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    create.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        acceptance: criteria.split("\n").map((s) => s.trim()).filter(Boolean),
        priority,
        type,
        labels: labels.split(",").map((s) => s.trim()).filter(Boolean),
      },
      {
        onSuccess: (t) => {
          toast(`${t.id} во входящих · оркестратор уведомлён`);
          onCreated(t.id);
        },
        onError: (e) => toast(`Не создано: ${e.message}`, "error"),
      },
    );
  };

  return (
    <Modal label="Новая задача" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
        style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <div className="mh">
          <span className="pill">{meta?.project ?? "genie"}</span>
          <Icon.chevron size={12} />
          Новая задача во входящие
          <span className="grow" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon.close />
          </button>
        </div>
        <div className="mb">
          <label className="field">
            Название
            <input className="title-in" autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что нужно сделать?" style={{ height: "auto", border: 0 }} />
          </label>
          <label className="field">
            Описание
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Контекст, ограничения, ссылки. Поддерживается markdown." />
          </label>
          <label className="field">
            Критерии приёмки — по одному в строке (можно оставить оркестратору)
            <textarea rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
          </label>
          <div className="opts">
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <PriorityIcon priority={priority} size={13} />
              <select aria-label="Приоритет" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                {PRIORITY_NAME.map((p, i) => (
                  <option key={p} value={i}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <select aria-label="Тип" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
            <input aria-label="Метки" placeholder="метки через запятую" value={labels} onChange={(e) => setLabels(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          </div>
        </div>
        <div className="mf">
          <StatusIcon status="inbox" />
          Оркестратор получит уведомление и уточнит детали в чате
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || create.isPending}>
            Создать <span style={{ opacity: 0.75, fontSize: 11 }}>⌘↵</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

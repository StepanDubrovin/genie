// UI-side view of the tracker model. Types and constants come straight from the
// server code, so the API contract is checked by the compiler on both sides.

import type { Status, Task, TaskSummary } from "../../../../src/tracker/model.ts";

export type { Status, Task, TaskSummary };

export const STATUS_NAME: Record<Status, string> = {
  inbox: "Входящие",
  draft: "Черновик",
  refining: "Уточнение",
  ready: "Готово к работе",
  in_progress: "В работе",
  review: "На ревью",
  changes_requested: "Доработка",
  approved: "Одобрено",
  needs_owner: "Нужно решение",
  done: "Готово",
  cancelled: "Отменено",
};

export const STATUS_ORDER: Status[] = ["needs_owner", "review", "changes_requested", "in_progress", "approved", "ready", "refining", "draft", "inbox", "done", "cancelled"];

export const ACTIVE: Status[] = ["draft", "refining", "ready", "in_progress", "review", "changes_requested", "approved", "needs_owner"];

export type ViewId = "mine" | "inbox" | "decisions" | "active" | "prep" | "done";

/** Task views; `mine` keeps the tasks the viewer is responsible for. */
export const VIEWS: Record<ViewId, { name: string; statuses: Status[]; mine?: boolean }> = {
  mine: { name: "Мои задачи", statuses: ["inbox", ...ACTIVE, "done"], mine: true },
  inbox: { name: "Входящие", statuses: ["inbox"] },
  decisions: { name: "Нужно решение", statuses: ["needs_owner"] },
  active: { name: "Все активные", statuses: ACTIVE },
  prep: { name: "Подготовка", statuses: ["draft", "refining", "ready"] },
  done: { name: "Завершённые", statuses: ["done", "cancelled"] },
};

export function isView(v: string | undefined): v is ViewId {
  return !!v && v in VIEWS;
}

/** Whether a task belongs in a view; "mine" needs the viewer's login. Finished tasks stay in "mine" for a week. */
export function inViewOf(t: TaskSummary, view: ViewId, login?: string, now = Date.now()): boolean {
  const v = VIEWS[view];
  if (!v.statuses.includes(t.status)) return false;
  if (!v.mine) return true;
  if (!login || t.assignee !== login) return false;
  return t.status !== "done" || now - Date.parse(t.updated) < 7 * 86_400_000;
}

export interface Column {
  id: string;
  name: string;
  statuses: Status[];
  /** Status a card gets when dropped into the column. */
  target: Status;
}

export const COLUMNS: Column[] = [
  { id: "inbox", name: "Входящие", statuses: ["inbox"], target: "inbox" },
  { id: "prep", name: "Подготовка", statuses: ["draft", "refining"], target: "refining" },
  { id: "ready", name: "Готово к работе", statuses: ["ready"], target: "ready" },
  { id: "in_progress", name: "В работе", statuses: ["in_progress", "changes_requested"], target: "in_progress" },
  { id: "review", name: "На ревью", statuses: ["review"], target: "review" },
  { id: "approved", name: "Одобрено", statuses: ["approved"], target: "approved" },
  { id: "needs_owner", name: "Нужно решение", statuses: ["needs_owner"], target: "needs_owner" },
  { id: "done", name: "Готово", statuses: ["done", "cancelled"], target: "done" },
];

export const PRIORITY_NAME = ["Срочно", "Высокий", "Средний", "Низкий", "Без приоритета"];

export const STAGES = ["Уточнение", "Готово к работе", "В работе", "Ревью", "Одобрено", "Принято"];

/** 0…6: how far a task is through refining → done. */
export function stageOf(status: Status, previous?: Status): number {
  const s = status === "needs_owner" && previous ? previous : status;
  const map: Partial<Record<Status, number>> = { refining: 1, ready: 2, in_progress: 3, changes_requested: 3, review: 4, approved: 5, done: 6 };
  return map[s] ?? 0;
}

/**
 * Epics have their own pages. In task views they only show up while someone has to
 * act on them as a whole: the orchestrator (inbox) or the owner (needs owner).
 */
export function inTaskViews(t: TaskSummary): boolean {
  return t.type !== "epic" || t.status === "inbox" || t.status === "needs_owner";
}

/** Where a task of an epic stands, for the epic's progress bar. */
export type Progress = "closed" | "owner" | "review" | "working" | "ready" | "early";

export const PROGRESS: { id: Progress; name: string; color: string }[] = [
  { id: "closed", name: "Закрыто", color: "#7c84f0" },
  { id: "owner", name: "Ждёт вашего решения", color: "#f0a04b" },
  { id: "review", name: "На ревью", color: "#4cb782" },
  { id: "working", name: "В работе", color: "#f2c94c" },
  { id: "ready", name: "Готово к работе", color: "#4a4d55" },
  { id: "early", name: "Черновик", color: "#2e3138" },
];

export function progressOf(status: Status): Progress {
  if (status === "done" || status === "cancelled") return "closed";
  if (status === "needs_owner") return "owner";
  if (status === "review" || status === "approved") return "review";
  if (status === "in_progress" || status === "changes_requested") return "working";
  if (status === "ready") return "ready";
  return "early";
}

const FIELD_RU: Record<string, string> = {
  title: "название",
  type: "тип",
  description: "описание",
  priority: "приоритет",
  "merge strategy": "интеграцию",
  plan: "план",
  notes: "заметки",
  labels: "метки",
  assignees: "исполнителей",
  assignee: "ответственного",
  acceptance: "критерии",
  dependencies: "зависимости",
};

/** A status change's note as the tracker stores it in a comment: `[in_progress → review] text`. */
export function statusNote(text: string): { from: string; to: string; note: string } | undefined {
  const m = /^\[([a-z_]+) → ([a-z_]+)\]\s*([\s\S]*)$/.exec(text.trim());
  return m ? { from: m[1], to: m[2], note: m[3] } : undefined;
}

/** History entry in words for the UI; the tracker records it in English for the agents. */
export function historyText(h: Task["history"][number], epic = false): string {
  const note = h.note ? ` — ${h.note.replace(/^work started on (.+)$/, "команда взяла $1").replace(/^split into (.+)$/, "разбита на $1")}` : "";
  if (h.event === "status" && h.from && h.to) return `${STATUS_NAME[h.from as Status] ?? h.from} → ${STATUS_NAME[h.to as Status] ?? h.to}${note}`;
  if (h.event === "created") return epic ? "создал эпик" : "создал задачу";
  const rules: [RegExp, (...m: string[]) => string][] = [
    [/^child (\S+) added$/, (id) => `добавил задачу ${id}`],
    [/^child (\S+) moved in$/, (id) => `перенёс сюда ${id}`],
    [/^child (\S+) moved out$/, (id) => `убрал ${id} из эпика`],
    [/^artifact #\d+ (.+) \((\S+)\) added$/, (name, kind) => `добавил артефакт ${name} (${kind})`],
    [/^acceptance #(\d+) checked$/, (n) => `отметил критерий #${n}`],
    [/^acceptance #(\d+) unchecked$/, (n) => `снял отметку с критерия #${n}`],
    [/^(\S+) split into (.+)$/, (id, ids) => `разбил ${id} на ${ids}`],
    [/^split into (.+)$/, (ids) => `разбил на ${ids}`],
    [/^blocked: (.+)$/, (r) => `заблокировал: ${r}`],
    [/^unblocked$/, () => "снял блокировку"],
    [/^assigned to team (.+)$/, (t) => `назначил команду ${t}`],
    [/^team released$/, () => "освободил задачу от команды"],
    [
      /^updated (.+)$/,
      (fields) =>
        `изменил ${fields
          .split(", ")
          .map((f) => (f.startsWith("epic → ") ? `эпик на ${f.slice(7)}` : f === "epic removed" ? "эпик (убран)" : (FIELD_RU[f] ?? f)))
          .join(", ")}`,
    ],
  ];
  for (const [re, fn] of rules) {
    const m = h.event.match(re);
    if (m) return fn(...m.slice(1)) + note;
  }
  return h.event + note;
}

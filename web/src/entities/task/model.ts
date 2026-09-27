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

export type ViewId = "inbox" | "decisions" | "active" | "prep" | "done";

export const VIEWS: Record<ViewId, { name: string; statuses: Status[] }> = {
  inbox: { name: "Входящие", statuses: ["inbox"] },
  decisions: { name: "Нужно решение", statuses: ["needs_owner"] },
  active: { name: "Все активные", statuses: ACTIVE },
  prep: { name: "Подготовка", statuses: ["draft", "refining", "ready"] },
  done: { name: "Завершённые", statuses: ["done", "cancelled"] },
};

export function isView(v: string | undefined): v is ViewId {
  return !!v && v in VIEWS;
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

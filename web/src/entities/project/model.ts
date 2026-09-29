import type { Status } from "../../../../src/tracker/model.ts";

export interface Meta {
  prefix: string;
  project: string;
  created: string;
  counts: Partial<Record<Status, number>>;
  user: string;
  roles: string[];
  roleModels: Record<string, { model?: string; thinking?: string }>;
  tailnet?: string;
}

export type ProjectRole = "viewer" | "member" | "admin" | "owner";

export const PROJECT_ROLE_NAME: Record<ProjectRole, string> = { owner: "владелец", admin: "админ", member: "участник", viewer: "только чтение" };

/** What each role may do in a project, for people who hand them out. */
export const PROJECT_ROLE_HINT: Record<ProjectRole, string> = {
  viewer: "видит задачи и документацию, ничего не меняет",
  member: "ставит задачи, отвечает агентам, принимает работу",
  admin: "плюс люди, приглашения, автоматизации и настройки проекта",
  owner: "как админ, и получает уведомления для владельцев",
};

export type Autonomy = "autonomous" | "assisted" | "manual";

export const AUTONOMY: { id: Autonomy; name: string; hint: string }[] = [
  { id: "autonomous", name: "Автономно", hint: "оркестратор ведёт задачи и сам закрывает принятые" },
  { id: "assisted", name: "С подтверждением", hint: "оркестратор ведёт задачи, закрывают их люди" },
  { id: "manual", name: "Вручную", hint: "оркестратор сервера не работает; задачи ведут люди и их агенты" },
];

/** A user of the server. */
export interface Person {
  id: number;
  login: string;
  name: string;
  email?: string;
  isAdmin: boolean;
  disabled: boolean;
  created: string;
}

export interface Membership {
  user: Person;
  role: ProjectRole;
}

/** A project as `/api/projects` lists it, with the caller's role. */
export interface ProjectInfo {
  slug: string;
  name: string;
  trackerDir: string;
  repo?: string;
  space: string;
  autonomy: Autonomy;
  /** How finished work gets integrated unless a task says otherwise. */
  integration: string;
  created: string;
  role: ProjectRole;
}

export function personName(p: Pick<Person, "login" | "name">): string {
  return p.name || p.login;
}

/** Two letters for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const two = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return two.toUpperCase();
}

/** People who can be responsible for a task: active members, the current one kept even if they left. */
export function responsibleChoices(members: Membership[], current?: string): { login: string; label: string }[] {
  const out = members
    .filter((m) => !m.user.disabled && m.role !== "viewer")
    .map((m) => ({ login: m.user.login, label: m.user.name ? `${m.user.name} (@${m.user.login})` : `@${m.user.login}` }));
  if (current && !out.some((o) => o.login === current)) out.unshift({ login: current, label: `@${current}` });
  return out;
}

/** One line of the server's preflight (`genie doctor`). */
export interface DoctorCheck {
  area: string;
  level: "ok" | "warn" | "fail";
  text: string;
  hint?: string;
}

export const DOCTOR_AREA: Record<string, string> = {
  data: "Данные",
  web: "Веб",
  people: "Люди",
  projects: "Проекты",
  agents: "Агенты",
  pi: "pi",
  models: "Модели",
  sandbox: "Песочница",
  git: "git",
  channels: "Каналы",
  network: "Сеть",
  vault: "База знаний",
};

/** How the vault syncs with its git remote. */
export interface VaultSync {
  remote?: string;
  every: number;
  last?: {
    remote: string;
    branch: string;
    at?: string;
    ok: boolean;
    error?: string;
    pulled: number;
    pushed: number;
    both: string[];
    /** Edits that overlapped, and where the other version went. */
    conflicts: string[];
  } | null;
}

/** The preflight in one line: what is broken first. */
export function doctorSummary(checks: DoctorCheck[]): { level: DoctorCheck["level"]; text: string } {
  const fail = checks.filter((c) => c.level === "fail").length;
  const warn = checks.filter((c) => c.level === "warn").length;
  if (fail) return { level: "fail", text: `Нужно исправить: ${fail}${warn ? `, предупреждений: ${warn}` : ""}` };
  if (warn) return { level: "warn", text: `Готов к работе, предупреждений: ${warn}` };
  return { level: "ok", text: "Всё готово" };
}

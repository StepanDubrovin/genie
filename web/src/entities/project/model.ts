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

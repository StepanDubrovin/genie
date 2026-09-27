// Member names: every agent gets a (playful) name, shown as "Name — role".
// Pure module: used by the pi extension, the CLI and the web UI.

import type { MemberRole } from "../tracker/model.ts";

/** Default name pools per role; the id is the lowercase name used in team_send. */
export const DEFAULT_NAME_POOLS: Record<MemberRole, string[]> = {
  analyst: ["sherlock", "poirot", "marple", "columbo", "scully", "mulder", "watson", "clouseau"],
  executor: ["bender", "baymax", "walle", "optimus", "johnny5", "r2d2", "tars", "robocop"],
  reviewer: ["gandalf", "yoda", "hermione", "spock", "galadriel", "dumbledore", "morpheus", "picard"],
  tester: ["murphy", "gremlin", "loki", "jinx", "chaos", "moriarty"],
  documenter: ["tolkien", "homer", "shakespeare", "pushkin", "dickens", "chekhov"],
};

/** Names whose display form is not simply capitalised. */
const DISPLAY_OVERRIDES: Record<string, string> = {
  walle: "WALL-E",
  johnny5: "Johnny 5",
  r2d2: "R2-D2",
  tars: "TARS",
  robocop: "RoboCop",
};

export const ROLE_TITLE_RU: Record<string, string> = {
  analyst: "аналитик",
  executor: "исполнитель",
  reviewer: "ревьюер",
  tester: "тестировщик",
  documenter: "документатор",
  orchestrator: "оркестратор",
  human: "владелец",
};

export const ROLE_TITLE_EN: Record<string, string> = {
  analyst: "analyst",
  executor: "executor",
  reviewer: "reviewer",
  tester: "tester",
  documenter: "documenter",
  orchestrator: "orchestrator",
  human: "owner",
};

/** True for technical names such as "analyst" or "executor2" (teams created before names existed). */
function isRoleLikeName(name: string, role: string): boolean {
  return name === role || new RegExp(`^${role}\\d*$`).test(name);
}

export function displayName(name: string): string {
  if (DISPLAY_OVERRIDES[name]) return DISPLAY_OVERRIDES[name];
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** "Sherlock — аналитик" (or just "Аналитик" for role-like legacy names). */
export function memberLabel(name: string, role: string, lang: "ru" | "en" = "ru"): string {
  const title = (lang === "ru" ? ROLE_TITLE_RU : ROLE_TITLE_EN)[role] ?? role;
  if (isRoleLikeName(name, role)) return title.charAt(0).toUpperCase() + title.slice(1);
  return `${displayName(name)} — ${title}`;
}

/** First letter for avatars. */
export function initial(name: string, role: string): string {
  if (isRoleLikeName(name, role)) return role.charAt(0).toUpperCase();
  return displayName(name).charAt(0).toUpperCase();
}

/**
 * Pick a free name for a role. `taken` should hold names already used in this team
 * and, preferably, in other active teams, so every agent on screen is distinct.
 */
export function pickName(role: MemberRole, taken: Set<string>, pools: Partial<Record<MemberRole, string[]>> = {}): string {
  const pool = pools[role]?.length ? pools[role]! : DEFAULT_NAME_POOLS[role];
  const free = pool.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  for (let i = 2; ; i++) {
    const candidate = `${pool[0] ?? role}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Fill in missing names; explicit names are kept. `taken` is extended in place. */
export function assignNames<T extends { name?: string; role: MemberRole }>(specs: T[], taken: Set<string>, pools?: Partial<Record<MemberRole, string[]>>): (T & { name: string })[] {
  for (const s of specs) if (s.name) taken.add(s.name);
  return specs.map((s) => {
    if (s.name) return s as T & { name: string };
    const name = pickName(s.role, taken, pools);
    taken.add(name);
    return { ...s, name };
  });
}

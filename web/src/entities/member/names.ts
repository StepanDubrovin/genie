// Member names: every agent gets a (playful) name, shown as "Name — role".

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
  researcher: "исследователь",
  orchestrator: "оркестратор",
  human: "владелец",
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
export function memberLabel(name: string, role: string): string {
  const title = ROLE_TITLE_RU[role] ?? role;
  if (isRoleLikeName(name, role)) return title.charAt(0).toUpperCase() + title.slice(1);
  return `${displayName(name)} — ${title}`;
}

/** First letter for avatars. */
export function initial(name: string, role: string): string {
  if (isRoleLikeName(name, role)) return role.charAt(0).toUpperCase();
  return displayName(name).charAt(0).toUpperCase();
}

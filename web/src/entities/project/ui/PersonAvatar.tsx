import { initials } from "../model.ts";

/** A person (not an agent): the one responsible for a task. */
export function PersonAvatar({ login, name, size, prefix = "Ответственный" }: { login: string; name?: string; size?: "md"; prefix?: string }) {
  const label = `${prefix ? `${prefix}: ` : ""}${name && name !== login ? `${name} (@${login})` : `@${login}`}`;
  return (
    <span className={`av person ${size ?? "solo"}`} title={label} role="img" aria-label={label}>
      {initials(name || login)}
    </span>
  );
}

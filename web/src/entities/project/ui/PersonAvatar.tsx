import { initials } from "../model.ts";

/** A person (not an agent): the one responsible for a task. */
export function PersonAvatar({
  login,
  name,
  src,
  size,
  prefix = "Ответственный",
}: {
  login: string;
  name?: string;
  /** The person's photo; initials without one. */
  src?: string;
  size?: "md" | "xl";
  prefix?: string;
}) {
  const label = `${prefix ? `${prefix}: ` : ""}${name && name !== login ? `${name} (@${login})` : `@${login}`}`;
  return (
    <span className={`av person ${size ?? "solo"}${src ? " photo" : ""}`} title={label} role="img" aria-label={label}>
      {src ? <img src={src} alt="" /> : initials(name || login)}
    </span>
  );
}

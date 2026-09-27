import { initial, type Member, memberLabel, ROLE_LETTER } from "../model.ts";

export function Avatar({ role, name, activity, state, size }: { role: string; name?: string; activity?: string; state?: string; size?: "md" | "lg" | "solo" }) {
  const cls = ["av", `r-${role}`, size ?? "", activity === "working" ? "working" : "", activity === "error" ? "error" : "", state === "stopped" ? "stopped" : "", state === "lost" ? "lost" : ""].filter(Boolean).join(" ");
  const person = role === "human" || role === "orchestrator" || !name;
  const label = `${person ? (name ?? role) : memberLabel(name, role)}${activity === "working" ? " — работает" : activity === "error" ? " — ошибка" : ""}`;
  return (
    <span className={cls} title={label} role="img" aria-label={label}>
      {person ? (ROLE_LETTER[role] ?? role.slice(0, 1).toUpperCase()) : initial(name, role)}
    </span>
  );
}

export function Avatars({ members }: { members: Member[] }) {
  return (
    <span className="avatars">
      {members.map((m) => (
        <Avatar key={m.name} role={m.role} name={m.name} activity={m.activity} state={m.state} />
      ))}
    </span>
  );
}

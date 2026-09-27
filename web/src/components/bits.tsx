import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type Member, ROLE_LETTER } from "../lib/model.ts";
import { Icon } from "./icons.tsx";

export function Avatar({ role, name, activity, state, size }: { role: string; name?: string; activity?: string; state?: string; size?: "md" | "lg" | "solo" }) {
  const cls = ["av", `r-${role}`, size ?? "", activity === "working" ? "working" : "", activity === "error" ? "error" : "", state === "stopped" ? "stopped" : ""].filter(Boolean).join(" ");
  const label = `${name ?? role}${activity === "working" ? " — работает" : activity === "error" ? " — ошибка" : ""}`;
  return (
    <span className={cls} title={label} role="img" aria-label={label}>
      {ROLE_LETTER[role] ?? role.slice(0, 1).toUpperCase()}
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

export function StageBars({ stage, amber, big }: { stage: number; amber?: boolean; big?: boolean }) {
  return (
    <span className={`bars${amber ? " amber" : ""}${big ? " big" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={6} aria-valuenow={stage}>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={i < stage ? "on" : ""} />
      ))}
    </span>
  );
}

export function Labels({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <span className="labels">
      {labels.map((l) => (
        <span key={l} className="pill">
          {l}
        </span>
      ))}
    </span>
  );
}

/** Re-render every `ms` so relative times stay fresh. */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

// ------------------------------------------------------------------ toasts

type Toast = { id: number; text: ReactNode; kind: "ok" | "error" };
const ToastCtx = createContext<(text: ReactNode, kind?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | undefined>();
  const show = useCallback((text: ReactNode, kind: "ok" | "error" = "ok") => {
    const id = Date.now();
    setToast({ id, text, kind });
    setTimeout(() => setToast((t) => (t?.id === id ? undefined : t)), kind === "error" ? 5000 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast${toast.kind === "error" ? " error" : ""}`} role="status">
          {toast.kind === "ok" && <Icon.check size={13} style={{ color: "var(--green)" }} />}
          {toast.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ modal shell

export function Modal({ label, onClose, wide, children }: { label: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

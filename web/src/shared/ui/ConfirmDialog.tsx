import { type ReactNode, useState } from "react";
import { Modal } from "./Modal.tsx";

/** Confirmation for destructive actions, with an optional extra checkbox. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  option,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  option?: string;
  busy?: boolean;
  onConfirm: (optionChecked: boolean) => void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <Modal label={title} onClose={onClose}>
      <div className="mh">{title}</div>
      <div className="mb">
        <div style={{ lineHeight: 1.55, color: "var(--text-2)" }}>{children}</div>
        {option && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text-2)" }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
            {option}
          </label>
        )}
      </div>
      <div className="mf">
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={() => onConfirm(checked)} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

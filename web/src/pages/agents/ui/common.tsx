// Parts shared by the tabs of the Agents page: actions with a toast, problems,
// the raw file editor and the history of an item with rollback.

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { agentKeys, type ConfigChange, type ConfigKind, type Problem, useConfigHistory, useDeleteConfig, useSaveConfig } from "@/entities/agent-config";
import { ApiError } from "@/shared/api";
import { timeAgo } from "@/shared/lib";
import { Icon, Modal, useToast } from "@/shared/ui";

/** Run an action; a failure becomes an error toast, success an optional one. */
export function useAction() {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  };
}

export function Problems({ items }: { items: Problem[] }) {
  if (!items.length) return null;
  return (
    <ul className="ag-problems" aria-label="Проблемы">
      {items.map((p, i) => (
        <li key={i} className={p.level}>
          <b>{p.level === "error" ? "Ошибка" : "Предупреждение"}</b>
          <span>
            {p.message}
            {p.path ? <span className="muted"> · {p.path}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="ag-section">
      <div className="ag-section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "amber" | "green" | "red" | "muted" }) {
  return <span className={`ag-badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

/**
 * Edit a configuration file as text. The save is refused when the file changed
 * since it was opened (409) or when the change is invalid (422): the message
 * says what to do.
 */
export function FileEditor({
  kind,
  id,
  title,
  hint,
  initial,
  baseHash,
  onClose,
  onSaved,
}: {
  kind: ConfigKind;
  id: string;
  title: string;
  hint?: ReactNode;
  initial: string;
  baseHash: string | undefined;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<{ text: string; stale: boolean }>();
  const [busy, setBusy] = useState(false);
  const save = useSaveConfig();
  const qc = useQueryClient();
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      const out = await save(kind, id, { content: text }, baseHash);
      const warn = out.problems.filter((p) => p.level === "warning");
      toast(warn.length ? `Сохранено, есть предупреждения: ${warn.map((p) => p.message).join("; ")}` : "Сохранено");
      onSaved?.();
      onClose();
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), stale: e instanceof ApiError && e.status === 409 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal label={title} onClose={onClose} wide>
      <div className="mh">
        <Icon.file size={13} />
        {title}
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
          <Icon.close />
        </button>
      </div>
      <div className="mb">
        {hint && <div className="muted ag-hint">{hint}</div>}
        <textarea className="mono code-edit" rows={24} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Содержимое файла" />
        {error && (
          <div className="auth-error" role="alert">
            {error.text}
            {error.stale && (
              <>
                {" "}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void qc.invalidateQueries({ queryKey: agentKeys.all });
                    onClose();
                  }}
                >
                  Закрыть и открыть заново
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="mf">
        Файл проверяется перед сохранением
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}

/** Which kind and id a history item (`role:x`, `team:x`, `skill:x`, `mcp`) is about. */
export function itemTarget(item: string): { kind: ConfigKind; id: string; label: string } {
  const [prefix, id = ""] = item.split(":");
  if (prefix === "role") return { kind: "role", id, label: `роль ${id}` };
  if (prefix === "team") return { kind: "template", id, label: `шаблон ${id}` };
  if (prefix === "skill") return { kind: "skill", id, label: `навык ${id}` };
  return { kind: "mcp", id: "", label: "MCP-подключения" };
}

/** Changes of one item (or all of them) with a way back to any earlier version. */
export function History({ item, admin }: { item?: string; admin: boolean }) {
  const history = useConfigHistory(item, admin);
  const [open, setOpen] = useState<number>();
  const save = useSaveConfig();
  const remove = useDeleteConfig();
  const act = useAction();
  if (!admin) return null;
  const restore = (c: ConfigChange) => {
    const t = itemTarget(c.item);
    if (c.before === undefined) {
      if (t.kind === "mcp") return;
      void act(() => remove(t.kind as Exclude<ConfigKind, "mcp">, t.id), "Файл удалён, как было до этой правки");
    } else {
      void act(() => save(t.kind, t.id, { content: c.before }, undefined), "Вернули версию до этой правки");
    }
  };
  if (!history.data?.length) return <p className="muted ag-empty">{history.isPending ? "Загрузка…" : "Правок через веб пока не было."}</p>;
  return (
    <ol className="ag-history">
      {history.data.map((c) => (
        <li key={c.id}>
          <button type="button" className="ag-history-row" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? undefined : c.id)}>
            <span className="who">{c.user}</span>
            <span className="what">
              {c.before === undefined ? "создал" : c.after === undefined ? "удалил" : "изменил"} <span className="mono">{c.path}</span>
              {!item && <span className="muted"> · {itemTarget(c.item).label}</span>}
            </span>
            <span className="when">{timeAgo(c.at)}</span>
          </button>
          {open === c.id && (
            <div className="ag-history-body">
              <div className="compare">
                <div>
                  <div className="hd">До</div>
                  <pre className="bd view">{c.before ?? "— файла не было —"}</pre>
                </div>
                <div>
                  <div className="hd">После</div>
                  <pre className="bd view">{c.after ?? "— файл удалён —"}</pre>
                </div>
              </div>
              {!(c.before === undefined && itemTarget(c.item).kind === "mcp") && (
                <button type="button" className="btn" onClick={() => restore(c)}>
                  Вернуть версию до этой правки
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

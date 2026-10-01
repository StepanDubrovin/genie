import { useState } from "react";
import "./ChipInput.css";

/**
 * A list of short values as chips: × removes one, a new one is typed at the
 * end and added with + or Enter (a comma too). Backspace in the empty box
 * removes the last chip. Repeats are ignored.
 */
export function ChipInput({
  id,
  values,
  onChange,
  placeholder,
  mono,
  suggestions,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  mono?: boolean;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  const list = id && suggestions?.length ? `${id}-options` : undefined;
  return (
    <div className={`chips${mono ? " mono" : ""}`}>
      {values.map((v) => (
        <span key={v} className="chip">
          {v}
          <button type="button" aria-label={`Убрать ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        list={list}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={add}
      />
      {list && (
        <datalist id={list}>
          {suggestions!
            .filter((s) => !values.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
      <button type="button" className={`chips-add${draft.trim() ? " on" : ""}`} aria-label="Добавить" onClick={add} disabled={!draft.trim()}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
    </div>
  );
}

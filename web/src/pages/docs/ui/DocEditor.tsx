// DocEditor — the page editor (mockup 6): frontmatter as a validated form,
// Markdown textarea with a line gutter and a live preview side by side.
// `read().content` is the body without frontmatter, so the form is serialized
// back into `---…---` + body on save.

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { DocFields, DocReadResult, DocStatus, DocType } from "@/entities/doc";
import {
  diagnosticText,
  DOC_STATUS_NAME,
  DOC_STATUSES,
  DOC_TYPES,
  DocBody,
  DocSaveError,
  docCrumbs,
  fieldsFromPage,
  isIsoDate,
  serializeDoc,
  useDocPage,
  useSaveDoc,
} from "@/entities/doc";
import { plural } from "@/shared/lib";
import { Icon } from "@/shared/ui";

/** Minimal chip list editor for `tags`, `paths` and `related`. */
function Chips({ value, onChange, placeholder, mono }: { value: string[]; onChange: (next: string[]) => void; placeholder: string; mono?: boolean }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const item = raw.trim().replace(/,$/, "");
    if (!item) return;
    if (!value.includes(item)) onChange([...value, item]);
    setDraft("");
  };
  return (
    <div className={`doc-chips${mono ? " mono" : ""}`}>
      {value.map((item) => (
        <span className="doc-chip" key={item}>
          {item}
          <button type="button" onClick={() => onChange(value.filter((v) => v !== item))} aria-label={`Убрать ${item}`}>
            <Icon.close size={9} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => add(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

function lineCount(text: string): number {
  return text.replace(/\r/g, "").split("\n").length;
}

export function DocEditor({ path, pages, onClose, onSaved }: { path: string; pages: { path: string; title: string }[]; onClose: () => void; onSaved: (path: string) => void }) {
  const pageQ = useDocPage(path);
  const save = useSaveDoc();
  const [fields, setFields] = useState<DocFields | null>(null);
  const [body, setBody] = useState("");
  const [initial, setInitial] = useState<{ fields: DocFields; body: string } | null>(null);
  const [serverDiags, setServerDiags] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const loadedFor = useRef<string | undefined>(undefined);

  const page: DocReadResult | undefined = pageQ.data;
  useEffect(() => {
    if (!page || loadedFor.current === page.path) return;
    loadedFor.current = page.path;
    const next = fieldsFromPage(page);
    setFields(next);
    setInitial({ fields: next, body: page.content });
    setBody(page.content);
    setServerDiags([]);
    setSaveError(null);
  }, [page]);

  const title = pages.find((p) => p.path === path)?.title ?? page?.title ?? path;
  const errors = useMemo(() => {
    if (!fields) return [];
    const out: { field: string; message: string }[] = [];
    if (!fields.title.trim()) out.push({ field: "title", message: "Нужно название страницы" });
    if (fields.verified.trim() && !isIsoDate(fields.verified.trim())) out.push({ field: "verified", message: "Нужна дата ГГГГ-ММ-ДД" });
    return out;
  }, [fields]);
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  const dirty = !!fields && !!initial && (body !== initial.body || JSON.stringify(fields) !== JSON.stringify(initial.fields));
  const changedLines = initial && body !== initial.body ? Math.abs(lineCount(body) - lineCount(initial.body)) : 0;

  const trackCaret = () => {
    const area = areaRef.current;
    if (!area) return;
    const upto = body.slice(0, area.selectionStart);
    const line = upto.split("\n").length;
    const column = area.selectionStart - (upto.lastIndexOf("\n") + 1) + 1;
    setCaret({ line, column });
  };

  const submit = async () => {
    if (!fields || errors.length) return;
    if (!body.trim()) {
      setSaveError("Содержимое страницы пустое — сервер отклонит такое сохранение");
      return;
    }
    setSaveError(null);
    setServerDiags([]);
    try {
      await save.mutateAsync({ path, content: serializeDoc(fields, body), mode: "update" });
      onSaved(path);
    } catch (error) {
      if (error instanceof DocSaveError) {
        setServerDiags(error.diagnostics);
        setSaveError(error.diagnostics.length ? "Frontmatter не принят сервером — исправьте поля ниже" : error.message);
      } else {
        setSaveError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void submit();
    }
  };

  if (pageQ.isPending || !fields) return <div className="docs-content single"><div className="doc-editor-wait muted">Загрузка страницы…</div></div>;
  if (pageQ.isError) return <div className="docs-content single"><div className="doc-editor-wait muted">Не удалось открыть страницу: {pageQ.error.message}</div></div>;

  const update = <K extends keyof DocFields>(key: K, value: DocFields[K]) => setFields({ ...fields, [key]: value });
  const lines = lineCount(body);

  return (
    <div className="docs-editor" onKeyDown={onKeyDown}>
      <header className="docs-topbar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Вернуться к странице">
          <Icon.back size={15} />
        </button>
        <nav className="doc-crumbs mono" aria-label="Путь страницы">
          {docCrumbs(path).map((part, i) => (
            <span key={`${part}-${i}`}>
              {i > 0 && <span className="sep">/</span>}
              {part}
            </span>
          ))}
        </nav>
        {dirty ? (
          <span className="doc-chip-state" title="Изменения не сохранены">
            <i className="dot" />
            Не сохранено{changedLines > 0 ? ` · ${changedLines} ${plural(changedLines, "строка", "строки", "строк")} изменения` : ""}
          </span>
        ) : (
          <span className="doc-chip-state clean">
            <Icon.check size={11} />
            Сохранено
          </span>
        )}
        <span className="grow" />
        {errors.length > 0 && (
          <span className="doc-chip-state error">
            {errors.length} {plural(errors.length, "поле", "поля", "полей")} с ошибкой
          </span>
        )}
        <Link className="btn" to={`/docs?page=${encodeURIComponent(path)}`}>
          Отмена
        </Link>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={save.isPending || errors.length > 0}>
          <Icon.check size={13} />
          {save.isPending ? "Сохраняю…" : "Сохранить"}
        </button>
      </header>

      {saveError && (
        <div className="doc-banner diag editor">
          <span>
            <b>{saveError}</b>
            {serverDiags.length > 0 && (
              <ul className="doc-banner-list">
                {serverDiags.map((raw) => (
                  <li key={raw} title={raw} className="mono">
                    {diagnosticText(raw)}
                  </li>
                ))}
              </ul>
            )}
          </span>
        </div>
      )}

      <div className="doc-form">
        <label className="doc-field span6">
          <span>title</span>
          <input className={errorFor("title") ? "bad" : ""} value={fields.title} onChange={(e) => update("title", e.target.value)} />
          {errorFor("title") && <em className="err">{errorFor("title")}</em>}
        </label>
        <label className="doc-field span2">
          <span>type</span>
          <select value={fields.type} onChange={(e) => update("type", e.target.value as DocType | "")}>
            <option value="">не указан</option>
            {DOC_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="doc-field span2">
          <span>status</span>
          <select value={fields.status} onChange={(e) => update("status", e.target.value as DocStatus | "")}>
            <option value="">не указан</option>
            {DOC_STATUSES.map((status) => (
              <option key={status} value={status}>
                {DOC_STATUS_NAME[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="doc-field span2">
          <span>verified</span>
          <input
            className={errorFor("verified") ? "bad" : ""}
            placeholder="ГГГГ-ММ-ДД"
            value={fields.verified}
            onChange={(e) => update("verified", e.target.value)}
          />
          {errorFor("verified") && <em className="err">{errorFor("verified")}</em>}
        </label>

        <div className="doc-field span6">
          <span>tags</span>
          <Chips value={fields.tags} onChange={(next) => update("tags", next)} placeholder="+ тег" />
        </div>
        <div className="doc-field span4">
          <span>paths — код, который описывает страница</span>
          <Chips mono value={fields.paths} onChange={(next) => update("paths", next)} placeholder="+ glob" />
        </div>
        <div className="doc-field span2">
          <span>related</span>
          <Chips mono value={fields.related} onChange={(next) => update("related", next)} placeholder="+ id" />
        </div>
      </div>

      <div className="doc-split">
        <section className="doc-pane">
          <header className="doc-pane-head">
            <span>MARKDOWN</span>
            <span className="mono muted">
              стр. {caret.line}, стлб. {caret.column}
            </span>
          </header>
          <div className="doc-edit-area">
            <div className="doc-gutter" ref={gutterRef} aria-hidden>
              {Array.from({ length: lines }, (_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <textarea
              ref={areaRef}
              className="doc-textarea"
              aria-label="Markdown страницы"
              spellCheck={false}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                requestAnimationFrame(trackCaret);
              }}
              onKeyUp={trackCaret}
              onClick={trackCaret}
              onSelect={trackCaret}
              onScroll={() => {
                if (gutterRef.current && areaRef.current) gutterRef.current.scrollTop = areaRef.current.scrollTop;
              }}
            />
          </div>
        </section>
        <section className="doc-pane">
          <header className="doc-pane-head">
            <span>ПРЕДПРОСМОТР</span>
            <span className="muted mono">{title}</span>
          </header>
          <div className="doc-preview scroll">
            <DocBody text={body} empty="Пусто" />
          </div>
        </section>
      </div>
    </div>
  );
}

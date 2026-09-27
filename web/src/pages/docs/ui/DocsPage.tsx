// DocsPage — `/docs` and `/docs/edit`. Owns the URL state (page, q, new), the
// column layout (tree | page | aside, search, editor, empty state), the mobile
// drawer and the docs change signal.

import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  BookIcon,
  DocsTree,
  fieldsFromPage,
  serializeDoc,
  todayIso,
  useDebounced,
  useDocPage,
  useDocSearch,
  useDocsTree,
  useDocsVersion,
  useSaveDoc,
} from "@/entities/doc";
import { useToast, Icon } from "@/shared/ui";
import { DocEditor } from "./DocEditor.tsx";
import { DocSearchList } from "./DocSearchList.tsx";
import { DocView } from "./DocView.tsx";
import { NewDocDialog } from "./NewDocDialog.tsx";

export function DocsPage() {
  const [sp, setSp] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const mode = /\/edit\/?$/.test(location.pathname) ? "edit" : "view";

  const tree = useDocsTree();
  useDocsVersion();
  const pages = useMemo(() => tree.data?.pages ?? [], [tree.data]);

  const pagePath = sp.get("page") ?? undefined;
  const q = sp.get("q") ?? "";
  const newKind = sp.get("new");
  const searchMode = q.trim().length > 0;
  const debouncedQ = useDebounced(q, 220);
  const search = useDocSearch(debouncedQ, searchMode);

  const activePath = pagePath ?? pages[0]?.path;
  const pageQ = useDocPage(mode === "view" ? activePath : undefined);
  const save = useSaveDoc();

  const [drawer, setDrawer] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  const setParam = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(sp);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSp(next, { replace });
  };

  const openPage = (path: string) => setParam({ page: path, new: null });
  const openEditor = (path: string) => navigate(`/docs/edit?page=${encodeURIComponent(path)}`);
  const closeEditor = (path: string) => navigate(`/docs?page=${encodeURIComponent(path)}`);

  // `/` focuses the docs filter/search (the shell's handler only knows the task search).
  useEffect(() => {
    if (mode === "edit") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const markVerified = async () => {
    const page = pageQ.data;
    if (!page) return;
    try {
      await save.mutateAsync({ path: page.path, content: serializeDoc({ ...fieldsFromPage(page), verified: todayIso() }, page.content), mode: "update" });
      toast(`${page.path}: проверена ${todayIso()}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  if (mode === "edit") {
    if (!pagePath) return <Navigate to="/docs" replace />;
    return (
      <main className="main docs-main">
        <DocEditor
          path={pagePath}
          pages={pages}
          onClose={() => closeEditor(pagePath)}
          onSaved={(path) => {
            toast("Страница сохранена");
            closeEditor(path);
          }}
        />
      </main>
    );
  }

  const loading = tree.isPending;
  const empty = !loading && !tree.isError && pages.length === 0 && !searchMode;
  const results = search.data?.results ?? [];
  const grid = empty ? "empty" : searchMode ? "docs-search-mode" : "view";
  const showPage = !!pageQ.data;

  return (
    <main className="main docs-main">
      <div className={`docs-grid ${grid}`}>
        {!empty && (
          <div className="docs-tree-col">
            <header className="docs-col-head">
              <button type="button" className="icon-btn m-only" onClick={() => setDrawer(true)} aria-label="Открыть дерево документации">
                <Icon.list size={15} />
              </button>
              <h1>Документация</h1>
              {searchMode ? <span className="doc-col-tag">поиск</span> : <span className="count">{loading ? "" : pages.length}</span>}
              <span className="grow" />
              <button type="button" className="btn ghost" onClick={() => setParam({ new: "page" })}>
                <Icon.plus size={12} />
                Страница
              </button>
            </header>

            <label className="docs-filter">
              <Icon.search size={13} />
              <input
                ref={filterRef}
                value={q}
                aria-label="Фильтр и поиск по тексту"
                placeholder={searchMode ? "Поиск по документации" : "Фильтр и поиск по тексту"}
                onChange={(event) => setParam({ q: event.target.value }, true)}
                onKeyDown={(event) => {
                  if (!searchMode) return;
                  const index = results.findIndex((r) => r.path === activePath);
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const next = Math.max(0, Math.min(results.length - 1, (index < 0 ? -1 : index) + (event.key === "ArrowDown" ? 1 : -1)));
                    if (results[next]) setParam({ page: results[next].path }, true);
                  } else if (event.key === "Enter" && results[index]) {
                    event.preventDefault();
                    openPage(results[index].path);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setParam({ q: null });
                  }
                }}
              />
              {q ? (
                <button type="button" className="icon-btn" onClick={() => setParam({ q: null })} aria-label="Очистить поиск">
                  <Icon.close size={12} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </label>

            {loading ? (
              <div className="doc-tree-empty muted">Загрузка…</div>
            ) : tree.isError ? (
              <div className="doc-tree-empty muted">Не удалось загрузить документацию: {tree.error.message}</div>
            ) : searchMode ? (
              <DocSearchList
                query={q}
                results={results}
                pending={search.isPending || debouncedQ !== q}
                error={search.error}
                selected={activePath}
                onOpen={openPage}
                onCreate={(title) => setParam({ new: "page", title, q: null })}
              />
            ) : (
              <DocsTree pages={pages} selected={activePath} onSelect={openPage} />
            )}
          </div>
        )}

        {empty ? (
          <div className="docs-content">
            <header className="docs-topbar">
              <h1>Документация</h1>
              <span className="muted">0 страниц</span>
            </header>
            <div className="doc-empty">
              <BookIcon size={26} />
              <b>В репозитории пока нет папки docs/</b>
              <p>
                Страницы — это Markdown-файлы в <span className="mono">docs/</span>, они коммитятся вместе с кодом. Укажите во frontmatter, какой код описывает страница, — genie
                подскажет, когда она могла устареть.
              </p>
              <div className="doc-empty-actions">
                <button type="button" className="btn primary" onClick={() => setParam({ new: "page" })}>
                  <Icon.plus size={13} />
                  Создать первую страницу
                </button>
                <button type="button" className="btn" onClick={() => setParam({ new: "note" })}>
                  Быстрая заметка
                </button>
              </div>
              <p className="muted">
                или в терминале: <span className="mono">genie docs note "…"</span>
              </p>
            </div>
          </div>
        ) : searchMode && !results.length ? (
          <div className="docs-content" />
        ) : pageQ.isPending && !showPage ? (
          <div className="docs-content">
            <div className="docs-view muted">Загрузка страницы…</div>
          </div>
        ) : pageQ.isError ? (
          <div className="docs-content">
            <div className="docs-view muted">Не удалось открыть страницу: {pageQ.error.message}</div>
          </div>
        ) : pageQ.data ? (
          <DocView
            page={pageQ.data}
            pages={pages}
            onOpen={openPage}
            onEdit={() => openEditor(pageQ.data!.path)}
            onMarkVerified={() => void markVerified()}
            onOpenTree={() => setDrawer(true)}
            hideAside={searchMode}
          />
        ) : (
          <div className="docs-content">
            <div className="docs-view muted">Выберите страницу в дереве слева.</div>
          </div>
        )}
      </div>

      {drawer && (
        <div className="docs-drawer-overlay" onMouseDown={(event) => event.target === event.currentTarget && setDrawer(false)}>
          <div className="docs-drawer" role="dialog" aria-modal="true" aria-label="Дерево документации">
            <div className="docs-drawer-grab" />
            <header className="docs-col-head">
              <h1>Документация</h1>
              <span className="count">{pages.length}</span>
              <span className="grow" />
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setDrawer(false);
                  setParam({ new: "page" });
                }}
              >
                <Icon.plus size={12} />
                Страница
              </button>
            </header>
            <label className="docs-filter">
              <Icon.search size={13} />
              <input value={drawerFilter} aria-label="Фильтр дерева" placeholder="Фильтр и поиск" onChange={(event) => setDrawerFilter(event.target.value)} autoFocus />
            </label>
            <div className="docs-drawer-tree scroll">
              <DocsTree
                pages={pages}
                selected={activePath}
                onSelect={(path) => {
                  openPage(path);
                  setDrawer(false);
                }}
                filter={drawerFilter}
                variant="flat"
                legend={false}
              />
            </div>
          </div>
        </div>
      )}

      {newKind === "page" || newKind === "note" ? (
        <NewDocDialog
          initialKind={newKind}
          initialTitle={sp.get("title") ?? ""}
          onClose={() => setParam({ new: null })}
          onCreated={(path) => {
            setParam({ new: null }, true);
            openEditor(path);
          }}
        />
      ) : null}

    </main>
  );
}

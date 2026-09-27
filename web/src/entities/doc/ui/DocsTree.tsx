// DocsTree — the reusable docs navigation (mockup screen 13): folders from path
// segments, page rows with type/status/diagnostic marks, an optional text filter
// and the status legend. `flat` renders the mobile-drawer variant (screen 12).

import { useMemo, useState } from "react";
import type { DocPage } from "../model.ts";
import { docStatusText, DocLegend, DocMarks, DocTypeBadge } from "./DocBadges.tsx";
import { CaretIcon, DocFileIcon, FolderIcon, FolderOpenIcon } from "./icons.tsx";

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  pages: DocPage[];
}

function buildTree(pages: DocPage[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], pages: [] };
  for (const page of pages) {
    const segments = page.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const path = `${segments.slice(0, i + 1).join("/")}/`;
      let next = node.folders.find((f) => f.path === path);
      if (!next) {
        next = { name: segments[i], path, folders: [], pages: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.pages.push(page);
  }
  const order = (node: Folder): void => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    node.pages.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    node.folders.forEach(order);
  };
  order(root);
  return root;
}

function countPages(node: Folder): number {
  return node.pages.length + node.folders.reduce((n, f) => n + countPages(f), 0);
}

function flatByFolder(root: Folder): { folder: string; pages: DocPage[] }[] {
  const groups: { folder: string; pages: DocPage[] }[] = [];
  const walk = (node: Folder): void => {
    if (node.path) groups.push({ folder: node.path, pages: node.pages });
    node.folders.forEach(walk);
    if (!node.path && node.pages.length) groups.push({ folder: "", pages: node.pages });
  };
  walk(root);
  return groups;
}

function Row({ page, selected, onSelect, flat }: { page: DocPage; selected: string | undefined; onSelect: (path: string) => void; flat: boolean }) {
  const status = flat ? docStatusText(page) : undefined;
  return (
    <button
      type="button"
      className={`doc-row${page.path === selected ? " on" : ""}`}
      onClick={() => onSelect(page.path)}
      title={page.path}
    >
      {!flat && <DocFileIcon size={13} className="doc-row-ic" />}
      <span className="nm">{page.title || page.path}</span>
      {!flat && <DocTypeBadge type={page.type} />}
      {flat ? <span className={`doc-flat-status ${status!.cls}`}>{status!.text}</span> : <DocMarks page={page} />}
    </button>
  );
}

function FolderNode({ folder, depth, selected, onSelect, forceOpen }: { folder: Folder; depth: number; selected: string | undefined; onSelect: (path: string) => void; forceOpen: boolean }) {
  const [open, setOpen] = useState(true);
  const expanded = forceOpen || open;
  const count = countPages(folder);
  return (
    <div className="doc-folder">
      <button type="button" className="doc-folder-head" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => setOpen((v) => !v)} aria-expanded={expanded}>
        <CaretIcon size={11} className={`doc-caret${expanded ? " open" : ""}`} />
        {expanded ? <FolderOpenIcon size={13} /> : <FolderIcon size={13} />}
        <span className="nm">{folder.name}/</span>
        <span className="n">{count}</span>
      </button>
      {expanded && (
        <div>
          {folder.folders.map((f) => (
            <FolderNode key={f.path} folder={f} depth={depth + 1} selected={selected} onSelect={onSelect} forceOpen={forceOpen} />
          ))}
          {folder.pages.map((p) => (
            <div key={p.path} style={{ paddingLeft: depth * 12 }}>
              <Row page={p} selected={selected} onSelect={onSelect} flat={false} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocsTree({
  pages,
  selected,
  onSelect,
  filter = "",
  variant = "tree",
  legend = true,
}: {
  pages: DocPage[];
  selected?: string;
  onSelect: (path: string) => void;
  filter?: string;
  variant?: "tree" | "flat";
  legend?: boolean;
}) {
  const query = filter.trim().toLowerCase();
  const shown = useMemo(
    () => (query ? pages.filter((p) => p.title.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)) : pages),
    [pages, query],
  );
  const root = useMemo(() => buildTree(shown), [shown]);

  if (!shown.length) {
    return (
      <div className="doc-tree-empty">
        <span className="muted">{pages.length ? "Ничего не найдено" : "Страниц пока нет"}</span>
      </div>
    );
  }

  if (variant === "flat") {
    return (
      <div className="doc-tree flat">
        {flatByFolder(root).map((group) => (
          <div key={group.folder || "/"} className="doc-flat-group">
            {group.folder && <div className="doc-flat-folder">{group.folder}</div>}
            {group.pages.map((p) => (
              <Row key={p.path} page={p} selected={selected} onSelect={onSelect} flat />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="doc-tree">
      <div className="doc-tree-body">
        {root.folders.map((f) => (
          <FolderNode key={f.path} folder={f} depth={0} selected={selected} onSelect={onSelect} forceOpen={!!query} />
        ))}
        {root.pages.map((p) => (
          <Row key={p.path} page={p} selected={selected} onSelect={onSelect} flat={false} />
        ))}
      </div>
      {legend && <DocLegend />}
    </div>
  );
}

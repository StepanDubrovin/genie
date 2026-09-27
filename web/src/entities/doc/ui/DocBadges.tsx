// Doc badges: type / status / stale / diagnostics, plus the tree legend (D1).

import type { DocPage, DocStatus } from "../model.ts";
import { DOC_STATUS_NAME, DOC_TYPE_NAME, DOC_TYPE_SHORT } from "../model.ts";
import { DeprecatedIcon, DiagIcon, DraftIcon, OkIcon, StaleIcon, UnknownIcon } from "./icons.tsx";

export function DocTypeBadge({ type, long }: { type: DocPage["type"]; long?: boolean }) {
  return (
    <span className={`doc-type${type ? ` t-${type}` : ""}`} title={type ? `Тип: ${DOC_TYPE_NAME[type]}` : "Тип во frontmatter не указан"}>
      {type ? (long ? type : DOC_TYPE_SHORT[type]) : "md"}
    </span>
  );
}

export function DocStatusIcon({ status, size = 12 }: { status: DocStatus | null; size?: number }) {
  if (status === "current") return <OkIcon size={size} className="doc-ic ok" aria-hidden />;
  if (status === "draft") return <DraftIcon size={size} className="doc-ic draft" aria-hidden />;
  if (status === "deprecated") return <DeprecatedIcon size={size} className="doc-ic deprecated" aria-hidden />;
  return <UnknownIcon size={size} className="doc-ic none" aria-hidden />;
}

export function DocStatusBadge({ status }: { status: DocStatus | null }) {
  const name = status ? DOC_STATUS_NAME[status] : "Статус не указан";
  return (
    <span className={`doc-status s-${status ?? "none"}`} title={name}>
      <DocStatusIcon status={status} />
      {name}
    </span>
  );
}

export function DocStaleIcon({ size = 12 }: { size?: number }) {
  return <StaleIcon size={size} className="doc-ic stale" aria-hidden />;
}

export function DocDiagIcon({ size = 12 }: { size?: number }) {
  return <DiagIcon size={size} className="doc-ic diag" aria-hidden />;
}

export function DocStaleBadge({ count }: { count?: number }) {
  return (
    <span className="doc-status s-stale" title="Файлы кода под `paths` менялись после даты `verified`">
      <DocStaleIcon />
      Возможно устарела{count && count > 1 ? ` · ${count}` : ""}
    </span>
  );
}

export function DocDiagBadge({ count }: { count?: number }) {
  return (
    <span className="doc-status s-diag" title="Frontmatter прочитан с ошибками, использованы значения по умолчанию">
      <DocDiagIcon />
      Ошибка frontmatter{count && count > 1 ? ` · ${count}` : ""}
    </span>
  );
}

/** Tree/search marks: diagnostics win over staleness, as in the mockups. */
export function DocMarks({ page, size = 12 }: { page: Pick<DocPage, "status" | "stale" | "diagnostics">; size?: number }) {
  return (
    <span className="doc-marks">
      <DocStatusIcon status={page.status} size={size} />
      {page.stale && <DocStaleIcon size={size} />}
      {page.diagnostics.length > 0 && <DocDiagIcon size={size} />}
    </span>
  );
}

/** Status text used by the mobile drawer's flat tree. */
export function docStatusText(page: Pick<DocPage, "status" | "stale" | "diagnostics">): { text: string; cls: string } {
  if (page.diagnostics.length) return { text: "ошибка", cls: "diag" };
  if (page.status === "draft") return { text: "черновик", cls: "draft" };
  if (page.stale) return { text: "устарела?", cls: "stale" };
  if (page.status === "current") return { text: "актуальна", cls: "ok" };
  if (page.status === "deprecated") return { text: "устарела", cls: "deprecated" };
  return { text: "без статуса", cls: "none" };
}

/** The four-item legend pinned to the bottom of the tree column. */
export function DocLegend() {
  return (
    <div className="doc-legend">
      <span className="doc-status s-current">
        <DocStatusIcon status="current" /> {DOC_STATUS_NAME.current}
      </span>
      <span className="doc-status s-draft">
        <DocStatusIcon status="draft" /> {DOC_STATUS_NAME.draft}
      </span>
      <span className="doc-status s-stale">
        <DocStaleIcon />
        <span>
          Возможно
          <br />
          устарела
        </span>
      </span>
      <span className="doc-status s-diag">
        <DocDiagIcon />
        Ошибка frontmatter
      </span>
    </div>
  );
}

// Docs icons. Local to the doc entity: `shared/ui/icons.tsx` belongs to another
// task, so this module only reuses its `stroke` helper for a consistent look.

import { stroke, type IconProps } from "@/shared/ui";

/** Open book — the "Документация" nav entry and the empty state. */
export const BookIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <path d="M8 3.6C6.6 2.6 4.9 2.2 2.5 2.4v9.8c2.4-.2 4.1.2 5.5 1.2 1.4-1 3.1-1.4 5.5-1.2V2.4c-2.4-.2-4.1.2-5.5 1.2Z" />
    <path d="M8 3.6v9.8" />
  </svg>
);

/** Markdown page row. */
export const DocFileIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.4}>
    <path d="M4 1.8h4.6L12 5.2v9H4z" />
    <path d="M8.4 1.8v3.5H12" />
  </svg>
);

export const FolderIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.4}>
    <path d="M2 3.6h3.6l1.2 1.5H14v7.3H2z" />
  </svg>
);

export const FolderOpenIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.4}>
    <path d="M2 3.6h3.6l1.2 1.5H14v7.3H2z" />
    <path d="M2 7.6h11.6" />
  </svg>
);

/** Caret for a collapsed / expanded folder. */
export const CaretIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.8}>
    <path d="M6 3.5l5 4.5-5 4.5" />
  </svg>
);

/** Amber triangle — "possibly stale". */
export const StaleIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <path d="M8 2.2 14.4 13H1.6z" />
    <path d="M8 6.4v3" />
    <path d="M8 11.2h.01" />
  </svg>
);

/** Red circle — frontmatter diagnostics. */
export const DiagIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.6}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3.6M8 10.8h.01" />
  </svg>
);

/** Green circle-check — status `current`. */
export const OkIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.6}>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.6 8.3l1.7 1.7 3.1-3.6" />
  </svg>
);

/** Dashed circle — status `draft`. */
export const DraftIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <circle cx="8" cy="8" r="5.6" strokeDasharray="2.6 2.4" />
  </svg>
);

/** Circle-minus — status `deprecated`. */
export const DeprecatedIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.6 8h4.8" />
  </svg>
);

/** Hollow circle — no status in frontmatter. */
export const UnknownIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <circle cx="8" cy="8" r="5.6" strokeDasharray="1.6 2.4" />
  </svg>
);

export const BacklinkIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <path d="M13 6.5a3 3 0 0 0-3-3H3M5.5 1.5 2.5 3.5l3 2" />
    <path d="M3 9.5a3 3 0 0 0 3 3h7M10.5 14.5l3-2-3-2" />
  </svg>
);

export const PathsIcon = ({ size, ...p }: IconProps) => (
  <svg {...stroke(size, p)} strokeWidth={1.5}>
    <path d="M5 2.5v11M11 2.5v11M2.5 5.5h11M2.5 10.5h11" />
  </svg>
);

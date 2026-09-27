import type { SVGProps } from "react";
import { PRIORITY_NAME, type Status, STATUS_NAME } from "../lib/model.ts";

const BG = "#0e0f11";

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", role: "img", "aria-label": STATUS_NAME[status] } as const;
  switch (status) {
    case "inbox":
      return (
        <svg {...common} stroke="#8b8f98" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M2 9h3l1 2h4l1-2h3" />
          <path d="M3.6 3h8.8L14 9v4H2V9z" />
        </svg>
      );
    case "draft":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#6b6f78" strokeWidth="1.6" strokeDasharray="2.4 2" />
        </svg>
      );
    case "refining":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#9b8afb" strokeWidth="1.6" strokeDasharray="2.4 2" />
        </svg>
      );
    case "ready":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#c9cbd1" strokeWidth="1.6" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#f2c94c" strokeWidth="1.6" />
          <path d="M8 4a4 4 0 0 1 0 8z" fill="#f2c94c" />
        </svg>
      );
    case "changes_requested":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#f0a04b" strokeWidth="1.6" />
          <path d="M10.5 6.5A3 3 0 1 0 11 9" stroke="#f0a04b" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M11.3 4.6v2.3H9" stroke="#f0a04b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "review":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#4cb782" strokeWidth="1.6" />
          <path d="M8 4a4 4 0 1 1-4 4h4z" fill="#4cb782" />
        </svg>
      );
    case "approved":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#4cb782" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="4" fill="#4cb782" />
        </svg>
      );
    case "needs_owner":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.3" fill="#f0a04b" />
          <path d="M8 4.6v4.2" stroke={BG} strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="8" cy="11.2" r="0.95" fill={BG} />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.3" fill="#7c84f0" />
          <path d="M5.4 8.2l1.8 1.8 3.5-3.7" stroke={BG} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="#6b6f78" strokeWidth="1.6" />
          <path d="M6 6l4 4M10 6l-4 4" stroke="#6b6f78" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
}

export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  const label = PRIORITY_NAME[priority] ?? "";
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="#f0a04b" />
        <path d="M8 4.5v4.3" stroke={BG} strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r="0.95" fill={BG} />
      </svg>
    );
  }
  const n = priority === 1 ? 3 : priority === 2 ? 2 : priority === 3 ? 1 : 0;
  const c = (i: number) => (n >= i ? "#c9cbd1" : "#3a3d45");
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label}>
      <rect x="2" y="9" width="3" height="5" rx="1" fill={c(1)} />
      <rect x="6.5" y="6" width="3" height="8" rx="1" fill={c(2)} />
      <rect x="11" y="3" width="3" height="11" rx="1" fill={c(3)} />
    </svg>
  );
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
const stroke = (size = 14, p: IconProps) => ({ width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

export const Icon = {
  plus: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  close: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  ),
  search: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  ),
  list: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  ),
  board: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <rect x="2" y="2.5" width="3.2" height="11" rx="1" />
      <rect x="6.4" y="2.5" width="3.2" height="7" rx="1" />
      <rect x="10.8" y="2.5" width="3.2" height="9" rx="1" />
    </svg>
  ),
  file: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" />
      <path d="M9.5 1.5v3h3" />
    </svg>
  ),
  send: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.7}>
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </svg>
  ),
  chevron: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M6 3l5 5-5 5" />
    </svg>
  ),
  back: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M10 3L5 8l5 5" />
    </svg>
  ),
  menu: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  ),
  check: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.8}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  ),
  spark: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.2 2.2M10.4 10.4l2.2 2.2M12.6 3.4l-2.2 2.2M5.6 10.4l-2.2 2.2" />
    </svg>
  ),
};

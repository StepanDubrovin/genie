import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };
export const stroke = (size = 14, p: IconProps) => ({ width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

export const Icon = {
  restart: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 3v3h-3" />
    </svg>
  ),
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
  trash: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v5M9.2 6.5v5" />
    </svg>
  ),
  stop: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  ),
  userPlus: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5c.6-2.3 2.3-3.5 4.5-3.5s3.9 1.2 4.5 3.5M12.5 5v4M10.5 7h4" />
    </svg>
  ),
  spark: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.2 2.2M10.4 10.4l2.2 2.2M12.6 3.4l-2.2 2.2M5.6 10.4l-2.2 2.2" />
    </svg>
  ),
  /** genie mark: the logo in the sidebar and on public pages. */
  mark: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  bolt: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M9 1.8L3.5 9h4l-1 5.2L12.5 7h-4z" />
    </svg>
  ),
  bell: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" />
      <path d="M6.5 14h3" />
    </svg>
  ),
  proposal: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M4 2.5v6.5a3 3 0 0 0 3 3h5" />
      <path d="M10 9.5l2.5 2.5L10 14.5" />
    </svg>
  ),
  gear: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" />
    </svg>
  ),
  logout: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)} strokeWidth={1.5}>
      <path d="M6.5 2.5H3.5v11h3M10 5l3 3-3 3M13 8H6.5" />
    </svg>
  ),
  updown: ({ size, ...p }: IconProps) => (
    <svg {...stroke(size, p)}>
      <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
    </svg>
  ),
};

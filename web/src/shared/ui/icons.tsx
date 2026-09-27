import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };
export const stroke = (size = 14, p: IconProps) => ({ width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

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
};

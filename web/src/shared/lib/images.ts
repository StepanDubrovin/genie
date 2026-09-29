// Image references in team chat (`!image[artifact:G-7/3]`, `!image[docs/shot.png]`)
// and a cheap check whether a file name looks like a raster image. Pure: part of
// the browser bundle, tested with node.

/** Longest accepted `!image[...]` reference; longer ones stay plain text. */
const MAX_REF_CHARS = 400;

const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Cheap pre-filter for the UI: does the artifact name look like a raster image? */
export function isRasterFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && RASTER_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// ------------------------------------------------------------------ chat references
//
// Exactly one syntax, documented in README/docs and rendered only by the TeamView
// chat surface (never by the shared Markdown renderer):
//
//   !image[artifact:<TASK-ID>/<N>]   -> GET /api/tasks/<TASK-ID>/artifacts/<N>?raw=1
//   !image[<repo-relative-path>]     -> GET /api/images?path=<url-encoded path>
//
// Anything unrecognised stays literal text; a reference is only ever local, so no
// URL scheme is ever accepted (criterion #6).

export type ImageRef =
  | { kind: "artifact"; task: string; n: number; raw: string }
  | { kind: "path"; path: string; raw: string };

export type ImageSegment =
  | { type: "text"; text: string }
  | { type: "image"; ref: ImageRef; raw: string };

const IMAGE_REF = /!image\[([^\]\n]+)\]/g;
const ARTIFACT_REF = /^artifact:([A-Za-z0-9][A-Za-z0-9_-]*)\/(\d{1,7})$/;

/**
 * Normalize a repo-relative image path, or return undefined when it is not a
 * plain relative path. Rejects `..`, absolute paths, backslashes, NUL and any
 * `:` (so no URL scheme or Windows drive letter slips through). The server
 * additionally enforces containment and symlink rules.
 */
export function normalizeRepoImagePath(input: string): string | undefined {
  const value = input.trim();
  if (!value || value.length > MAX_REF_CHARS) return undefined;
  if (value.includes("\\") || value.includes("\0") || value.includes(":")) return undefined;
  if (value.startsWith("/")) return undefined;
  const pieces = value.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) return undefined;
  return pieces.join("/");
}

/** Parse a single `!image[...]` body, or return undefined when it must stay text. */
export function parseImageRef(raw: string): ImageRef | undefined {
  const ref = raw.trim();
  if (!ref || ref.length > MAX_REF_CHARS) return undefined;
  if (ref.startsWith("artifact:")) {
    const match = ARTIFACT_REF.exec(ref);
    if (!match) return undefined;
    return { kind: "artifact", task: match[1], n: Number(match[2]), raw: ref };
  }
  const path = normalizeRepoImagePath(ref);
  return path ? { kind: "path", path, raw: ref } : undefined;
}

/** Split message text into literal text and resolvable image references. */
export function parseImageRefs(text: string): ImageSegment[] {
  const out: ImageSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(IMAGE_REF)) {
    const at = match.index ?? 0;
    const ref = parseImageRef(match[1]);
    if (!ref) continue; // unrecognised: leave the literal token inside the surrounding text
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    out.push({ type: "image", ref, raw: match[0] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** URL an `!image` reference resolves to (local API only). */
export function imageRefSrc(ref: ImageRef): string {
  return ref.kind === "artifact"
    ? `/api/tasks/${encodeURIComponent(ref.task)}/artifacts/${ref.n}?raw=1`
    : `/api/images?path=${encodeURIComponent(ref.path)}`;
}

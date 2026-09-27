// Pure image helpers shared by three surfaces:
//   - the HTTP server (`src/web/server.ts`) for the artifact/repo image read paths,
//   - the pi extension (`src/extension/index.ts`) for the artifact_read image block,
//   - the web bundle (`web/src/pages/team/ui/TeamView.tsx`) for chat references.
//
// Keep this module dependency-free: it is imported into a browser bundle, so it
// must not touch `node:fs`, `node:path` or any other Node builtin.

/** Raster types the MVP previews. SVG is deliberately excluded (owner scope). */
export type RasterMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const RASTER_MIMES: readonly RasterMime[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Agent-facing cap: a raster artifact at or below this size is handed to the model as an image block. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Repo-file image serving cap for GET /api/images. */
export const MAX_REPO_IMAGE_BYTES = 10 * 1024 * 1024;
/** Longest accepted `!image[...]` reference; longer ones stay plain text. */
const MAX_REF_CHARS = 400;

const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function isRasterMime(value: string): value is RasterMime {
  return (RASTER_MIMES as readonly string[]).includes(value);
}

/**
 * Detect a supported raster type from the file's own leading bytes (magic
 * signature), never from a user-supplied name or extension.
 */
export function detectImageMime(bytes: Uint8Array): RasterMime | undefined {
  const starts = (offset: number, ...signature: number[]): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
  const ascii = (offset: number, text: string): boolean => starts(offset, ...Array.from(text, (c) => c.charCodeAt(0)));
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return undefined;
}

/** Cheap pre-filter for the UI: does the artifact name look like a raster image? */
export function isRasterFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && RASTER_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** True when an image may be handed to the model inline: supported type within the cap. */
export function shouldInlineImage(mime: RasterMime | undefined, size: number): boolean {
  return mime !== undefined && size <= MAX_INLINE_IMAGE_BYTES;
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

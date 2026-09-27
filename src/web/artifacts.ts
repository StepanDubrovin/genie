// Server-only helpers for the image read paths.
//
// Containment mirrors the docs write path (`src/docs/root.ts::isPathInside` +
// `src/web/docs.ts::passesThroughSymlink`): a served file must be lexically
// inside the project root, must not pass through any symlink, and must resolve
// (via realpath) back inside the root. Only raster magic-byte types are served.

import * as fs from "node:fs";
import * as path from "node:path";
import { isPathInside } from "../docs/root.ts";
import { passesThroughSymlink } from "./docs.ts";
import { detectImageMime, MAX_INLINE_IMAGE_BYTES, MAX_REPO_IMAGE_BYTES, normalizeRepoImagePath, shouldInlineImage, type RasterMime } from "./images.ts";

/** A repo-image read failure carrying the HTTP status the server should use. */
export class RepoImageError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RepoImageError";
    this.status = status;
  }
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Resolve a repo-relative image path to a canonical absolute file path.
 * Rejects `..`, absolute paths, backslashes/NUL/schemes, symlink escapes
 * (including an in-root symlink alias) and non-regular files.
 */
export function resolveRepoImage(root: string, input: string): string {
  const relative = normalizeRepoImagePath(input);
  if (!relative) throw new RepoImageError(400, `invalid image path: ${input}`);
  const canonicalRoot = realpath(root);
  const candidate = path.resolve(canonicalRoot, relative.split("/").join(path.sep));
  if (!isPathInside(canonicalRoot, candidate)) throw new RepoImageError(400, "image path escapes the project root");
  // Reject a path that reaches its target through a symlink, even when the
  // symlink itself stays inside the root (`passesThroughSymlink` walks upward).
  if (passesThroughSymlink(canonicalRoot, candidate)) throw new RepoImageError(400, "refusing to serve an image through a symlink");
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new RepoImageError(404, "image not found");
  }
  if (!isPathInside(canonicalRoot, real)) throw new RepoImageError(400, "image path resolves outside the project root");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new RepoImageError(404, "image not found");
  }
  if (!stat.isFile()) throw new RepoImageError(404, "image not found");
  return real;
}

/**
 * Read a contained repo image and detect its type from its own bytes.
 * Throws RepoImageError(400|404|413|415) for every rejection.
 */
export function readRepoImage(root: string, input: string): { bytes: Buffer; mime: RasterMime } {
  const file = resolveRepoImage(root, input);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new RepoImageError(404, "image not found");
  }
  if (bytes.byteLength > MAX_REPO_IMAGE_BYTES) throw new RepoImageError(413, `image is larger than ${MAX_REPO_IMAGE_BYTES} bytes`);
  const mime = detectImageMime(bytes);
  if (!mime) throw new RepoImageError(415, "unsupported image type");
  return { bytes, mime };
}

/** Content-Disposition for an inline preview, with a sanitized optional filename. */
export function inlineDisposition(name?: string): string {
  const safe = (name ?? "").replace(/[\r\n"]/g, "").trim();
  return safe ? `inline; filename="${safe}"` : "inline";
}

/** Text or image content block returned to the model by `artifact_read`. */
export type ArtifactReadBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Build the `artifact_read` content blocks: a supported raster image within the
 * inline cap is attached as an image block so the model sees the picture; any
 * other binary keeps the previous text-only result with an explicit note.
 */
export function artifactReadContent(input: { n: number; name: string; kind: string; content: Uint8Array; text: string | undefined }): ArtifactReadBlock[] {
  const { n, name, kind, content, text } = input;
  const header = `# artifact #${n} ${name} (${kind})`;
  const mime = detectImageMime(content);
  if (mime && shouldInlineImage(mime, content.byteLength)) {
    return [
      { type: "text", text: `${header}\n\nImage attached (${mime}, ${content.byteLength} bytes).` },
      { type: "image", data: Buffer.from(content).toString("base64"), mimeType: mime },
    ];
  }
  if (text === undefined) {
    const note = mime
      ? `; larger than the ${MAX_INLINE_IMAGE_BYTES} byte inline cap, so it was not attached — save it with \`genie artifact-show … --out <file>\``
      : "; only PNG, JPEG, GIF and WebP raster images are attached inline — save it with `genie artifact-show … --out <file>`";
    return [{ type: "text", text: `artifact #${n} ${name} is binary (${content.byteLength} bytes)${note}` }];
  }
  const body = text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated, ${text.length} chars)` : text;
  return [{ type: "text", text: `${header}\n\n${body}` }];
}

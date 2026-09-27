// Web-only docs helpers.
//
// These live in the web layer (not in `src/docs/*`) so the completed docs core
// service stays untouched: a cheap filesystem change signature for the docs
// version endpoint, and the atomic file write used when saving a page.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cheap docs change signal: relative path + size + mtime of every Markdown file
 * under the docs root, without reading file contents or shelling out to Git.
 * Symlinks are skipped, mirroring the docs service scan.
 */
export function docsFilesSignature(docsRoot: string): string {
  const hash = createHash("sha256");
  if (!fs.existsSync(docsRoot)) return hash.update("missing\0").digest("hex");
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absolute);
        } catch {
          continue;
        }
        const relative = path.relative(docsRoot, absolute).split(path.sep).join("/");
        hash.update(`${relative}\0${stat.size}\0${stat.mtimeMs}\n`);
      }
    }
  };
  walk(docsRoot);
  return hash.digest("hex");
}

/**
 * True when the lexical path `candidate` passes through a symlink inside `root`.
 * `resolveDocPath` canonicalizes its result, which hides an in-root symlink alias
 * (docs/alias.md → docs/real.md); this check rejects a save that would land on a
 * page the caller did not name. Walks up to the docs root; returns false when the
 * candidate is not inside it (containment is enforced elsewhere).
 */
export function passesThroughSymlink(root: string, candidate: string): boolean {
  const canonicalRoot = path.resolve(root);
  let current = path.resolve(candidate);
  while (current !== canonicalRoot) {
    if (!current.startsWith(canonicalRoot + path.sep)) return false;
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * Atomic save: write a same-directory temp file, then rename over the target so
 * readers never observe a partially written page. Cleans the temp file on error.
 */
export function atomicWriteFile(file: string, content: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const tmp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

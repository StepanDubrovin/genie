import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "../tracker/db.ts";
import { globMatches, matchesAnyGlob } from "./glob.ts";
import { parseDoc, type DocStatus, type DocType } from "./parser.ts";
import { isPathInside, resolveDocPath, resolveDocsRoot, resolveProjectRoot, toDocRelative } from "./root.ts";

const DOCS_SCHEMA_VERSION = 1;
const DOCS_SCHEMA_META = "CREATE TABLE IF NOT EXISTS docs_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
const DOCS_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs_pages (
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT,
  status TEXT,
  summary TEXT,
  tags_json TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  paths_json TEXT,
  related_json TEXT NOT NULL,
  verified TEXT,
  updated TEXT,
  body TEXT NOT NULL,
  headings_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reasons_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (root_id, path)
);
CREATE INDEX IF NOT EXISTS docs_pages_root_status ON docs_pages(root_id, status);
CREATE TABLE IF NOT EXISTS docs_links (
  root_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target TEXT NOT NULL,
  target_path TEXT,
  resolution TEXT NOT NULL,
  matches_json TEXT NOT NULL,
  FOREIGN KEY (root_id, source_path) REFERENCES docs_pages(root_id, path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS docs_links_target ON docs_links(root_id, target_path);
CREATE TABLE IF NOT EXISTS docs_state (
  root_id TEXT PRIMARY KEY,
  docs_root TEXT NOT NULL,
  git_signature TEXT NOT NULL,
  manifest_signature TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_pages_fts USING fts5(
  root_id UNINDEXED, path UNINDEXED, title, summary, headings, body, tags, aliases,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const TRUNCATION_MARKER = "\n\n[Truncated]";
const DEFAULT_READ_LIMIT = 12_000;
const MAX_READ_LIMIT = 100_000;

export interface DocsServiceOptions {
  db: Db;
  cwd: string;
  trackerDir?: string;
  /** Relative to the resolved project root. Defaults to `docs`. */
  docsRoot?: string;
}

export interface DocPage {
  rootId: string;
  path: string;
  title: string;
  type: DocType | null;
  status: DocStatus | null;
  summary: string | null;
  tags: string[];
  aliases: string[];
  paths: string[] | null;
  related: string[];
  verified: string | null;
  /** Git last-commit date for this file; never read from frontmatter. */
  updated: string | null;
  headings: string[];
  diagnostics: string[];
  stale: boolean;
  staleReasons: string[];
}

export interface DocLink {
  target: string;
  targetPath: string | null;
  resolution: "resolved" | "unresolved" | "ambiguous";
  matches: string[];
}

export interface DocSearchResult extends DocPage {
  score: number;
  snippet: string;
}

export interface DocSearchOptions {
  limit?: number;
  type?: DocType;
  /** Explicit status filter. Setting `deprecated` returns deprecated pages; any other value already excludes them. */
  status?: DocStatus;
  /** Explicit opt-in for the full result set, including deprecated pages. */
  includeDeprecated?: boolean;
  /**
   * Task/epic ids the caller works on. Deprecated pages whose `related` frontmatter
   * lists one of these ids stay in the default result set (analysis §3: deprecated
   * pages are "excluded unless explicitly requested/related").
   */
  related?: string[];
}

export interface DocReadResult extends DocPage {
  content: string;
  truncated: boolean;
  heading?: string;
  links: DocLink[];
  backlinks: string[];
}

export interface DocsRefreshResult {
  rootId: string;
  pages: number;
  changed: number;
  deleted: number;
  diagnostics: number;
}

interface ScannedFile {
  path: string;
  markdown: string;
  contentHash: string;
}

interface StoredDoc extends DocPage {
  body: string;
  contentHash: string;
}

interface PageRow {
  root_id: string;
  path: string;
  title: string;
  type: string | null;
  status: string | null;
  summary: string | null;
  tags_json: string;
  aliases_json: string;
  paths_json: string | null;
  related_json: string;
  verified: string | null;
  updated: string | null;
  body: string;
  headings_json: string;
  diagnostics_json: string;
  content_hash: string;
  stale: number;
  stale_reasons_json: string;
}

interface GitWorkingState {
  available: boolean;
  head: string;
  status: string;
  signature: string;
  changedPaths: string[];
}

interface GitMetadata {
  updatedByPath: Map<string, string>;
  staleReasonsByPath: Map<string, string[]>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.replace(/[ёЁ]/g, (char) => char === "ё" ? "е" : "Е");
}

function jsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch { return []; }
}

function rowToStored(row: PageRow): StoredDoc {
  return {
    rootId: row.root_id,
    path: row.path,
    title: row.title,
    type: row.type as DocType | null,
    status: row.status as DocStatus | null,
    summary: row.summary,
    tags: jsonArray<string>(row.tags_json),
    aliases: jsonArray<string>(row.aliases_json),
    paths: row.paths_json === null ? null : jsonArray<string>(row.paths_json),
    related: jsonArray<string>(row.related_json),
    verified: row.verified,
    updated: row.updated,
    body: row.body,
    headings: jsonArray<string>(row.headings_json),
    diagnostics: jsonArray<string>(row.diagnostics_json),
    stale: row.stale !== 0,
    staleReasons: jsonArray<string>(row.stale_reasons_json),
    contentHash: row.content_hash,
  };
}

function toPage(doc: StoredDoc): DocPage {
  const { body: _body, contentHash: _contentHash, ...page } = doc;
  return page;
}

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch { return undefined; }
}

function parseStatusPaths(status: string): string[] {
  const chunks = status.split("\0").filter(Boolean);
  const result: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const item = chunks[i];
    const match = /^(.{2}) (.*)$/s.exec(item);
    if (!match) continue;
    const [, code, file] = match;
    result.push(file);
    if (/[RC]/.test(code) && chunks[i + 1]) result.push(chunks[++i]);
  }
  return result;
}

function gitWorkingState(root: string): GitWorkingState {
  const top = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!top || path.resolve(top.trim()) !== path.resolve(root)) {
    return { available: false, head: "", status: "", signature: "no-git", changedPaths: [] };
  }
  const head = runGit(root, ["rev-parse", "--verify", "HEAD"])?.trim() ?? "unborn";
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  return {
    available: true,
    head,
    status,
    signature: hash(`${head}\0${status}`),
    changedPaths: parseStatusPaths(status),
  };
}

function parseGitLog(output: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!output) return result;
  let date: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date = value;
    } else if (value && date && !result.has(value)) {
      result.set(value, date);
    }
  }
  return result;
}

function isDocsFile(repoPath: string, docsRootRelative: string): boolean {
  return repoPath === docsRootRelative || repoPath.startsWith(`${docsRootRelative}/`);
}

function collectGitMetadata(
  root: string,
  docsRootRelative: string,
  pages: StoredDoc[],
  working: GitWorkingState,
): GitMetadata {
  const updatedByPath = new Map<string, string>();
  const staleReasonsByPath = new Map<string, string[]>();
  if (!working.available) return { updatedByPath, staleReasonsByPath };

  const docHistory = runGit(root, ["log", "--format=%cs", "--name-only", "--no-renames", "--", docsRootRelative]);
  for (const [file, date] of parseGitLog(docHistory)) {
    if (file.startsWith(`${docsRootRelative}/`)) updatedByPath.set(file.slice(docsRootRelative.length + 1), date);
  }

  const verifiedDates = pages.map((page) => page.verified).filter((date): date is string => !!date);
  const minVerified = verifiedDates.sort()[0];
  const committedChanges = new Map<string, string>();
  if (minVerified) {
    const since = `${minVerified}T00:00:00Z`;
    const output = runGit(root, ["log", `--since=${since}`, "--format=%cs", "--name-only", "--no-renames", "--", "."]);
    for (const [file, date] of parseGitLog(output)) {
      if (!isDocsFile(file, docsRootRelative)) committedChanges.set(file, date);
    }
  }

  const dirtyPaths = working.changedPaths.filter((file) => !isDocsFile(file, docsRootRelative));
  for (const page of pages) {
    if (!page.paths?.length || !page.verified) continue;
    const reasons = new Set<string>();
    for (const [changedPath, date] of committedChanges) {
      if (date <= page.verified) continue;
      const pattern = matchesAnyGlob(page.paths, changedPath);
      if (pattern) reasons.add(`Commit changed ${changedPath}, matching paths pattern ${pattern}`);
    }
    for (const changedPath of dirtyPaths) {
      const pattern = matchesAnyGlob(page.paths, changedPath);
      if (pattern) reasons.add(`Working-tree change ${changedPath}, matching paths pattern ${pattern}`);
    }
    if (reasons.size) staleReasonsByPath.set(page.path, [...reasons]);
  }
  return { updatedByPath, staleReasonsByPath };
}

function headingsText(headings: string[]): string {
  return headings.join("\n");
}

function wikiTargets(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => {
    const target = match[1].split("|")[0].split("#")[0].trim();
    return target;
  }).filter(Boolean);
}

function canonicalWikiTarget(target: string): string | undefined {
  if (!target || target.startsWith("/") || target.includes("\\")) return undefined;
  const normalized = target.replace(/^\.\//, "");
  const pieces = normalized.split("/");
  if (pieces.some((piece) => !piece || piece === ".." || piece === ".")) return undefined;
  return normalized.replace(/\.md$/i, "");
}

function pageAliases(page: StoredDoc): string[] {
  return page.aliases.map((alias) => alias.toLocaleLowerCase());
}

export class DocsService {
  readonly rootId: string;
  readonly projectRoot: string;
  readonly docsRoot: string;
  private schemaReady = false;
  private readonly db: Db;

  constructor(options: DocsServiceOptions) {
    this.db = options.db;
    this.projectRoot = resolveProjectRoot(options.cwd, options.trackerDir);
    this.rootId = this.projectRoot;
    this.docsRoot = resolveDocsRoot(this.projectRoot, options.docsRoot ?? "docs");
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    try {
      this.db.exec(DOCS_SCHEMA_META);
      const storedVersion = Number(this.db.get<{ value: string }>("SELECT value FROM docs_schema_meta WHERE key = 'schema_version'")?.value ?? 0);
      if (storedVersion && storedVersion !== DOCS_SCHEMA_VERSION) {
        this.db.exec("DROP TABLE IF EXISTS docs_links; DROP TABLE IF EXISTS docs_pages_fts; DROP TABLE IF EXISTS docs_pages; DROP TABLE IF EXISTS docs_state;");
      }
      this.db.exec(DOCS_SCHEMA);
      this.db.run("INSERT OR REPLACE INTO docs_schema_meta(key,value) VALUES ('schema_version',?)", String(DOCS_SCHEMA_VERSION));
      this.schemaReady = true;
    } catch (error) {
      const detail = String(error);
      if (/fts5|no such module/i.test(detail)) throw new Error(`Genie docs are unavailable: this SQLite build must support FTS5 (${detail})`);
      throw new Error(`Genie docs schema initialization failed: ${detail}`);
    }
  }

  private scanFiles(): ScannedFile[] {
    if (!fs.existsSync(this.docsRoot)) return [];
    const rootStat = fs.statSync(this.docsRoot);
    if (!rootStat.isDirectory()) throw new Error(`docs.root is not a directory: ${this.docsRoot}`);
    const found: ScannedFile[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          const canonical = fs.realpathSync(absolute);
          if (!isPathInside(this.docsRoot, canonical) || !isPathInside(this.projectRoot, canonical)) continue;
          const relative = toDocRelative(this.docsRoot, canonical);
          const markdown = fs.readFileSync(canonical, "utf8");
          found.push({ path: relative, markdown, contentHash: hash(markdown) });
        }
      }
    };
    walk(this.docsRoot);
    return found;
  }

  private loadExisting(): Map<string, StoredDoc> {
    const rows = this.db.all<PageRow>("SELECT * FROM docs_pages WHERE root_id = ?", this.rootId);
    return new Map(rows.map((row) => [row.path, rowToStored(row)]));
  }

  private parsedToStored(file: ScannedFile, old: StoredDoc | undefined): StoredDoc {
    if (old && old.contentHash === file.contentHash) return old;
    const parsed = parseDoc(file.markdown, file.path);
    return {
      rootId: this.rootId,
      path: file.path,
      title: parsed.title,
      type: parsed.type,
      status: parsed.status,
      summary: parsed.summary,
      tags: parsed.tags,
      aliases: parsed.aliases,
      paths: parsed.paths,
      related: parsed.related,
      verified: parsed.verified,
      updated: old?.updated ?? null,
      body: parsed.body,
      headings: parsed.headings,
      diagnostics: parsed.diagnostics,
      stale: old?.stale ?? false,
      staleReasons: old?.staleReasons ?? [],
      contentHash: file.contentHash,
    };
  }

  private resolveLinks(pages: StoredDoc[]): { source: StoredDoc; link: DocLink }[] {
    const exact = new Map<string, string[]>();
    const basename = new Map<string, string[]>();
    const aliases = new Map<string, string[]>();
    const add = (map: Map<string, string[]>, key: string, docPath: string): void => {
      map.set(key, [...(map.get(key) ?? []), docPath]);
    };
    for (const page of pages) {
      const canonical = page.path.replace(/\.md$/i, "");
      add(exact, canonical, page.path);
      add(basename, path.posix.basename(canonical), page.path);
      for (const alias of pageAliases(page)) add(aliases, alias, page.path);
    }
    const links: { source: StoredDoc; link: DocLink }[] = [];
    for (const source of pages) {
      for (const target of wikiTargets(source.body)) {
        const key = canonicalWikiTarget(target);
        let matches = key ? exact.get(key) ?? [] : [];
        if (!matches.length && key && !key.includes("/")) matches = [...(basename.get(key) ?? []), ...(aliases.get(key.toLocaleLowerCase()) ?? [])];
        matches = [...new Set(matches)].sort();
        links.push({
          source,
          link: {
            target,
            targetPath: matches.length === 1 ? matches[0] : null,
            resolution: matches.length === 1 ? "resolved" : matches.length > 1 ? "ambiguous" : "unresolved",
            matches,
          },
        });
      }
    }
    return links;
  }

  /** Scan incrementally and refresh links plus batched Git-derived freshness metadata. */
  refresh(): DocsRefreshResult {
    this.ensureSchema();
    const existing = this.loadExisting();
    const files = this.scanFiles();
    const docsRootRelative = path.relative(this.projectRoot, this.docsRoot).split(path.sep).join("/");
    if (!docsRootRelative || docsRootRelative === ".." || docsRootRelative.startsWith("../")) {
      throw new Error("docs.root resolves outside the project root");
    }
    const state = this.db.get<{ docs_root: string; git_signature: string; manifest_signature: string }>(
      "SELECT docs_root, git_signature, manifest_signature FROM docs_state WHERE root_id = ?", this.rootId,
    );
    const rootChanged = !!state && state.docs_root !== this.docsRoot;
    const prior = rootChanged ? new Map<string, StoredDoc>() : existing;
    const pages = files.map((file) => this.parsedToStored(file, prior.get(file.path)));
    const filePaths = new Set(files.map((file) => file.path));
    const deletedPaths = [...prior.keys()].filter((file) => !filePaths.has(file));
    const manifestSignature = hash(files.map((file) => `${file.path}\0${file.contentHash}`).join("\n"));
    const working = gitWorkingState(this.projectRoot);
    const gitSignature = hash(`${working.signature}\0${this.docsRoot}\0${manifestSignature}\0${pages.map((p) => `${p.path}:${p.verified}:${JSON.stringify(p.paths)}`).join("\n")}`);
    const shouldRefreshGit = !state || state.git_signature !== gitSignature || state.manifest_signature !== manifestSignature;
    if (shouldRefreshGit) {
      const metadata = collectGitMetadata(this.projectRoot, docsRootRelative, pages, working);
      for (const page of pages) {
        page.updated = metadata.updatedByPath.get(page.path) ?? null;
        page.staleReasons = metadata.staleReasonsByPath.get(page.path) ?? [];
        page.stale = page.staleReasons.length > 0;
      }
    }

    const oldHashes = new Map([...prior].map(([file, doc]) => [file, doc.contentHash]));
    const changed = pages.filter((page) => oldHashes.get(page.path) !== page.contentHash).length;
    this.db.tx(() => {
      if (rootChanged) {
        this.db.run("DELETE FROM docs_pages_fts WHERE root_id = ?", this.rootId);
        this.db.run("DELETE FROM docs_pages WHERE root_id = ?", this.rootId);
      }
      for (const file of deletedPaths) {
        this.db.run("DELETE FROM docs_pages_fts WHERE root_id = ? AND path = ?", this.rootId, file);
        this.db.run("DELETE FROM docs_pages WHERE root_id = ? AND path = ?", this.rootId, file);
      }
      const changedSet = new Set(pages.filter((page) => oldHashes.get(page.path) !== page.contentHash).map((page) => page.path));
      for (const page of pages) {
        this.db.run(
          `INSERT INTO docs_pages (
            root_id,path,title,type,status,summary,tags_json,aliases_json,paths_json,related_json,
            verified,updated,body,headings_json,diagnostics_json,content_hash,stale,stale_reasons_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(root_id,path) DO UPDATE SET
            title=excluded.title,type=excluded.type,status=excluded.status,summary=excluded.summary,
            tags_json=excluded.tags_json,aliases_json=excluded.aliases_json,paths_json=excluded.paths_json,
            related_json=excluded.related_json,verified=excluded.verified,updated=excluded.updated,body=excluded.body,
            headings_json=excluded.headings_json,diagnostics_json=excluded.diagnostics_json,
            content_hash=excluded.content_hash,stale=excluded.stale,stale_reasons_json=excluded.stale_reasons_json`,
          this.rootId, page.path, page.title, page.type, page.status, page.summary,
          JSON.stringify(page.tags), JSON.stringify(page.aliases), page.paths === null ? null : JSON.stringify(page.paths),
          JSON.stringify(page.related), page.verified, page.updated, page.body, JSON.stringify(page.headings),
          JSON.stringify(page.diagnostics), page.contentHash, page.stale ? 1 : 0, JSON.stringify(page.staleReasons),
        );
        if (changedSet.has(page.path) || rootChanged) {
          this.db.run("DELETE FROM docs_pages_fts WHERE root_id = ? AND path = ?", this.rootId, page.path);
          this.db.run(
            "INSERT INTO docs_pages_fts(root_id,path,title,summary,headings,body,tags,aliases) VALUES (?,?,?,?,?,?,?,?)",
            this.rootId, page.path, normalizeText(page.title), normalizeText(page.summary ?? ""),
            normalizeText(headingsText(page.headings)), normalizeText(page.body), normalizeText(page.tags.join(" ")),
            normalizeText(page.aliases.join(" ")),
          );
        }
      }
      this.db.run("DELETE FROM docs_links WHERE root_id = ?", this.rootId);
      for (const { source, link } of this.resolveLinks(pages)) {
        this.db.run(
          "INSERT INTO docs_links(root_id,source_path,target,target_path,resolution,matches_json) VALUES (?,?,?,?,?,?)",
          this.rootId, source.path, link.target, link.targetPath, link.resolution, JSON.stringify(link.matches),
        );
      }
      this.db.run(
        `INSERT INTO docs_state(root_id,docs_root,git_signature,manifest_signature) VALUES (?,?,?,?)
         ON CONFLICT(root_id) DO UPDATE SET docs_root=excluded.docs_root,git_signature=excluded.git_signature,manifest_signature=excluded.manifest_signature`,
        this.rootId, this.docsRoot, gitSignature, manifestSignature,
      );
    });
    return {
      rootId: this.rootId,
      pages: pages.length,
      changed,
      deleted: deletedPaths.length,
      diagnostics: pages.reduce((count, page) => count + page.diagnostics.length, 0),
    };
  }

  /** Drop and recreate only the docs cache tables, then perform a fresh scan. */
  rebuild(): DocsRefreshResult {
    this.ensureSchema();
    this.db.tx(() => {
      this.db.exec("DROP TABLE IF EXISTS docs_links; DROP TABLE IF EXISTS docs_pages_fts; DROP TABLE IF EXISTS docs_pages; DROP TABLE IF EXISTS docs_state; DROP TABLE IF EXISTS docs_schema_meta;");
    });
    this.schemaReady = false;
    this.ensureSchema();
    return this.refresh();
  }

  private currentPages(): StoredDoc[] {
    return this.db.all<PageRow>("SELECT * FROM docs_pages WHERE root_id = ? ORDER BY path", this.rootId).map(rowToStored);
  }

  list(): DocPage[] {
    this.refresh();
    return this.currentPages().map(toPage);
  }

  /** D1: diagnostics are available as a cross-page service list and on each page/result. */
  getDiagnostics(): { path: string; diagnostics: string[] }[] {
    this.refresh();
    return this.currentPages().filter((page) => page.diagnostics.length > 0).map((page) => ({ path: page.path, diagnostics: page.diagnostics }));
  }

  getPage(inputPath: string): DocPage | undefined {
    this.refresh();
    const absolute = resolveDocPath(this.docsRoot, inputPath);
    if (!fs.existsSync(absolute) || !isPathInside(this.docsRoot, fs.realpathSync(absolute))) return undefined;
    const relative = toDocRelative(this.docsRoot, absolute);
    const row = this.db.get<PageRow>("SELECT * FROM docs_pages WHERE root_id = ? AND path = ?", this.rootId, relative);
    return row ? toPage(rowToStored(row)) : undefined;
  }

  /**
   * Search the ranked FTS result set. Deprecated pages are filtered out of the default
   * result set; `status`, `includeDeprecated` and `related` are the explicit opt-ins.
   * The FTS5 query, BM25 ranking and snippets are unchanged, and tree/list/read still
   * expose deprecated pages with their marker.
   */
  search(query: string, options: DocSearchOptions = {}): DocSearchResult[] {
    this.refresh();
    const tokens = normalizeText(query).match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!tokens.length) return [];
    const expression = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
    const requestedLimit = options.limit ?? 20;
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 20;
    const conditions = ["docs_pages_fts MATCH ?", "p.root_id = ?"];
    const params: (string | number)[] = [expression, this.rootId];
    if (options.type) { conditions.push("p.type = ?"); params.push(options.type); }
    if (options.status) {
      conditions.push("p.status = ?");
      params.push(options.status);
    } else if (options.includeDeprecated !== true) {
      const relatedIds = [...new Set((options.related ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean))];
      const kept = ["p.status IS NULL", "p.status <> 'deprecated'"];
      for (const id of relatedIds) kept.push("upper(p.related_json) LIKE ?");
      conditions.push(`(${kept.join(" OR ")})`);
      for (const id of relatedIds) params.push(`%"${id}"%`);
    }
    params.push(limit);
    try {
      const rows = this.db.all<PageRow & { score: number; snippet: string }>(
        `SELECT p.*, bm25(docs_pages_fts) AS score,
          snippet(docs_pages_fts, 5, '[', ']', '…', 18) AS snippet
         FROM docs_pages_fts JOIN docs_pages p
          ON p.root_id = docs_pages_fts.root_id AND p.path = docs_pages_fts.path
         WHERE ${conditions.join(" AND ")} ORDER BY score ASC LIMIT ?`,
        ...params,
      );
      return rows.map((row) => ({ ...toPage(rowToStored(row)), score: Number(row.score), snippet: row.snippet }));
    } catch (error) {
      throw new Error(`Genie docs search failed: ${String(error)}`);
    }
  }

  private linksFor(file: string): DocLink[] {
    return this.db.all<{ target: string; target_path: string | null; resolution: DocLink["resolution"]; matches_json: string }>(
      "SELECT target,target_path,resolution,matches_json FROM docs_links WHERE root_id = ? AND source_path = ? ORDER BY target",
      this.rootId, file,
    ).map((row) => ({ target: row.target, targetPath: row.target_path, resolution: row.resolution, matches: jsonArray<string>(row.matches_json) }));
  }

  read(inputPath: string, options: { heading?: string; wholePage?: boolean; maxChars?: number } = {}): DocReadResult {
    if (options.heading === undefined && options.wholePage !== true) throw new Error("whole-page reads must be explicit; pass wholePage: true or a heading");
    this.refresh();
    const absolute = resolveDocPath(this.docsRoot, inputPath);
    if (!fs.existsSync(absolute)) throw new Error(`documentation page not found: ${inputPath}`);
    const real = fs.realpathSync(absolute);
    if (!isPathInside(this.docsRoot, real) || !isPathInside(this.projectRoot, real)) throw new Error(`docs path resolves outside docs.root: ${inputPath}`);
    const file = toDocRelative(this.docsRoot, real);
    const row = this.db.get<PageRow>("SELECT * FROM docs_pages WHERE root_id = ? AND path = ?", this.rootId, file);
    if (!row) throw new Error(`documentation page not indexed: ${inputPath}`);
    const stored = rowToStored(row);
    let content = stored.body;
    let selectedHeading: string | undefined;
    if (options.heading !== undefined) {
      const wanted = options.heading.replace(/^#+\s*/, "").trim().toLocaleLowerCase();
      const lines = stored.body.split(/\r?\n/);
      const start = lines.findIndex((line) => {
        const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        return heading?.[2].trim().toLocaleLowerCase() === wanted;
      });
      if (start < 0) throw new Error(`heading not found in ${inputPath}: ${options.heading}`);
      const level = /^(\s*#+)/.exec(lines[start])?.[1].trim().length ?? 1;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        const heading = /^\s*(#{1,6})\s+/.exec(lines[i]);
        if (heading && heading[1].length <= level) { end = i; break; }
      }
      content = lines.slice(start, end).join("\n");
      selectedHeading = options.heading;
    }
    const requested = Math.floor(options.maxChars ?? DEFAULT_READ_LIMIT);
    if (!Number.isFinite(requested) || requested < 1) throw new Error("maxChars must be a positive integer");
    const maxChars = Math.min(requested, MAX_READ_LIMIT);
    const truncated = content.length > maxChars;
    if (truncated) content = `${content.slice(0, maxChars)}${TRUNCATION_MARKER}`;
    const backlinks = this.db.all<{ source_path: string }>(
      "SELECT DISTINCT source_path FROM docs_links WHERE root_id = ? AND target_path = ? ORDER BY source_path",
      this.rootId, file,
    ).map((item) => item.source_path);
    return { ...toPage(stored), content, truncated, ...(selectedHeading ? { heading: selectedHeading } : {}), links: this.linksFor(file), backlinks };
  }

  /** Resolve an API path without exposing absolute filesystem paths. */
  resolvePath(inputPath: string): string {
    return resolveDocPath(this.docsRoot, inputPath);
  }
}

export { globMatches, normalizeText, resolveDocsRoot, resolveProjectRoot };

// Agent-facing docs context: the estimator, the L0 metadata inventory (system
// prompt), the L1 kickoff selection, docs_note writing and the tool result
// formatting. This file is the only addition under src/docs/ (G-8's service,
// parser, root and glob modules stay untouched); it consumes their public API.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "../tracker/db.ts";
import { matchesAnyGlob } from "./glob.ts";
import { toDocRelative } from "./root.ts";
import { DocsService, type DocPage, type DocReadResult, type DocSearchResult } from "./service.ts";

// ---------------------------------------------------------------- estimator

/** Budgets are estimator units, never real tokens (epic G-4 artifact #2, N1). */
export const L0_TARGET_UNITS = 600;
export const L0_HARD_CAP_UNITS = 1000;
export const L1_TOTAL_UNITS = 4000;
export const L1_PAGE_UNITS = 1500;
export const L1_MAX_PAGES = 3;

/**
 * Per-script estimator: `≈chars/4` for Latin, `≈chars/2` for Cyrillic.
 * Everything that is not Cyrillic (including whitespace and punctuation) counts
 * as Latin.
 */
export function units(text: string): number {
  let latin = 0;
  let cyrillic = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0500 && code <= 0x052f)) cyrillic += 1;
    else latin += 1;
  }
  return Math.ceil(latin / 4 + cyrillic / 2);
}

/** Lowercase and fold ё/Ё to е/Е so term matching survives the two spellings. */
export function normalizeTerm(value: string): string {
  return value.toLocaleLowerCase().replace(/[ёЁ]/g, (char) => (char === "ё" ? "е" : "Е"));
}

// ---------------------------------------------------------------- L0

const L0_HEADER = "## Project docs (L0 index)";
const L0_HINT = "Metadata only — use docs_search / docs_read for content.";
const L0_SUMMARY_CLIP = 100;

export interface L0Inventory {
  text: string;
  units: number;
  pages: number;
  shown: number;
  omitted: number;
  compacted: boolean;
}

/** Human-readable marker tokens for one page (shared by L0 and the tools). */
export function docMarkers(page: DocPage): string[] {
  const markers: string[] = [];
  if (page.stale) markers.push("stale");
  if (page.status === "draft") markers.push("draft");
  if (page.verified === null) markers.push("unverified");
  if (page.status === "deprecated") markers.push("deprecated");
  if (page.diagnostics.length) markers.push("check frontmatter");
  return markers;
}

function clipText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (max <= 1) return flat.slice(0, Math.max(0, max));
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function l0Line(page: DocPage): string {
  const summary = page.summary ? `: ${clipText(page.summary, L0_SUMMARY_CLIP)}` : "";
  const markers = docMarkers(page).map((marker) => ` [${marker}]`).join("");
  return `- ${page.title} (${page.type ?? "untyped"}, ${page.status ?? "unknown"}, ${page.updated ?? "no date"})${summary}${markers}`;
}

function l0CompactBlock(pages: DocPage[], shown: number): string {
  const draft = pages.filter((page) => page.status === "draft").length;
  const stale = pages.filter((page) => page.stale).length;
  const omitted = pages.length - shown;
  const header = shown === pages.length
    ? L0_HEADER
    : `## Project docs (L0 index — compact: showing ${shown} of ${pages.length})`;
  const marker = `- … ${omitted} more page(s) not listed (compact index: showing ${shown} of ${pages.length}; draft ${draft}, stale ${stale}). Use docs_search / docs_read.`;
  const body = pages.slice(0, shown).map(l0Line);
  return `${header}\n${L0_HINT}\n${[...body, marker].join("\n")}`;
}

/** Build the metadata-only L0 inventory; compaction is always marked (never a silent cap). */
export function buildL0Inventory(service: DocsService): L0Inventory {
  const pages = service.list();
  if (!pages.length) return { text: "", units: 0, pages: 0, shown: 0, omitted: 0, compacted: false };
  const full = `${L0_HEADER}\n${L0_HINT}\n${pages.map(l0Line).join("\n")}`;
  if (units(full) <= L0_TARGET_UNITS) {
    return { text: full, units: units(full), pages: pages.length, shown: pages.length, omitted: 0, compacted: false };
  }
  // Keep the largest prefix that still fits the target once the omission marker is added.
  let shown = 0;
  let text = "";
  for (let i = pages.length; i >= 0; i--) {
    const candidate = l0CompactBlock(pages, i);
    if (units(candidate) <= L0_TARGET_UNITS) { shown = i; text = candidate; break; }
  }
  if (!text) {
    shown = 0;
    text = l0CompactBlock(pages, 0);
  }
  return { text, units: units(text), pages: pages.length, shown, omitted: pages.length - shown, compacted: true };
}

// ---------------------------------------------------------------- L0 cache

/** sha256 over the sorted `relPath\0size\0mtimeMs` of the docs Markdown files, or `absent`. */
export function docsStatSignature(docsRoot: string): string {
  let stat: fs.Stats;
  try { stat = fs.statSync(docsRoot); } catch { return "absent"; }
  if (!stat.isDirectory()) return "absent";
  const rows: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const file = fs.statSync(absolute);
        rows.push(`${path.relative(docsRoot, absolute).split(path.sep).join("/")}\0${file.size}\0${file.mtimeMs}`);
      }
    }
  };
  walk(docsRoot);
  rows.sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

export interface DocsContextOptions {
  db: Db;
  trackerDir?: string;
  docsRoot?: string;
}

/**
 * Per-process L0 source with a stat-signature cache: `before_agent_start` runs
 * on every prompt, so `list()` (and its batched Git pass) runs only when the
 * docs tree changed. `updated` therefore always comes from the cached call.
 */
export class DocsContext {
  private readonly options: DocsContextOptions;
  private cache?: { key: string; value: L0Inventory | undefined };

  constructor(options: DocsContextOptions) {
    this.options = options;
  }

  l0(cwd: string): L0Inventory | undefined {
    let service: DocsService;
    try {
      service = new DocsService({
        db: this.options.db,
        cwd,
        trackerDir: this.options.trackerDir,
        docsRoot: this.options.docsRoot,
      });
    } catch { return undefined; }
    let signature: string;
    try { signature = docsStatSignature(service.docsRoot); } catch { return undefined; }
    const key = `${service.rootId}\0${signature}`;
    if (this.cache && this.cache.key === key) return this.cache.value;
    let value: L0Inventory | undefined;
    try {
      const built = buildL0Inventory(service);
      value = built.pages ? built : undefined;
    } catch { value = undefined; }
    this.cache = { key, value };
    return value;
  }
}

// ---------------------------------------------------------------- L1

/** Structural task view so context.ts stays independent of the tracker model. */
export interface L1Task {
  id: string;
  title: string;
  description?: string | null;
  plan?: string | null;
  acceptance?: { text: string }[];
  epicId?: string | null;
}

export interface L1SelectedPage {
  path: string;
  title: string;
  reasons: string[];
  rank: 0 | 1 | 2;
  clipped: boolean;
  sections: number;
  shownSections: number;
  units: number;
}

export interface L1Context {
  text: string;
  pages: L1SelectedPage[];
  totalUnits: number;
}

const L1_HEADER = "## Project docs (L1 context)";
const L1_HINT = "Selected for this task; stale/draft pages are marked. Read the rest with docs_read/docs_search.";
const PATH_CANDIDATE = /\b[\w.-]+(?:\/[\w.*?-]+)+\b/g;
const TERM_TOKEN = /[\p{L}\p{N}_]+/gu;
const MIN_TERM_LENGTH = 3;
const MIN_PAGE_BUDGET = 200;

/**
 * Closed-class function words (English + Russian) that carry no topical signal.
 * This is a generic, language-level list, never a per-page denylist; tokens
 * derived from the project name are damped on top of it. Kept short on purpose:
 * only words that realistically occur in task text and page headings.
 */
const FUNCTION_WORDS = new Set([
  // English articles, conjunctions, prepositions, pronouns and auxiliaries.
  "the", "and", "for", "from", "into", "with", "without", "over", "under", "about",
  "after", "before", "between", "through", "this", "that", "these", "those", "they", "them",
  "their", "there", "you", "your", "its", "his", "her", "our", "who", "which",
  "what", "are", "was", "were", "been", "has", "have", "had", "does", "did",
  "can", "could", "may", "might", "must", "should", "will", "would", "not", "only",
  "also", "then", "than", "when", "where", "while", "how", "all", "any", "some",
  "more", "most", "other", "such", "same",
  // Russian conjunctions, prepositions, pronouns and adverbs.
  "или", "либо", "если", "чтобы", "что", "как", "чем", "для", "без", "под",
  "над", "про", "при", "через", "между", "после", "перед", "кроме", "это", "этот",
  "эта", "эти", "тот", "его", "ее", "её", "их", "они", "она", "оно",
  "все", "где", "тут", "там", "тогда", "когда", "так", "тоже", "также", "ещё",
  "еще", "уже", "только", "очень",
]);

function pathCandidates(corpus: string): string[] {
  const found = new Set<string>();
  for (const match of corpus.matchAll(PATH_CANDIDATE)) {
    const value = match[0];
    if (value.includes("://")) continue;
    found.add(value);
  }
  return [...found];
}

function isPathPart(token: string, paths: string[]): boolean {
  return paths.some((candidate) => candidate.split(/[/.]/).includes(token));
}

function termTokens(corpus: string, paths: string[]): string[] {
  const tokens = corpus.match(TERM_TOKEN) ?? [];
  const found = new Set<string>();
  for (const token of tokens) {
    if (token.length < MIN_TERM_LENGTH) continue;
    if (isPathPart(token, paths)) continue;
    found.add(token);
  }
  return [...found];
}

/**
 * The one explicit term surface: the fields term matching is allowed to read.
 * Title, summary, headings, tags and aliases only — body text is deliberately
 * excluded so L1 stays cheap and predictable. Glossary pages are covered through
 * these same fields (there is no separate glossary field).
 */
export function pageTermSurface(page: DocPage): string {
  return [page.title, page.summary ?? "", ...page.headings, ...page.tags, ...page.aliases].join("\n");
}

/** Normalized tokens of a page's term surface, deduplicated. */
function surfaceTokens(page: DocPage): Set<string> {
  const tokens = pageTermSurface(page).match(TERM_TOKEN) ?? [];
  const found = new Set<string>();
  for (const token of tokens) {
    if (token.length >= MIN_TERM_LENGTH) found.add(normalizeTerm(token));
  }
  return found;
}

function pageTermMatch(surface: Set<string>, token: string): boolean {
  return surface.has(normalizeTerm(token));
}

/** Tokens from the project directory name and `package.json` name ("meta.project"). */
function projectNameStopwords(projectRoot: string): Set<string> {
  const names = [path.basename(projectRoot)];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim()) names.push(pkg.name);
  } catch { /* no readable package.json: the directory name still carries the project name */ }
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of name.match(TERM_TOKEN) ?? []) {
      if (token.length >= MIN_TERM_LENGTH) tokens.add(normalizeTerm(token));
    }
  }
  return tokens;
}

/**
 * Damping rule for term matches, evaluated against the current index so it stays
 * deterministic and needs no per-page blacklist:
 *  - tokens derived from the project name (project directory or `package.json`
 *    `name`) never select on their own — merely mentioning the project is not
 *    evidence that a page is relevant;
 *  - generic function words (see `FUNCTION_WORDS`) carry no topical signal;
 *  - a term that occurs in more than half of the indexed pages (and in at least
 *    two of them, since a single page is trivially ubiquitous) is dropped as
 *    well.
 * Damped terms are removed from the whole selection, so a page that matches only
 * ubiquitous tokens is not selected on the term class and carries no fake reason.
 */
function discriminativeTerms(projectRoot: string, pages: DocPage[], surfaces: Map<string, Set<string>>, terms: string[]): string[] {
  const damped = projectNameStopwords(projectRoot);
  for (const word of FUNCTION_WORDS) damped.add(normalizeTerm(word));
  for (const token of terms) {
    if (damped.has(normalizeTerm(token))) continue;
    const df = pages.reduce((count, page) => count + (pageTermMatch(surfaces.get(page.path) ?? new Set(), token) ? 1 : 0), 0);
    if (df >= 2 && df * 2 > pages.length) damped.add(normalizeTerm(token));
  }
  return terms.filter((token) => !damped.has(normalizeTerm(token)));
}

function statusRank(page: DocPage): number {
  if (page.status === "current") return 0;
  if (page.status === "draft") return 2;
  return 1;
}

interface Scored {
  page: DocPage;
  rank: 0 | 1 | 2;
  reasons: string[];
  termMatches: number;
}

function scorePage(page: DocPage, task: L1Task, paths: string[], terms: string[], surface: Set<string>): Scored | undefined {
  const related = new Set(page.related.map((id) => id.trim().toUpperCase()));
  const wantedIds = [task.id, task.epicId].filter((id): id is string => !!id).map((id) => id.trim().toUpperCase());
  const relatedReasons = [...new Set(wantedIds.filter((id) => related.has(id)))].map((id) => `related ${id}`);
  const pathReasons = paths
    .filter((candidate) => matchesAnyGlob(page.paths, candidate) !== undefined || (page.paths ?? []).some((pattern) => matchesAnyGlob([candidate], pattern) !== undefined))
    .map((candidate) => `path match ${candidate}`);
  const termMatches = terms.filter((token) => pageTermMatch(surface, token));
  if (!relatedReasons.length && !pathReasons.length && !termMatches.length) return undefined;
  // Deprecated pages only surface when explicitly related to the task.
  if (!relatedReasons.length && page.status === "deprecated") return undefined;
  const rank: 0 | 1 | 2 = relatedReasons.length ? 0 : pathReasons.length ? 1 : 2;
  const reasons = [
    ...relatedReasons,
    ...pathReasons.slice(0, 2),
    ...termMatches.slice(0, 3).map((token) => `term match ${token}`),
  ];
  return { page, rank, reasons, termMatches: termMatches.length };
}

interface ClipResult {
  text: string;
  clipped: boolean;
  sections: number;
  shownSections: number;
}

/** Split body into heading-delimited sections; leading prose is its own chunk. */
function splitSections(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*#{1,6}\s+/.test(line) && current.some((item) => item.trim())) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections.length ? sections : [body];
}

/**
 * Clip content at section boundaries within `budget` estimator units, always
 * appending an explicit truncation marker when anything is dropped. The marker
 * units are reserved up front so the returned text never exceeds the budget.
 */
export function clipAtSections(content: string, budget: number): ClipResult {
  const sections = splitSections(content);
  const total = sections.length;
  const marker = (shown: number): string => `\n\n[... page clipped at section boundaries: showing ${shown} of ${total} sections; read the rest with docs_read ...]`;
  if (units(content) <= budget) return { text: content, clipped: false, sections: total, shownSections: total };
  const inner = Math.max(0, budget - units(marker(total)));
  const kept: string[] = [];
  for (const section of sections) {
    if (units([...kept, section].join("\n")) <= inner) kept.push(section);
    else break;
  }
  if (kept.length === total) return { text: content, clipped: false, sections: total, shownSections: total };
  if (kept.length === 0) {
    const lines = (sections[0] ?? "").split("\n");
    const clippedLines: string[] = [];
    for (const line of lines) {
      if (units([...clippedLines, line].join("\n")) <= inner) clippedLines.push(line);
      else break;
    }
    return { text: `${clippedLines.join("\n")}${marker(0)}`, clipped: true, sections: total, shownSections: 0 };
  }
  return { text: `${kept.join("\n")}${marker(kept.length)}`, clipped: true, sections: total, shownSections: kept.length };
}

/** Core L1 selection: deterministic rank, caps, marked clipping and reasons. */
export function selectL1Pages(service: DocsService, task: L1Task): Scored[] {
  const pages = service.list();
  if (!pages.length) return [];
  const corpus = [
    task.title,
    task.description ?? "",
    task.plan ?? "",
    ...(task.acceptance ?? []).map((criterion) => criterion.text),
  ].join("\n");
  const paths = pathCandidates(corpus);
  const terms = termTokens(corpus, paths);
  const surfaces = new Map(pages.map((page) => [page.path, surfaceTokens(page)]));
  const activeTerms = discriminativeTerms(service.projectRoot, pages, surfaces, terms);
  return pages
    .map((page) => scorePage(page, task, paths, activeTerms, surfaces.get(page.path) ?? new Set()))
    .filter((scored): scored is Scored => scored !== undefined)
    .sort((a, b) =>
      a.rank - b.rank ||
      b.termMatches - a.termMatches ||
      statusRank(a.page) - statusRank(b.page) ||
      a.page.path.localeCompare(b.page.path),
    )
    .slice(0, L1_MAX_PAGES);
}

/** One shared L1 builder for initial spawn and add-member (both pass team.cwd). */
export function buildL1Context(service: DocsService, task: L1Task): L1Context | undefined {
  const selected = selectL1Pages(service, task);
  if (!selected.length) return undefined;
  const blocks: string[] = [];
  const pages: L1SelectedPage[] = [];
  let used = units(`${L1_HEADER}\n${L1_HINT}`);
  for (const item of selected) {
    const page = item.page;
    const heading = `### ${page.title} (${page.type ?? "untyped"}, ${page.status ?? "unknown"}${page.stale ? ", stale" : ""}${page.status === "draft" ? ", draft" : ""}) — ${item.reasons.join(" · ")}`;
    const headingUnits = units(`\n${heading}`);
    const remaining = L1_TOTAL_UNITS - used - headingUnits;
    if (remaining < MIN_PAGE_BUDGET) break;
    let content: string;
    try {
      content = service.read(page.path, { wholePage: true, maxChars: 100_000 }).content;
    } catch { continue; }
    const clip = clipAtSections(content, Math.min(L1_PAGE_UNITS, remaining));
    const block = `\n${heading}\n${clip.text}`;
    blocks.push(block);
    used += units(block);
    pages.push({
      path: page.path,
      title: page.title,
      reasons: item.reasons,
      rank: item.rank,
      clipped: clip.clipped,
      sections: clip.sections,
      shownSections: clip.shownSections,
      units: units(block),
    });
  }
  if (!pages.length) return undefined;
  const text = `${L1_HEADER}\n${L1_HINT}${blocks.join("")}`;
  return { text, pages, totalUnits: units(text) };
}

// ---------------------------------------------------------------- docs_note

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

/** Lowercase ASCII slug, transliterating Cyrillic; always non-empty. */
export function slugify(title: string): string {
  let out = "";
  for (const char of title.toLocaleLowerCase()) out += TRANSLIT[char] ?? char;
  out = out.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return out || "note";
}

export interface DocNoteInput {
  title: string;
  body: string;
  tags?: string[];
  related?: string[];
}

export interface DocNoteResult {
  /** Docs-root-relative path of the written file. */
  path: string;
  absolute: string;
  slug: string;
}

function yamlList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/** Atomically create `target` from `temp` without ever replacing an existing file. */
export function publishExclusive(temp: string, target: string): "created" | "exists" {
  try {
    fs.linkSync(temp, target);
    return "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EMLINK") {
      try {
        fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
        return "created";
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw copyError;
      }
    }
    throw error;
  }
}

/**
 * Write a unique `<docs-root>/inbox/YYYY-MM-DD-slug.md` note: type note, status
 * draft, never overwriting an existing file, published atomically (a private temp
 * file, then an exclusive hardlink/COPYFILE_EXCL into place), then refresh the index.
 */
export function writeDocNote(service: DocsService, input: DocNoteInput): DocNoteResult {
  const title = input.title.trim();
  if (!title) throw new Error("docs_note requires a non-empty title");
  const body = input.body ?? "";
  const slug = slugify(title);
  const dir = path.join(service.docsRoot, "inbox");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const base = (suffix = ""): string => path.join(dir, `${date}-${slug}${suffix}.md`);
  let absolute = base();
  let counter = 2;
  while (fs.existsSync(absolute)) absolute = base(`-${counter++}`);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: note",
    "status: draft",
    ...(input.tags?.length ? [`tags: ${yamlList(input.tags)}`] : []),
    ...(input.related?.length ? [`related: ${yamlList(input.related)}`] : []),
    "---",
    "",
  ].join("\n");
  const content = `${frontmatter}${body}${body.endsWith("\n") || !body ? "" : "\n"}`;
  const temp = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(temp, content, { flag: "wx" });
  try {
    // Publish exclusively: hardlink (or COPYFILE_EXCL) raises EEXIST instead of
    // replacing a racing writer's file, so a note is never overwritten. On a
    // collision move on to the next counter.
    while (publishExclusive(temp, absolute) === "exists") absolute = base(`-${counter++}`);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* the temp file may already be gone */ }
  }
  service.refresh();
  return { path: toDocRelative(service.docsRoot, absolute), absolute, slug };
}

// ---------------------------------------------------------------- tool output

/** Bounded, marker-carrying text for the docs_search tool. */
export function formatSearchResults(results: DocSearchResult[], query: string): string {
  if (!results.length) return `no docs match ${JSON.stringify(query)}`;
  const lines: string[] = [];
  for (const page of results) {
    const markers = docMarkers(page);
    const markerText = markers.length ? ` [${markers.join(", ")}]` : "";
    lines.push(`docs/${page.path} — ${page.title} (${page.type ?? "untyped"}, ${page.status ?? "unknown"}, ${page.updated ?? "no date"})${markerText} score ${page.score.toFixed(2)}`);
    const snippet = page.snippet.replace(/\s+/g, " ").trim();
    if (snippet) lines.push(`  …${snippet}…`);
    for (const diagnostic of page.diagnostics) lines.push(`  ! ${diagnostic}`);
  }
  return lines.join("\n");
}

/** Bounded text for the docs_read tool: metadata, freshness, links and content. */
export function formatReadResult(result: DocReadResult): string {
  const markers = docMarkers(result);
  const markerText = markers.length ? ` [${markers.join(", ")}]` : "";
  const lines = [`docs/${result.path} — ${result.title} (${result.type ?? "untyped"}, ${result.status ?? "unknown"}, ${result.updated ?? "no date"})${markerText}`];
  if (result.verified) lines.push(`verified: ${result.verified}`);
  if (result.stale) lines.push(`stale: ${result.staleReasons.join("; ")}`);
  for (const diagnostic of result.diagnostics) lines.push(`! ${diagnostic}`);
  const links = result.links.map((link) => `${link.target} → ${link.targetPath ?? link.resolution}`);
  if (links.length) lines.push(`links: ${links.join(", ")}`);
  if (result.backlinks.length) lines.push(`backlinks: ${result.backlinks.join(", ")}`);
  if (result.heading) lines.push(`heading: ${result.heading}`);
  lines.push("", result.content);
  return lines.join("\n").replace(/\s+$/, "");
}

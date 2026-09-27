import * as path from "node:path";
import { isValidRepoGlob } from "./glob.ts";

export const DOC_TYPES = ["guide", "reference", "decision", "glossary", "runbook", "note"] as const;
export const DOC_STATUSES = ["draft", "current", "deprecated"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type DocStatus = (typeof DOC_STATUSES)[number];

export interface DocFrontmatter {
  title: string;
  type: DocType | null;
  status: DocStatus | null;
  summary: string | null;
  tags: string[];
  aliases: string[];
  paths: string[] | null;
  related: string[];
  verified: string | null;
}

export interface ParsedDoc extends DocFrontmatter {
  body: string;
  headings: string[];
  diagnostics: string[];
  hadFrontmatter: boolean;
}

const KNOWN_KEYS = new Set(["title", "type", "status", "summary", "tags", "aliases", "paths", "related", "verified"]);

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseScalar(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (value.startsWith("\"") || value.endsWith("\"")) {
    if (!(value.startsWith("\"") && value.endsWith("\""))) throw new Error("unclosed double-quoted string");
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded !== "string") throw new Error("expected a string");
      return decoded;
    } catch (error) {
      throw new Error(`invalid double-quoted string (${String(error)})`);
    }
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (!(value.startsWith("'") && value.endsWith("'"))) throw new Error("unclosed single-quoted string");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:[|>&*!]|\{|\}|\[|\])/.test(value)) throw new Error("unsupported YAML value; use a string or a string list");
  return value.replace(/\s+#.*$/, "").trim();
}

function parseInlineList(input: string): string[] {
  const value = input.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("expected a YAML string list");
  const inside = value.slice(1, -1).trim();
  if (!inside) return [];
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < inside.length; i++) {
    const char = inside[i];
    if (quote === '"' && char === "\\") { i++; continue; }
    if (quote && char === quote) {
      if (quote === "'" && inside[i + 1] === "'") { i++; continue; }
      quote = undefined;
    } else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (!quote && char === ",") {
      parts.push(inside.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote) throw new Error("unclosed quoted list value");
  parts.push(inside.slice(start).trim());
  if (parts.some((part) => !part)) throw new Error("empty item in YAML string list");
  return parts.map(parseScalar);
}

interface RawFrontmatter {
  values: Map<string, unknown>;
  errors: string[];
}

/** Parses only simple `key: value`, inline string lists, and indented `- item` lists. */
function parseYamlSubset(source: string): RawFrontmatter {
  const values = new Map<string, unknown>();
  const errors: string[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!entry) {
      errors.push(`Line ${i + 1}: expected a frontmatter key and value`);
      continue;
    }
    const [, key, rawValue] = entry;
    if (values.has(key)) {
      errors.push(`Duplicate frontmatter field "${key}"`);
      continue;
    }
    const value = rawValue.trim();
    if (!value) {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || /^\s*#/.test(lines[j]))) j++;
      if (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        for (; j < lines.length && /^\s+-\s+/.test(lines[j]); j++) {
          try { items.push(parseScalar(lines[j].replace(/^\s+-\s+/, ""))); }
          catch (error) { errors.push(`Line ${j + 1}: ${String(error)}`); }
        }
        values.set(key, items);
        i = j - 1;
      } else values.set(key, "");
      continue;
    }
    try {
      values.set(key, value.startsWith("[") ? parseInlineList(value) : parseScalar(value));
    } catch (error) {
      errors.push(`Field "${key}": ${String(error)}`);
    }
  }
  return { values, errors };
}

function firstH1(body: string): string | undefined {
  return body.split(/\r?\n/).map((line) => /^\s*#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim()).find(Boolean);
}

function firstParagraph(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let collecting = false;
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (collecting) break;
      continue;
    }
    if (!collecting && (/^\s*#{1,6}\s/.test(line) || /^\s*```/.test(line) || /^\s*~~~/.test(line))) continue;
    collecting = true;
    parts.push(line.trim());
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function asString(value: unknown, field: string, diagnostics: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    diagnostics.push(`Field "${field}" must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function asList(value: unknown, field: string, diagnostics: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    diagnostics.push(`Field "${field}" must be a list of non-empty strings`);
    return undefined;
  }
  return value.map((item) => (item as string).trim());
}

/** Parse Genie docs frontmatter with graceful fallbacks; unsupported YAML is diagnostic, not fatal. */
export function parseDoc(markdown: string, relativePath: string): ParsedDoc {
  const diagnostics: string[] = [];
  let body = markdown;
  let hadFrontmatter = false;
  let raw: RawFrontmatter = { values: new Map(), errors: [] };
  if (/^---\r?\n/.test(markdown)) {
    const end = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
    if (end) {
      hadFrontmatter = true;
      body = markdown.slice(end[0].length);
      raw = parseYamlSubset(end[1]);
      diagnostics.push(...raw.errors);
    } else {
      diagnostics.push("Frontmatter opening delimiter has no closing ---; indexed the full file as Markdown");
    }
  }
  for (const key of raw.values.keys()) if (!KNOWN_KEYS.has(key)) diagnostics.push(`Unknown frontmatter field "${key}"`);

  const value = (key: string) => raw.values.get(key);
  const titleValue = value("title");
  let title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : undefined;
  if (titleValue !== undefined && !title) diagnostics.push('Field "title" must be a non-empty string');
  title ??= firstH1(body) ?? path.basename(relativePath, path.extname(relativePath));

  const summaryValue = value("summary");
  let summary: string | null = null;
  if (summaryValue !== undefined) {
    if (typeof summaryValue === "string" && !/[\r\n]/.test(summaryValue)) summary = summaryValue.trim() || null;
    else diagnostics.push('Field "summary" must be a single-line string');
  }
  summary ??= firstParagraph(body) ?? null;

  const enumValue = <T extends string>(key: string, choices: readonly T[]): T | null => {
    const v = value(key);
    if (v === undefined) return null;
    if (typeof v === "string" && choices.includes(v as T)) return v as T;
    diagnostics.push(`Field "${key}" must be one of: ${choices.join(", ")}`);
    return null;
  };
  const listValue = (key: string): string[] => {
    const v = value(key);
    if (v === undefined) return [];
    return asList(v, key, diagnostics) ?? [];
  };

  const rawPaths = value("paths");
  let paths: string[] | null = null;
  if (rawPaths !== undefined) {
    const parsedPaths = asList(rawPaths, "paths", diagnostics);
    if (parsedPaths) {
      paths = [];
      for (const pattern of parsedPaths) {
        if (isValidRepoGlob(pattern)) paths.push(pattern);
        else diagnostics.push(`Field "paths" contains invalid repository glob "${pattern}"`);
      }
    }
  }

  const rawVerified = value("verified");
  let verified: string | null = null;
  if (rawVerified !== undefined) {
    if (typeof rawVerified === "string" && validDate(rawVerified)) verified = rawVerified;
    else diagnostics.push('Field "verified" must be an ISO date in YYYY-MM-DD form');
  }

  const headings = body.split(/\r?\n/).map((line) => /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim()).filter((heading): heading is string => !!heading);
  return {
    title,
    type: enumValue("type", DOC_TYPES),
    status: enumValue("status", DOC_STATUSES),
    summary,
    tags: listValue("tags"),
    aliases: listValue("aliases"),
    paths,
    related: listValue("related"),
    verified,
    body,
    headings,
    diagnostics,
    hadFrontmatter,
  };
}

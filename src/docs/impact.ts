// Non-blocking docs impact: for a task in review/done, list the documentation
// pages its changed code may have made stale, each with a structured reason.
//
// This is a hint, never a gate: nothing in the status-transition path calls it,
// and every failure degrades to an empty result plus a note. The changed-path
// computation and the reason vocabulary are the contract the later blocking
// docs gate (epic G-4 artifact #3) must reuse, so they live in exactly one place.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Status } from "../tracker/model.ts";
import { globMatches } from "./glob.ts";
import type { DocStatus, DocType } from "./parser.ts";
import type { DocPage, DocsService } from "./service.ts";

/** Statuses for which the impact hint is meaningful; other statuses expose `applicable:false`. */
export const IMPACT_STATUSES: Status[] = ["review", "done"];

/** Why a page is a candidate: a changed path matched its `paths`, or its `related` names the task/epic. */
export type DocsImpactReason =
  | { kind: "changed-path"; path: string; pattern: string }
  | { kind: "related"; id: string };

export interface DocsImpactCandidate {
  /** Docs-relative page path (as in `DocPage.path`). */
  path: string;
  title: string;
  type: DocType | null;
  status: DocStatus | null;
  stale: boolean;
  staleReasons: string[];
  diagnostics: string[];
  reasons: DocsImpactReason[];
  /** English one-liner for CLI/logs; the web phrases the structured reasons itself. */
  summary: string;
}

export interface DocsImpactInput {
  id: string;
  status: Status;
  /** Task id plus its epic id; matched against a page's `related` frontmatter. */
  relatedIds?: string[];
  /** The task's worktree plus the team-record `base` commit (the tracker model has no base field). */
  worktree?: { path: string; branch?: string; base?: string };
}

export interface DocsImpactResult {
  taskId: string;
  status: Status;
  /** True when the status is one of `IMPACT_STATUSES`. */
  applicable: boolean;
  changedPathsAvailable: boolean;
  /** Repo-relative changed paths, docs-root files excluded, sorted and deduped. */
  changedPaths: string[];
  /** Stable English degradation reasons; empty when the diff was fully available. */
  notes: string[];
  candidates: DocsImpactCandidate[];
}

/** Cap reasons kept per page so a broad glob cannot explode the CLI/UI output. */
const MAX_REASONS_PER_PAGE = 8;

interface ChangedPaths {
  available: boolean;
  paths: string[];
  notes: string[];
}

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** `git status --porcelain=v1 -z`, rename/copy aware — same parsing as `src/docs/service.ts`. */
function parseStatusPaths(status: string): string[] {
  const chunks = status.split("\0").filter(Boolean);
  const result: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const match = /^(.{2}) (.*)$/s.exec(chunks[i]);
    if (!match) continue;
    const [, code, file] = match;
    result.push(file);
    if (/[RC]/.test(code) && chunks[i + 1]) result.push(chunks[++i]);
  }
  return result;
}

function isDocsFile(repoPath: string, docsRootRelative: string): boolean {
  return repoPath === docsRootRelative || repoPath.startsWith(`${docsRootRelative}/`);
}

function safeGlobMatch(pattern: string, repoPath: string): boolean {
  try {
    return globMatches(pattern, repoPath);
  } catch {
    return false;
  }
}

/**
 * Best-effort changed repo paths for a task worktree, never throwing.
 *
 * `available` is true once the worktree is a usable git working tree: a recorded
 * but unreachable base is a *partial* degradation (a note, not an unavailable
 * result), because `git status` still yields dirty/untracked evidence.
 */
export function changedPathsForWorktree(
  worktree: DocsImpactInput["worktree"],
  docsRootRelative: string,
): ChangedPaths {
  if (!worktree?.path) return { available: false, paths: [], notes: ["no team worktree for this task"] };
  const root = worktree.path;
  try {
    if (!fs.existsSync(root)) return { available: false, paths: [], notes: [`worktree ${root} does not exist`] };
    const top = runGit(root, ["rev-parse", "--show-toplevel"]);
    if (!top || path.resolve(top.trim()) !== path.resolve(root)) {
      return { available: false, paths: [], notes: [`worktree ${root} is not a git working tree`] };
    }
    const notes: string[] = [];
    const paths = new Set<string>();
    if (!worktree.base) {
      notes.push("no base commit recorded for the team");
    } else {
      const base = worktree.base.trim();
      const verified = runGit(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
      const diff = verified ? runGit(root, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]) : undefined;
      if (diff === undefined) {
        notes.push(`base ${base} is not reachable from the worktree`);
      } else {
        for (const line of diff.split(/\r?\n/)) if (line.trim()) paths.add(line.trim());
        if (!paths.size) notes.push(`no changes found between ${base} and HEAD`);
      }
    }
    const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status !== undefined) for (const file of parseStatusPaths(status)) paths.add(file);
    return {
      available: true,
      paths: [...paths].filter((file) => !isDocsFile(file, docsRootRelative)).sort(),
      notes,
    };
  } catch (error) {
    return { available: false, paths: [], notes: [`worktree ${root} could not be inspected: ${String(error)}`] };
  }
}

interface WorkingCandidate {
  candidate: DocsImpactCandidate;
  matchedPaths: number;
}

function toCandidate(input: DocsImpactInput, page: DocPage, changedPaths: string[]): WorkingCandidate {
  const relatedIds = new Set([input.id, ...(input.relatedIds ?? [])].map((id) => id.trim().toUpperCase()).filter(Boolean));
  const patterns = page.paths ?? [];
  const reasons: DocsImpactReason[] = [];
  let matchedPaths = 0;
  for (const pattern of patterns) {
    for (const changedPath of changedPaths) {
      if (!safeGlobMatch(pattern, changedPath)) continue;
      matchedPaths++;
      if (reasons.length < MAX_REASONS_PER_PAGE) reasons.push({ kind: "changed-path", path: changedPath, pattern });
    }
  }
  const related = page.related.filter((id) => relatedIds.has(id.trim().toUpperCase()));
  for (const id of related) {
    if (reasons.length < MAX_REASONS_PER_PAGE) reasons.push({ kind: "related", id });
  }
  const summary = reasons
    .map((reason) => (reason.kind === "changed-path" ? `changes ${reason.path} (page paths ${reason.pattern})` : `related to ${reason.id}`))
    .join("; ");
  return {
    matchedPaths,
    candidate: {
      path: page.path,
      title: page.title,
      type: page.type,
      status: page.status,
      stale: page.stale,
      staleReasons: page.staleReasons,
      diagnostics: page.diagnostics,
      reasons,
      summary,
    },
  };
}

/**
 * Compute the non-blocking docs-impact hint. Never throws: a missing worktree,
 * missing history or an unavailable docs index all degrade to a result with a
 * note, so no caller (CLI, web, future gate) can turn the hint into a failure.
 */
export function computeDocsImpact(service: DocsService, input: DocsImpactInput): DocsImpactResult {
  const notes: string[] = [];
  let changedPaths: string[] = [];
  let changedPathsAvailable = false;
  try {
    const docsRootRelative = path.relative(service.projectRoot, service.docsRoot).split(path.sep).join("/");
    const changed = changedPathsForWorktree(input.worktree, docsRootRelative);
    changedPaths = changed.paths;
    changedPathsAvailable = changed.available;
    notes.push(...changed.notes);
  } catch (error) {
    notes.push(String(error));
  }

  let pages: DocPage[] = [];
  try {
    pages = service.list();
  } catch (error) {
    notes.push(`docs index unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const working: WorkingCandidate[] = [];
  for (const page of pages) {
    const item = toCandidate(input, page, changedPaths);
    if (item.matchedPaths === 0 && !item.candidate.reasons.some((reason) => reason.kind === "related")) continue;
    // Deprecated pages survive only through an explicit `related` match.
    if (page.status === "deprecated" && !item.candidate.reasons.some((reason) => reason.kind === "related")) continue;
    working.push(item);
  }
  working.sort((a, b) => {
    const groupA = a.matchedPaths > 0 ? 0 : 1;
    const groupB = b.matchedPaths > 0 ? 0 : 1;
    if (groupA !== groupB) return groupA - groupB;
    if (a.matchedPaths !== b.matchedPaths) return b.matchedPaths - a.matchedPaths;
    if (a.candidate.stale !== b.candidate.stale) return a.candidate.stale ? -1 : 1;
    return a.candidate.path.localeCompare(b.candidate.path);
  });

  return {
    taskId: input.id,
    status: input.status,
    applicable: IMPACT_STATUSES.includes(input.status),
    changedPathsAvailable,
    changedPaths,
    notes,
    candidates: working.map((item) => item.candidate),
  };
}

/** Human/CLI rendering of a result; the web renders the structured reasons itself. */
export function renderDocsImpact(result: DocsImpactResult): string {
  const lines = ["## Docs impact (non-blocking)"];
  if (result.candidates.length) {
    for (const candidate of result.candidates) {
      const markers = [
        ...(candidate.status === "draft" || candidate.status === "deprecated" ? [candidate.status] : []),
        ...(candidate.stale ? ["stale"] : []),
        ...(candidate.diagnostics.length ? [`diagnostics:${candidate.diagnostics.length}`] : []),
      ];
      const suffix = markers.length ? ` [${markers.join(", ")}]` : "";
      lines.push(`- ${candidate.path} — ${candidate.title} (${candidate.type ?? "untyped"}, ${candidate.status ?? "status unknown"})${suffix}`);
      if (candidate.summary) lines.push(`    ${candidate.summary}`);
    }
  } else {
    lines.push("no documentation page looks affected");
  }
  for (const note of result.notes) {
    lines.push(result.changedPathsAvailable ? `note: ${note}` : `changed paths unavailable: ${note}`);
  }
  return lines.join("\n");
}

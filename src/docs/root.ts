import * as fs from "node:fs";
import * as path from "node:path";
import { repoInfo } from "../tracker/fsutil.ts";

function realpath(file: string): string {
  try { return fs.realpathSync(file); }
  catch { return path.resolve(file); }
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve the checkout containing cwd, with the specified non-git tracker fallback. */
export function resolveProjectRoot(cwd: string, trackerDir?: string): string {
  const caller = realpath(path.resolve(cwd));
  const repo = repoInfo(caller);
  if (repo?.toplevel) return realpath(repo.toplevel);
  if (trackerDir) {
    const owner = realpath(path.dirname(path.resolve(trackerDir)));
    if (isPathInside(owner, caller)) return owner;
  }
  return caller;
}

function validateRelativeRoot(configuredRoot: string): string {
  const value = configuredRoot.trim();
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) throw new Error("docs.root must be a non-empty project-relative path");
  const pieces = value.split(/[\\/]+/);
  if (pieces.some((piece) => piece === ".." || piece === ".")) throw new Error("docs.root may not contain . or .. path segments");
  return pieces.join(path.sep);
}

function realpathWithMissingTail(candidate: string): string {
  const missing: string[] = [];
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.realpathSync(current);
  return path.resolve(real, ...missing);
}

/** Resolve configured docs root and ensure existing symlinks do not leave the project. */
export function resolveDocsRoot(projectRoot: string, configuredRoot = "docs"): string {
  const root = realpath(path.resolve(projectRoot));
  const relative = validateRelativeRoot(configuredRoot);
  const candidate = path.resolve(root, relative);
  if (!isPathInside(root, candidate)) throw new Error("docs.root must stay inside the project root");
  const canonical = realpathWithMissingTail(candidate);
  if (!isPathInside(root, canonical)) throw new Error(`docs.root resolves outside the project root: ${configuredRoot}`);
  return canonical;
}

function safeDocRelative(input: string): string {
  if (!input.trim() || input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw new Error(`invalid docs path: ${input}`);
  }
  const pieces = input.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) throw new Error(`invalid docs path: ${input}`);
  return pieces.join(path.sep);
}

/** Resolve a docs-relative Markdown path and reject traversal or symlink escapes. */
export function resolveDocPath(docsRoot: string, input: string): string {
  const relative = safeDocRelative(input);
  const withExtension = path.extname(relative) ? relative : `${relative}.md`;
  if (!/\.md$/i.test(withExtension)) throw new Error("docs paths must name Markdown files ending in .md");
  const canonicalRoot = realpathWithMissingTail(docsRoot);
  const candidate = path.resolve(canonicalRoot, withExtension);
  if (!isPathInside(canonicalRoot, candidate)) throw new Error(`docs path escapes docs.root: ${input}`);
  const canonicalCandidate = realpathWithMissingTail(candidate);
  if (!isPathInside(canonicalRoot, canonicalCandidate)) throw new Error(`docs path resolves outside docs.root: ${input}`);
  return canonicalCandidate;
}

export function toDocRelative(docsRoot: string, file: string): string {
  const relative = path.relative(docsRoot, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`file is outside docs.root: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

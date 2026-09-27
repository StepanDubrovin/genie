import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const GENIE_DIRNAME = ".genie";

export function now(): string {
  return new Date().toISOString();
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Atomic write: readers never see a partially written file. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lock based on atomic mkdir. Several agents (separate pi
 * processes) write to the same tracker, so every read-modify-write runs under it.
 */
export function withLock<T>(dir: string, fn: () => T, timeoutMs = 10_000): T {
  const lock = path.join(dir, ".lock");
  const staleMs = 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`genie: timed out waiting for lock ${lock}`);
      sleepSync(25 + Math.random() * 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export interface RepoInfo {
  /** Root of the current checkout (may be a linked worktree). */
  toplevel: string;
  /** Root of the main worktree, which owns the shared tracker. */
  mainRoot: string;
  branch?: string;
}

export function repoInfo(cwd: string): RepoInfo | undefined {
  const toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return undefined;
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const mainRoot = common && path.basename(common) === ".git" ? path.dirname(common) : toplevel;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { toplevel, mainRoot, branch: branch && branch !== "HEAD" ? branch : undefined };
}

export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Locate the shared tracker directory.
 * 1. $GENIE_DIR (team members always get it, so worktrees share one tracker)
 * 2. `.genie/` in the main worktree of the current git repository
 * 3. the nearest `.genie/` walking up from cwd (non-git projects, e.g. pure ABAP work)
 */
export function findGenieDir(cwd: string): string | undefined {
  const env = process.env.GENIE_DIR;
  if (env && fs.existsSync(path.join(env, "genie.db"))) return path.resolve(env);
  const repo = repoInfo(cwd);
  if (repo) {
    const candidate = path.join(repo.mainRoot, GENIE_DIRNAME);
    if (fs.existsSync(path.join(candidate, "genie.db"))) return candidate;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, GENIE_DIRNAME);
    if (fs.existsSync(path.join(candidate, "genie.db"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Where `genie init` should create the tracker for this cwd. */
export function defaultGenieDir(cwd: string): string {
  const repo = repoInfo(cwd);
  return path.join(repo ? repo.mainRoot : path.resolve(cwd), GENIE_DIRNAME);
}

/** Keep the tracker out of commits without touching the tracked .gitignore. */
export function excludeFromGit(genieDir: string): void {
  const root = path.dirname(genieDir);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return;
  const exclude = path.join(common, "info", "exclude");
  const line = `/${GENIE_DIRNAME}/`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

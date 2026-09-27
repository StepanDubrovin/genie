// SQLite access that works in both runtimes genie runs in:
//   - pi (a Bun-compiled binary)  → bun:sqlite
//   - the CLI and web server (Node) → node:sqlite
// Only positional `?` parameters are used, so both drivers behave the same.

import { createRequire } from "node:module";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | null | undefined;
  all(...params: SqlValue[]): Row[];
}

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

function openRaw(file: string): RawDb {
  const bun = (globalThis as { Bun?: unknown }).Bun;
  if (bun) {
    const { Database } = createRequire(import.meta.url)("bun:sqlite") as { Database: new (f: string, o?: object) => RawDb };
    return new Database(file, { create: true });
  }
  const mod = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (f: string) => RawDb };
  return new mod.DatabaseSync(file);
}

export class Db {
  private raw: RawDb;
  private cache = new Map<string, Statement>();
  private depth = 0;

  constructor(file: string) {
    this.raw = openRaw(file);
    this.raw.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return (this.stmt(sql).get(...params) ?? undefined) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Write transaction; BEGIN IMMEDIATE takes the write lock up front so concurrent writers queue instead of failing. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** Changes whenever another connection commits; cheap way to detect updates. */
  dataVersion(): number {
    return Number(this.get<{ data_version: number }>("PRAGMA data_version")?.data_version ?? 0);
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  parent TEXT REFERENCES tasks(id),
  labels TEXT NOT NULL DEFAULT '[]',
  assignees TEXT NOT NULL DEFAULT '[]',
  team TEXT,
  worktree TEXT,
  blocked TEXT,
  needs_owner TEXT,
  merge_strategy TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent);
CREATE TABLE IF NOT EXISTS deps (
  task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dep TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task, dep)
);
CREATE TABLE IF NOT EXISTS acceptance (
  task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  checked_by TEXT,
  checked_at TEXT,
  PRIMARY KEY (task, n)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  author TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_task ON comments(task);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  at TEXT NOT NULL,
  author TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  size INTEGER NOT NULL,
  content BLOB NOT NULL,
  UNIQUE (task, n)
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS history_task ON history(task);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  template TEXT,
  cwd TEXT NOT NULL,
  worktree TEXT,
  state TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  team TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  thinking TEXT,
  instructions TEXT,
  status TEXT NOT NULL,
  status_at TEXT NOT NULL,
  state TEXT NOT NULL,
  activity TEXT NOT NULL DEFAULT 'idle',
  activity_at TEXT,
  runtime TEXT,
  session_file TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team, name)
);
CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT,
  at TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  task TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS mail_pending ON mail(recipient, delivered_at);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS log_team ON log(team);
`;

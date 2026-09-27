import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { globMatches } from "../src/docs/glob.ts";
import { parseDoc } from "../src/docs/parser.ts";
import { DocsService } from "../src/docs/service.ts";
import { resolveDocPath, resolveDocsRoot, resolveProjectRoot } from "../src/docs/root.ts";
import { Tracker } from "../src/tracker/store.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-docs-test-"));
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "docs-test@example.com");
  git(root, "config", "user.name", "Docs Test");
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.email=docs-test@example.com", "-c", "user.name=Docs Test", "commit", "-q", "-m", message, "--allow-empty");
}

function write(root: string, relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function createTracker(root: string): Tracker {
  return Tracker.init(path.join(root, ".genie"));
}

function service(root: string, tracker: Tracker, docsRoot = "docs"): DocsService {
  return new DocsService({ db: tracker.db, cwd: root, trackerDir: tracker.dir, docsRoot });
}

const fm = (body: string, metadata = "") => `---\n${metadata}---\n${body}`;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Locate a Bun runtime: `bun` on PATH, `GENIE_BUN_BIN`, or a pi-embedded Bun (started with BUN_BE_BUN=1). */
function bunRuntime(): { command: string; args: string[]; env?: Record<string, string> } | undefined {
  const override = process.env.GENIE_BUN_BIN;
  if (override && fs.existsSync(override)) return { command: override, args: ["run"] };
  const direct = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (!direct.error && direct.status === 0) return { command: "bun", args: ["run"] };
  const installs = path.join(os.homedir(), ".local", "share", "mise", "installs", "pi");
  if (fs.existsSync(installs)) {
    for (const version of fs.readdirSync(installs).sort().reverse()) {
      const binary = path.join(installs, version, "pi", "pi");
      if (fs.existsSync(binary)) return { command: binary, args: ["run"], env: { BUN_BE_BUN: "1" } };
    }
  }
  return undefined;
}

function bunProbeSource(): string {
  const source = (relative: string) => path.join(REPO_ROOT, relative).split(path.sep).join("/");
  return `import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from ${JSON.stringify(source("src/tracker/db.ts"))};
import { DocsService } from ${JSON.stringify(source("src/docs/service.ts"))};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "genie-docs-bun-"));
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "ru.md"), "---\\ntitle: Ёжик\\ntype: guide\\n---\\n\\nМаленький ёжик живёт в лесу.\\n");
fs.writeFileSync(path.join(root, "docs", "en.md"), "---\\ntitle: Résumé\\n---\\n\\nBrowser sessions.\\n");
const db = new Db(path.join(root, "cache.sqlite"));
const docs = new DocsService({ db, cwd: root });
const found = (q: string) => docs.search(q)[0]?.path ?? "none";
console.log("BUN_SMOKE " + ["ёжик", "ежик", "ЁЖИК"].map((q) => q + ":" + found(q)).join(" ") + " accent:" + found("resume") + " bm25:" + (docs.search("sessions")[0]!.score < 0) + " pages:" + docs.list().length);
db.close();
`;
}

test("frontmatter subset, fallbacks, and malformed YAML diagnostics preserve searchable body", () => {
  const parsed = parseDoc(fm("# Fallback title\n\nFirst paragraph, ёжик.", "type: guide\nstatus: current\ntags: [auth, 'вход']\npaths:\n  - src/auth/**\nverified: 2026-09-27\n"), "fallback.md");
  assert.equal(parsed.title, "Fallback title");
  assert.equal(parsed.summary, "First paragraph, ёжик.");
  assert.deepEqual(parsed.tags, ["auth", "вход"]);
  assert.deepEqual(parsed.paths, ["src/auth/**"]);
  assert.equal(parsed.verified, "2026-09-27");
  assert.deepEqual(parsed.diagnostics, []);

  const malformed = parseDoc(fm("# Body fallback\n\nKeep this searchable secret phrase.", "title: [broken\nupdated: fabricated\nverified: 2025-02-30\n"), "malformed.md");
  assert.equal(malformed.title, "Body fallback");
  assert.match(malformed.body, /searchable secret phrase/);
  assert.ok(malformed.diagnostics.length >= 2);
  const absent = parseDoc("Plain body.", "plain-name.md");
  assert.equal(absent.title, "plain-name");
  assert.equal(absent.paths, null);
  assert.equal(absent.verified, null);
});

test("glob matcher follows POSIX segment boundaries and case sensitivity", () => {
  assert.equal(globMatches("src/auth/**", "src/auth/a/b.ts"), true);
  assert.equal(globMatches("src/**/file.ts", "src/file.ts"), true);
  assert.equal(globMatches("src/**/file.ts", "src/a/b/file.ts"), true);
  assert.equal(globMatches("src/auth/**", "src/authz/a.ts"), false);
  assert.equal(globMatches("src/a?.ts", "src/ab.ts"), true);
  assert.equal(globMatches("src/a?.ts", "src/abc.ts"), false);
  assert.equal(globMatches("SRC/**", "src/a.ts"), false);
  assert.equal(globMatches("src/file.ts", "src/file.ts"), true);
});

test("project/docs roots use checkout and tracker ancestry, rejecting traversal and symlink escapes", () => {
  const project = tmp();
  initGit(project);
  commit(project, "initial");
  assert.equal(resolveProjectRoot(project), fs.realpathSync(project));

  const nonGit = tmp();
  const nested = path.join(nonGit, "src", "nested");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveProjectRoot(nested, path.join(nonGit, ".genie")), fs.realpathSync(nonGit));
  write(nonGit, "docs/non-git.md", "# Non-git docs\n\nIndexed from the tracker-owning ancestor.");
  const nonGitTracker = createTracker(nonGit);
  const nonGitDocs = new DocsService({ db: nonGitTracker.db, cwd: nested, trackerDir: nonGitTracker.dir });
  assert.equal(nonGitDocs.list()[0]?.rootId, fs.realpathSync(nonGit));
  assert.equal(nonGitDocs.search("ancestor")[0]?.path, "non-git.md");
  nonGitTracker.db.close();
  const unrelated = tmp();
  assert.equal(resolveProjectRoot(nested, path.join(unrelated, ".genie")), fs.realpathSync(nested));

  assert.throws(() => resolveDocsRoot(project, "../outside"), /relative|\.\.|inside/);
  const outside = tmp();
  fs.symlinkSync(outside, path.join(project, "linked-docs"), "dir");
  assert.throws(() => resolveDocsRoot(project, "linked-docs"), /outside/);
  const docs = resolveDocsRoot(project);
  assert.throws(() => resolveDocPath(docs, "../secret.md"), /invalid docs path/);
  fs.mkdirSync(docs, { recursive: true });
  write(outside, "private.md", "secret");
  fs.symlinkSync(path.join(outside, "private.md"), path.join(docs, "escape.md"));
  assert.throws(() => resolveDocPath(docs, "escape.md"), /outside/);
});

test("service honors a custom docs.root and rejects escapes at construction", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "documentation/guide.md", fm("# Guide\n\ncustom root body"));
  const custom = new DocsService({ db: tracker.db, cwd: root, trackerDir: tracker.dir, docsRoot: "documentation" });
  assert.equal(custom.docsRoot, path.join(fs.realpathSync(root), "documentation"));
  assert.equal(custom.search("custom root")[0]?.path, "guide.md");
  assert.throws(() => new DocsService({ db: tracker.db, cwd: root, trackerDir: tracker.dir, docsRoot: "../escape" }), /relative|\.\.|inside/);
  assert.throws(() => new DocsService({ db: tracker.db, cwd: root, trackerDir: tracker.dir, docsRoot: "/etc" }), /relative|inside/);
  tracker.db.close();
});

test("lazy docs schema keeps Tracker.open and task operations independent of FTS5", () => {
  const root = tmp();
  const tracker = createTracker(root);
  tracker.create({ name: "owner", role: "human" }, { title: "Works without docs" });
  assert.equal(tracker.db.get<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'docs_%'")?.count, 0);
  const savedGenieDir = process.env.GENIE_DIR;
  delete process.env.GENIE_DIR;
  let reopened: Tracker;
  try { reopened = Tracker.open(root); }
  finally { if (savedGenieDir !== undefined) process.env.GENIE_DIR = savedGenieDir; }
  assert.equal(reopened.get("G-1").title, "Works without docs");
  assert.equal(reopened.db.get<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'docs_%'")?.count, 0);
  reopened.db.close();
  tracker.db.close();
});

test("a simulated FTS5-less SQLite build fails docs locally without breaking task tracking", () => {
  const root = tmp();
  const tracker = createTracker(root);
  const noFtsDb = new Proxy(tracker.db, {
    get(target, property) {
      if (property === "exec") return (sql: string) => {
        if (sql.includes("CREATE VIRTUAL TABLE") && sql.includes("docs_pages_fts")) throw new Error("no such module: fts5");
        return target.exec(sql);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const docs = new DocsService({ db: noFtsDb, cwd: root, trackerDir: tracker.dir });
  assert.throws(() => docs.refresh(), /Genie docs are unavailable:.*FTS5/);
  const task = tracker.create({ name: "owner", role: "human" }, { title: "Still works" });
  assert.equal(tracker.get(task.id).title, "Still works");
  tracker.db.close();
});

test("indexing exposes malformed-file diagnostics and keeps its Markdown searchable", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/broken.md", fm("# Fallback\n\nneedle unique searchable body", "title: [not valid\n"));
  const docs = service(root, tracker);
  const results = docs.search("needle");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Fallback");
  assert.ok(results[0].diagnostics.length > 0);
  assert.equal(docs.getDiagnostics().length, 1);
  tracker.db.close();
});

test("FTS5 English/Russian snippets rank matches and normalize ё/е symmetrically", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/russian.md", fm("# Ёжик\n\nМаленький ёжик живёт в лесу. Подробности для поиска.", "aliases: [ежик-лесной, сессия]\n"));
  write(root, "docs/english.md", fm("# Résumé\n\nAn authentication flow explains browser sessions."));
  const docs = service(root, tracker);
  for (const query of ["ёжик", "ежик", "ЁЖИК"]) {
    const [first] = docs.search(query);
    assert.equal(first?.path, "russian.md", `query: ${query}`);
    assert.match(first.snippet, /[её]жик/i, `Russian snippet for query: ${query}`);
  }
  assert.equal(docs.search("сессия")[0]?.path, "russian.md", "aliases are searchable");
  const english = docs.search("resume");
  assert.equal(english[0]?.path, "english.md");
  assert.match(english[0].snippet, /Résumé|resume/i);
  assert.equal(docs.search("authentication sessions")[0]?.path, "english.md");
  assert.ok(english[0].score < 0, "FTS5 bm25 score is returned (lower is better)");
  tracker.db.close();
});

test("links resolve canonically, expose ambiguity, and return backlinks", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/source.md", "# Source\n\n[[a/intro]] [[intro]] [[Missing]]");
  write(root, "docs/a/intro.md", "# A intro");
  write(root, "docs/b/intro.md", "# B intro");
  const docs = service(root, tracker);
  const source = docs.read("source", { wholePage: true });
  const byTarget = new Map(source.links.map((link) => [link.target, link]));
  assert.equal(byTarget.get("a/intro")?.resolution, "resolved");
  assert.equal(byTarget.get("a/intro")?.targetPath, "a/intro.md");
  assert.equal(byTarget.get("intro")?.resolution, "ambiguous");
  assert.equal(byTarget.get("Missing")?.resolution, "unresolved");
  assert.deepEqual(docs.read("a/intro", { wholePage: true }).backlinks, ["source.md"]);
  tracker.db.close();
});

test("incremental add/edit/delete/rename agrees with DROP-and-recreate rebuild", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/old.md", fm("# Old\n\nalpha needle"));
  const docs = service(root, tracker);
  assert.equal(docs.refresh().pages, 1);
  write(root, "docs/old.md", fm("# Edited\n\nbeta needle"));
  write(root, "docs/added.md", fm("# Added\n\ngamma"));
  fs.renameSync(path.join(root, "docs/old.md"), path.join(root, "docs/renamed.md"));
  fs.rmSync(path.join(root, "docs/added.md"));
  const incremental = docs.list();
  assert.deepEqual(incremental.map((page) => page.path), ["renamed.md"]);
  assert.equal(docs.search("beta")[0]?.path, "renamed.md");
  const rebuilt = docs.rebuild();
  assert.equal(rebuilt.pages, 1);
  assert.deepEqual(docs.list(), incremental);
  assert.equal(docs.search("alpha").length, 0);
  tracker.db.close();
});

test("staleness reports matching committed and dirty paths; updated is Git-derived and cached", () => {
  const root = tmp();
  initGit(root);
  write(root, "src/auth/session.ts", "export const version = 1;\n");
  write(root, "docs/auth.md", fm("# Authentication\n\nSessions.", "title: Authentication\ntype: reference\nstatus: current\npaths: [src/auth/**]\nverified: 2020-01-01\nupdated: 1999-01-01\n"));
  write(root, "docs/unrelated.md", fm("# Unrelated\n\nOther area.", "paths: [src/team/**]\nverified: 2020-01-01\n"));
  write(root, "docs/unverified.md", "# No freshness metadata\n\nUnknown, not stale.");
  commit(root, "initial docs and code");
  const lastCommit = git(root, "log", "-1", "--format=%cs", "--", "docs/auth.md");
  const tracker = createTracker(root);
  const docs = service(root, tracker);
  const pages = docs.list();
  const page = pages.find((item) => item.path === "auth.md")!;
  assert.equal(page.updated, lastCommit);
  assert.equal(page.stale, true);
  assert.match(page.staleReasons[0], /src\/auth\/session.ts/);
  assert.equal(pages.find((item) => item.path === "unrelated.md")?.stale, false);
  assert.equal(pages.find((item) => item.path === "unverified.md")?.stale, false);
  assert.notEqual(page.updated, "1999-01-01");
  const signature = tracker.db.get<{ git_signature: string }>("SELECT git_signature FROM docs_state WHERE root_id = ?", docs.rootId)?.git_signature;
  assert.ok(signature);
  docs.list();
  assert.equal(tracker.db.get<{ git_signature: string }>("SELECT git_signature FROM docs_state WHERE root_id = ?", docs.rootId)?.git_signature, signature);

  write(root, "src/auth/new-untracked.ts", "export const dirty = true;\n");
  const dirty = docs.list()[0];
  assert.ok(dirty.staleReasons.some((reason) => reason.includes("new-untracked.ts")));
  tracker.db.close();
});

test("cache rows are isolated by canonical root across linked worktrees", () => {
  const main = tmp();
  initGit(main);
  write(main, "docs/page.md", fm("# Main page\n\nmaincheckoutquartz"));
  commit(main, "main docs");
  const tracker = createTracker(main);
  const worktree = path.join(tmp(), "linked");
  git(main, "worktree", "add", "-q", "-b", "docs-worktree", worktree);
  write(worktree, "docs/page.md", fm("# Worktree page\n\nbranchcheckoutcobalt"));
  const mainDocs = service(main, tracker);
  const branchDocs = service(worktree, tracker);
  assert.notEqual(mainDocs.rootId, branchDocs.rootId);
  assert.equal(mainDocs.search("maincheckoutquartz")[0]?.title, "Main page");
  assert.equal(mainDocs.search("branchcheckoutcobalt").length, 0);
  assert.equal(branchDocs.search("branchcheckoutcobalt")[0]?.title, "Worktree page");
  assert.equal(branchDocs.search("maincheckoutquartz").length, 0);
  tracker.db.close();
});

test("section reads are bounded and carry an explicit truncation marker", () => {
  const root = tmp();
  const tracker = createTracker(root);
  write(root, "docs/sections.md", "# Intro\n\nshort\n\n## Details\n\n" + "long content ".repeat(30) + "\n\n## Next\n\nnext section");
  const docs = service(root, tracker);
  const section = docs.read("sections.md", { heading: "Details", maxChars: 20 });
  assert.equal(section.truncated, true);
  assert.match(section.content, /\[Truncated\]$/);
  assert.doesNotMatch(section.content, /next section/);
  assert.throws(() => docs.read("sections.md", { heading: "Missing" }), /heading not found/);
  assert.throws(() => docs.read("sections.md"), /whole-page reads must be explicit/);
  tracker.db.close();
});

const bun = bunRuntime();
test("Bun (pi-embedded) smoke: real docs service uses FTS5 bm25, snippets and ё/е on bun:sqlite", { skip: bun ? false : "no Bun runtime available" }, () => {
  const dir = tmp();
  const probe = path.join(dir, "bun-probe.ts");
  fs.writeFileSync(probe, bunProbeSource());
  const result = spawnSync(bun!.command, [...bun!.args, probe], {
    encoding: "utf8",
    env: { ...process.env, ...bun!.env },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `Bun smoke probe failed:\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("BUN_SMOKE"));
  assert.ok(line, `Bun smoke probe produced no result:\n${result.stdout}\n${result.stderr}`);
  assert.match(line, /ёжик:ru\.md/);
  assert.match(line, /ежик:ru\.md/);
  assert.match(line, /ЁЖИК:ru\.md/);
  assert.match(line, /accent:en\.md/);
  assert.match(line, /bm25:true/);
  assert.match(line, /pages:2/);
});

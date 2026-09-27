import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src", "cli", "genie.ts");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-cli-docs-"));
}

function write(root: string, relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "cli-docs-test@example.com");
  git(root, "config", "user.name", "CLI Docs Test");
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.email=cli-docs-test@example.com", "-c", "user.name=CLI Docs Test", "commit", "-q", "-m", message, "--allow-empty");
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in a child process without inheriting this session's tracker override. */
function cli(cwd: string, args: string[], env: Record<string, string> = {}): CliResult {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "GENIE_DIR") clean[key] = value;
  Object.assign(clean, env);
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: clean,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function cliJson<T>(cwd: string, args: string[], env: Record<string, string> = {}): T {
  const result = cli(cwd, args, env);
  assert.equal(result.status, 0, `genie ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

function initTracker(root: string): void {
  const result = cli(root, ["init"]);
  assert.equal(result.status, 0, result.stderr);
}

const fm = (body: string, metadata = "") => `---\n${metadata}---\n${body}`;

test("docs tree lists the caller's pages with draft and diagnostic markers", () => {
  const root = tmp();
  write(root, "docs/guide.md", fm("Guide body", "title: Guide\ntype: guide\nstatus: current\n"));
  write(root, "docs/wip.md", fm("Work in progress", "title: WIP\ntype: note\nstatus: draft\n"));
  write(root, "docs/broken.md", fm("# Broken fallback\n\nbody", "title: [broken\n"));
  initTracker(root);

  const text = cli(root, ["docs", "tree"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /guide\.md {2}Guide \(guide, current\)/);
  assert.match(text.stdout, /wip\.md {2}WIP \(note, draft\) \[draft\]/);
  assert.match(text.stdout, /broken\.md {2}Broken fallback \(untyped, status unknown\) \[diagnostics:1\]/);

  const pages = cliJson<{ path: string; status: string | null; diagnostics: string[] }[]>(root, ["docs", "tree", "--json"]);
  assert.equal(pages.length, 3);
  assert.equal(pages.find((page) => page.path === "wip.md")?.status, "draft");
  assert.ok(pages.find((page) => page.path === "broken.md")!.diagnostics.length > 0);
});

test("docs search returns snippets, honors filters, and reports misses and bad filters", () => {
  const root = tmp();
  write(root, "docs/sessions.md", fm("Session body about browser login tokens", "title: Authentication\ntype: reference\nstatus: current\n"));
  write(root, "docs/other.md", "# Other\n\nunrelated text");
  initTracker(root);

  const text = cli(root, ["docs", "search", "session"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /sessions\.md/);
  assert.match(text.stdout, /\[session\]/i);

  const filtered = cliJson<unknown[]>(root, ["docs", "search", "session", "--type", "reference", "--json"]);
  assert.equal(filtered.length, 1);
  assert.equal(cli(root, ["docs", "search", "session", "--type", "glossary"]).stdout.trim(), 'no documentation matches "session"');

  const bad = cli(root, ["docs", "search", "session", "--type", "bogus"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /type must be one of/);

  const badLimit = cli(root, ["docs", "search", "session", "--limit", "0"]);
  assert.equal(badLimit.status, 1);
  assert.match(badLimit.stderr, /--limit must be a positive integer/);
});

test("docs read shows diagnostics, bounds sections and rejects unsafe or incomplete calls", () => {
  const root = tmp();
  write(root, "docs/sections.md", "# Intro\n\nintro text\n\n## Details\n\n" + "detail ".repeat(40) + "\n\n## Next\n\nnext text\n");
  write(root, "docs/broken.md", fm("# Broken fallback\n\nbody text", "title: [broken\n"));
  initTracker(root);

  const whole = cli(root, ["docs", "read", "sections", "--whole"]);
  assert.equal(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /# Intro/);
  assert.match(whole.stdout, /next text/);

  const diag = cli(root, ["docs", "read", "broken", "--whole"]);
  assert.equal(diag.status, 0, diag.stderr);
  assert.match(diag.stdout, /frontmatter diagnostics \(1\)/);
  assert.match(diag.stdout, /Field "title"/);

  const section = cli(root, ["docs", "read", "sections", "--heading", "Details", "--max-chars", "20"]);
  assert.equal(section.status, 0, section.stderr);
  assert.match(section.stdout, /- heading: Details/);
  assert.match(section.stdout, /\[Truncated\]/);
  assert.doesNotMatch(section.stdout, /next text/);

  const noFlag = cli(root, ["docs", "read", "sections"]);
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /--heading|--whole/);

  const missing = cli(root, ["docs", "read", "missing", "--whole"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);

  const escape = cli(root, ["docs", "read", "../secret", "--whole"]);
  assert.equal(escape.status, 1);
  assert.match(escape.stderr, /invalid docs path/);

  const page = cliJson<{ diagnostics: string[]; truncated: boolean }>(root, ["docs", "read", "broken", "--whole", "--json"]);
  assert.ok(page.diagnostics.length > 0);
  assert.equal(page.truncated, false);
});

test("docs note writes a unique draft under the docs inbox, is indexed, and supports --json", () => {
  const root = tmp();
  initTracker(root);

  const first = cli(root, ["docs", "note", "Fresh Idea", "-d", "Capture this thought", "--tag", "alpha", "--tag", "beta", "--related", "G-1"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /created inbox\/\d{4}-\d{2}-\d{2}-fresh-idea\.md/);

  const inbox = path.join(root, "docs", "inbox");
  const files = fs.readdirSync(inbox);
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(inbox, files[0]), "utf8");
  assert.match(content, /type: note/);
  assert.match(content, /status: draft/);
  assert.match(content, /title: "Fresh Idea"/);
  assert.match(content, /tags: \["alpha", "beta"\]/);
  assert.match(content, /related: \["G-1"\]/);
  assert.match(content, /Capture this thought/);

  const second = cli(root, ["docs", "note", "Fresh Idea"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readdirSync(inbox).length, 2, "a second note with the same title must not overwrite the first");

  assert.match(cli(root, ["docs", "search", "fresh"]).stdout, /inbox\//);

  const created = cliJson<{ path: string; type: string; status: string }>(root, ["docs", "note", "Another", "--json"]);
  assert.equal(created.type, "note");
  assert.equal(created.status, "draft");
  assert.match(created.path, /^inbox\//);
});

test("docs rebuild drops deleted pages from the index", () => {
  const root = tmp();
  write(root, "docs/keep.md", "# Keep\n\nkeep body");
  write(root, "docs/gone.md", "# Gone\n\ngone body");
  initTracker(root);
  assert.match(cli(root, ["docs", "tree"]).stdout, /gone\.md/);

  fs.rmSync(path.join(root, "docs", "gone.md"));
  const rebuilt = cli(root, ["docs", "rebuild"]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(rebuilt.stdout, /rebuilt docs index: 1 pages/);
  assert.doesNotMatch(cli(root, ["docs", "tree"]).stdout, /gone\.md/);

  assert.match(cli(root, ["docs", "rebuild", "--json"]).stdout, /"pages": 1/);
});

test("docs tree and read flag possibly stale pages from Git changes", () => {
  const root = tmp();
  initGit(root);
  write(root, "src/auth/session.ts", "export const version = 1;\n");
  write(root, "docs/auth.md", fm("# Authentication\n\nSessions.", "title: Authentication\ntype: reference\nstatus: current\npaths: [src/auth/**]\nverified: 2020-01-01\n"));
  commit(root, "initial docs and code");
  initTracker(root);

  write(root, "src/auth/new-file.ts", "export const version = 2;\n");
  const tree = cli(root, ["docs", "tree"]);
  assert.equal(tree.status, 0, tree.stderr);
  assert.match(tree.stdout, /auth\.md {2}Authentication \(reference, current\) \[stale\]/);

  const read = cli(root, ["docs", "read", "auth", "--whole"]);
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /- markers: stale/);
  assert.match(read.stdout, /stale reasons/);
  assert.match(read.stdout, /new-file\.ts/);
});

test("docs resolve the caller's checkout, not the tracker's main worktree", () => {
  const main = tmp();
  initGit(main);
  write(main, "docs/page.md", fm("# Main page\n\nmainonlytoken", "title: Main page\n"));
  commit(main, "main docs");
  initTracker(main);

  const linked = path.join(tmp(), "linked");
  git(main, "worktree", "add", "-q", "-b", "cli-docs-linked", linked);
  write(linked, "docs/page.md", fm("# Worktree page\n\nworktreeonlytoken", "title: Worktree page\n"));

  const env = { GENIE_DIR: path.join(main, ".genie") };
  const found = cli(linked, ["docs", "search", "worktreeonlytoken"], env);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /page\.md/);
  assert.equal(cli(linked, ["docs", "search", "mainonlytoken"], env).stdout.trim(), 'no documentation matches "mainonlytoken"');
});

test("docs works from a nested caller directory and rejects unknown subcommands", () => {
  const root = tmp();
  write(root, "docs/guide.md", "# Guide\n\nnested-root-body");
  initTracker(root);

  const bad = cli(root, ["docs", "bogus"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /tree\|search\|read\|note\|rebuild/);

  const nested = path.join(root, "src", "nested");
  fs.mkdirSync(nested, { recursive: true });
  const fromNested = cli(nested, ["docs", "search", "nested-root-body"]);
  assert.equal(fromNested.status, 0, fromNested.stderr);
  assert.match(fromNested.stdout, /guide\.md/);
});

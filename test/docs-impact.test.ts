import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeDocsImpact, type DocsImpactResult } from "../src/docs/impact.ts";
import { DocsService } from "../src/docs/service.ts";
import { TeamBus } from "../src/team/bus.ts";
import type { Actor } from "../src/tracker/model.ts";
import { Tracker } from "../src/tracker/store.ts";
import { createWebApp, type WebApp } from "../src/web/server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src", "cli", "genie.ts");
const ORCH: Actor = { name: "orchestrator", role: "orchestrator" };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-impact-test-"));
}

/** A main checkout plus a linked worktree path under one temporary parent. */
function tmpPair(): { root: string; wt: string } {
  const base = tmp();
  const root = path.join(base, "main");
  fs.mkdirSync(root);
  return { root, wt: path.join(base, "wt") };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "impact-test@example.com");
  git(root, "config", "user.name", "Impact Test");
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.email=impact-test@example.com", "-c", "user.name=Impact Test", "commit", "-q", "-m", message, "--allow-empty");
}

function write(root: string, relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function service(root: string, tracker: Tracker): DocsService {
  return new DocsService({ db: tracker.db, cwd: root, trackerDir: tracker.dir, docsRoot: "docs" });
}

const fm = (body: string, metadata = "") => `---\n${metadata}---\n${body}`;

/** Main checkout with `base` committed; returns the base sha. */
function baseRepo(root: string): string {
  initGit(root);
  commit(root, "base");
  return git(root, "rev-parse", "HEAD");
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
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { cwd, encoding: "utf8", env: clean });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------- core module

test("changed-path candidates come from the task worktree diff and exclude docs files", () => {
  const { root, wt } = tmpPair();
  initGit(root);
  write(root, "src/team/spawn.ts", "export const spawn = 1;\n");
  write(root, "docs/team.md", fm("# Team\n\nTeam docs.\n", "title: Team guide\ntype: guide\nstatus: current\npaths: [src/team/**]\nverified: 2020-01-01\n"));
  commit(root, "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", wt, "-b", "task", base);
  write(wt, "src/team/spawn.ts", "export const spawn = 2;\n");
  commit(wt, "change spawn");
  // A dirty docs edit in the worktree must not count as affected code.
  write(wt, "docs/team.md", fm("# Team\n\nEdited in the worktree.\n", "title: Team guide\ntype: guide\nstatus: current\npaths: [src/team/**]\nverified: 2020-01-01\n"));

  const tracker = Tracker.init(path.join(root, ".genie"));
  const result = computeDocsImpact(service(root, tracker), { id: "G-1", status: "review", relatedIds: ["G-1"], worktree: { path: wt, base } });

  assert.equal(result.applicable, true);
  assert.equal(result.changedPathsAvailable, true);
  assert.ok(result.changedPaths.includes("src/team/spawn.ts"));
  assert.ok(!result.changedPaths.includes("docs/team.md"), "docs edits are not affected code");
  assert.deepEqual(result.notes, []);
  const candidate = result.candidates.find((c) => c.path === "team.md");
  assert.ok(candidate, "the page with a matching paths glob is a candidate");
  assert.ok(candidate.reasons.some((r) => r.kind === "changed-path" && r.path === "src/team/spawn.ts" && r.pattern === "src/team/**"));
  assert.match(candidate.summary, /changes src\/team\/spawn\.ts/);
});

test("related candidates work without a worktree and deprecated pages survive only via related", () => {
  const root = tmp();
  initGit(root);
  write(root, "docs/decision.md", fm("# Decision\n\nChosen.\n", "title: Session decision\ntype: decision\nstatus: current\nrelated: [G-7]\n"));
  write(root, "docs/old-related.md", fm("# Old related\n\nOld.\n", "title: Old related\ntype: note\nstatus: deprecated\nrelated: [G-7]\n"));
  write(root, "docs/old.md", fm("# Old\n\nOld.\n", "title: Old\ntype: note\nstatus: deprecated\nrelated: [G-99]\n"));
  commit(root, "docs");
  const tracker = Tracker.init(path.join(root, ".genie"));

  const result = computeDocsImpact(service(root, tracker), { id: "G-7", status: "review", relatedIds: ["G-7"] });
  assert.equal(result.changedPathsAvailable, false);
  assert.ok(result.notes.includes("no team worktree for this task"));
  assert.deepEqual(result.changedPaths, []);
  assert.ok(result.candidates.some((c) => c.path === "decision.md" && c.reasons.some((r) => r.kind === "related" && r.id === "G-7")));
  assert.ok(result.candidates.some((c) => c.path === "old-related.md"), "a deprecated page stays a candidate via related");
  assert.ok(!result.candidates.some((c) => c.path === "old.md"), "a deprecated page with no related match is excluded");
});

test("candidates are ordered changed-path before related-only, then by matched paths", () => {
  const { root, wt } = tmpPair();
  initGit(root);
  write(root, "src/a.ts", "a\n");
  write(root, "src/b.ts", "b\n");
  write(root, "docs/z-changed.md", fm("# Z\n\nZ.\n", "title: Z changed\ntype: guide\npaths: [src/a.ts, src/b.ts]\nverified: 2020-01-01\n"));
  write(root, "docs/a-related.md", fm("# A\n\nA.\n", "title: A related\ntype: note\nrelated: [G-3]\n"));
  commit(root, "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", wt, "-b", "task", base);
  write(wt, "src/a.ts", "a2\n");
  write(wt, "src/b.ts", "b2\n");
  commit(wt, "change both");
  const tracker = Tracker.init(path.join(root, ".genie"));

  const first = computeDocsImpact(service(root, tracker), { id: "G-3", status: "review", relatedIds: ["G-3"], worktree: { path: wt, base } });
  assert.deepEqual(first.candidates.map((c) => c.path), ["z-changed.md", "a-related.md"]);
  // Deterministic: a second run yields the same order.
  const second = computeDocsImpact(service(root, tracker), { id: "G-3", status: "review", relatedIds: ["G-3"], worktree: { path: wt, base } });
  assert.deepEqual(second.candidates.map((c) => c.path), first.candidates.map((c) => c.path));
});

test("impact degrades gracefully for missing worktree, non-git, unreachable base and a broken docs root", () => {
  const { root, wt } = tmpPair();
  initGit(root);
  write(root, "src/x.ts", "x\n");
  write(root, "docs/page.md", fm("# P\n\nP.\n", "title: P\ntype: guide\npaths: [src/**]\nverified: 2020-01-01\n"));
  commit(root, "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", wt, "-b", "task", base);
  const tracker = Tracker.init(path.join(root, ".genie"));
  const svc = service(root, tracker);

  const missing = computeDocsImpact(svc, { id: "G-1", status: "review", worktree: { path: path.join(root, "nope"), base } });
  assert.equal(missing.changedPathsAvailable, false);
  assert.ok(missing.notes.some((n) => n.includes("does not exist")));

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "genie-impact-plain-"));
  const notGit = computeDocsImpact(svc, { id: "G-1", status: "review", worktree: { path: plain } });
  assert.equal(notGit.changedPathsAvailable, false);
  assert.ok(notGit.notes.some((n) => n.includes("is not a git working tree")));

  const badBase = computeDocsImpact(svc, { id: "G-1", status: "review", worktree: { path: wt, base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } });
  assert.equal(badBase.changedPathsAvailable, true, "git status is still evidence when the base is unreachable");
  assert.ok(badBase.notes.some((n) => n.includes("is not reachable")));
  assert.deepEqual(badBase.candidates, []);

  const noWorktree = computeDocsImpact(svc, { id: "G-1", status: "review" });
  assert.equal(noWorktree.changedPathsAvailable, false);
  assert.equal(noWorktree.notes.length, 1);

  // Broken docs root: `docs` is a regular file, so the index cannot be read.
  const brokenRoot = tmp();
  fs.writeFileSync(path.join(brokenRoot, "docs"), "not a directory\n");
  const brokenTracker = Tracker.init(path.join(brokenRoot, ".genie"));
  const broken = computeDocsImpact(service(brokenRoot, brokenTracker), { id: "G-1", status: "review" });
  assert.deepEqual(broken.candidates, []);
  assert.ok(broken.notes.some((n) => n.startsWith("docs index unavailable:")));
});

test("a status transition to done succeeds without docs and the CLI impact surfaces exit 0", () => {
  const root = tmp();
  initGit(root);
  commit(root, "base");
  const tracker = Tracker.init(path.join(root, ".genie"));
  const task = tracker.create(ORCH, { title: "No docs task" });
  tracker.setStatus(ORCH, task.id, "review", { force: true });
  const done = tracker.setStatus(ORCH, task.id, "done", { force: true });
  assert.equal(done.status, "done");

  const shown = cli(root, ["show", task.id]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /## Docs impact \(non-blocking\)/);
  assert.match(shown.stdout, /no documentation page looks affected/);

  const impact = cli(root, ["docs", "impact", task.id, "--json"]);
  assert.equal(impact.status, 0, impact.stderr);
  const parsed = JSON.parse(impact.stdout) as DocsImpactResult;
  assert.equal(parsed.applicable, true);
  assert.deepEqual(parsed.candidates, []);
});

// ---------------------------------------------------------------- CLI surface

test("genie docs impact and genie show expose candidates with both reason kinds", () => {
  const { root, wt } = tmpPair();
  initGit(root);
  write(root, "src/team/spawn.ts", "export const spawn = 1;\n");
  write(root, "docs/guide.md", fm("# Guide\n\nGuide.\n", "title: Team guide\ntype: guide\nstatus: current\npaths: [src/team/**]\nverified: 2020-01-01\n"));
  commit(root, "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", wt, "-b", "task", base);
  write(wt, "src/team/spawn.ts", "export const spawn = 2;\n");
  commit(wt, "change spawn");

  const tracker = Tracker.init(path.join(root, ".genie"));
  const bus = new TeamBus(tracker);
  const review = tracker.create(ORCH, { title: "Review task" });
  const progress = tracker.create(ORCH, { title: "In progress task" });
  write(root, "docs/related.md", fm("# Related\n\nRelated.\n", "title: Related page\ntype: note\nrelated: [G-1]\n"));
  commit(root, "related docs");
  // The first created task is G-1: point the related page at it and make the team work.
  bus.create({ id: review.id, task: review.id, cwd: root, worktree: { path: wt, branch: "task", base }, members: [] });
  tracker.assignTeam(ORCH, review.id, review.id, { path: wt, branch: "task" });
  tracker.setStatus(ORCH, review.id, "review", { force: true });
  tracker.setStatus(ORCH, progress.id, "in_progress", { force: true });

  const impact = cli(root, ["docs", "impact", review.id, "--json"]);
  assert.equal(impact.status, 0, impact.stderr);
  const parsed = JSON.parse(impact.stdout) as DocsImpactResult;
  assert.equal(parsed.applicable, true);
  assert.equal(parsed.changedPathsAvailable, true);
  const kinds = new Set(parsed.candidates.flatMap((c) => c.reasons.map((r) => r.kind)));
  assert.deepEqual([...kinds].sort(), ["changed-path", "related"]);

  const text = cli(root, ["docs", "impact", review.id]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /## Docs impact \(non-blocking\)/);
  assert.match(text.stdout, /guide\.md/);

  const shownReview = cli(root, ["show", review.id]);
  assert.equal(shownReview.status, 0);
  assert.match(shownReview.stdout, /## Docs impact \(non-blocking\)/);

  const shownProgress = cli(root, ["show", progress.id]);
  assert.equal(shownProgress.status, 0);
  assert.doesNotMatch(shownProgress.stdout, /## Docs impact/);

  // `show --json` stays the raw task object (no impact payload).
  const raw = cli(root, ["show", review.id, "--json"]);
  assert.equal(raw.status, 0);
  const rawTask = JSON.parse(raw.stdout) as Record<string, unknown>;
  assert.ok(!("candidates" in rawTask));
  assert.ok(!("changedPaths" in rawTask));
});

// ---------------------------------------------------------------- web surface

interface Harness {
  base: string;
  app: WebApp;
  close: () => Promise<void>;
}

async function startWeb(root: string, tracker: Tracker): Promise<Harness> {
  let app: WebApp | undefined;
  const server = http.createServer((req, res) => void app!.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  app = createWebApp(tracker, { port, cwd: root });
  return {
    base: `http://127.0.0.1:${port}`,
    app,
    close: async () => {
      app!.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tracker.db.close();
    },
  };
}

test("GET /api/tasks/:id/docs-impact returns candidates and a degraded result; status POST still works", async () => {
  const { root, wt } = tmpPair();
  initGit(root);
  write(root, "src/team/spawn.ts", "export const spawn = 1;\n");
  write(root, "docs/guide.md", fm("# Guide\n\nGuide.\n", "title: Team guide\ntype: guide\nstatus: current\npaths: [src/team/**]\nverified: 2020-01-01\n"));
  commit(root, "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", wt, "-b", "task", base);
  write(wt, "src/team/spawn.ts", "export const spawn = 2;\n");
  commit(wt, "change spawn");

  const tracker = Tracker.init(path.join(root, ".genie"));
  const bus = new TeamBus(tracker);
  const task = tracker.create(ORCH, { title: "Web impact task" });
  bus.create({ id: task.id, task: task.id, cwd: root, worktree: { path: wt, branch: "task", base }, members: [] });
  tracker.assignTeam(ORCH, task.id, task.id, { path: wt, branch: "task" });
  tracker.setStatus(ORCH, task.id, "review", { force: true });
  const other = tracker.create(ORCH, { title: "No worktree task" });

  const h = await startWeb(root, tracker);
  try {
    const res = await fetch(`${h.base}/api/tasks/${encodeURIComponent(task.id)}/docs-impact`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as DocsImpactResult;
    assert.equal(body.applicable, true);
    assert.ok(body.candidates.some((c) => c.path === "guide.md"));

    const degradedRes = await fetch(`${h.base}/api/tasks/${encodeURIComponent(other.id)}/docs-impact`);
    assert.equal(degradedRes.status, 200);
    const degraded = (await degradedRes.json()) as DocsImpactResult;
    assert.equal(degraded.changedPathsAvailable, false);
    assert.ok(degraded.notes.length > 0);
    assert.deepEqual(degraded.candidates, []);

    const moved = await fetch(`${h.base}/api/tasks/${encodeURIComponent(task.id)}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genie": "1" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(moved.status, 200);
    assert.equal(((await moved.json()) as { status: string }).status, "done");
  } finally {
    await h.close();
  }
});

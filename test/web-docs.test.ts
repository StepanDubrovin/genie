import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Tracker } from "../src/tracker/store.ts";
import { createWebApp, type WebApp } from "../src/web/server.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-web-docs-test-"));
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "web-docs-test@example.com");
  git(root, "config", "user.name", "Web Docs Test");
}

function write(root: string, relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const fm = (body: string, metadata = "") => `---\n${metadata}---\n${body}`;

interface Harness {
  base: string;
  port: number;
  app: WebApp;
  tracker: Tracker;
  close: () => Promise<void>;
}

/** Bind an ephemeral 127.0.0.1 port, then build the app with the real port for the Host allowlist. */
async function start(root: string, tracker: Tracker): Promise<Harness> {
  let app: WebApp | undefined;
  const server = http.createServer((req, res) => void app!.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  app = createWebApp(tracker, { port, cwd: root });
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    app,
    tracker,
    close: async () => {
      app!.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tracker.db.close();
    },
  };
}

interface ApiResponse {
  status: number;
  json: any;
  text: string;
}

async function call(h: Harness, method: string, pathname: string, options: { body?: unknown; genie?: boolean } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.genie) headers["x-genie"] = "1";
  const res = await fetch(h.base + pathname, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

test("docs API serves tree, search and read with links, backlinks, stale reasons and diagnostics", async () => {
  const root = tmp();
  initGit(root);
  write(root, "src/auth/session.ts", "export const version = 1;\n");
  write(root, "docs/source.md", "# Sources\n\n[[auth]] page reference mark.\n");
  write(root, "docs/auth.md", fm("# Authentication\n\nSessions live here.\n", "title: Authentication\ntype: reference\nstatus: current\npaths: [src/auth/**]\nverified: 2020-01-01\n"));
  write(root, "docs/broken.md", fm("# Broken page\n\nbrokenneedle body stays searchable.\n", "title: [not valid\n"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "docs and code");
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  try {
    const tree = await call(h, "GET", "/api/docs/tree");
    assert.equal(tree.status, 200);
    assert.deepEqual((tree.json.pages as { path: string }[]).map((p) => p.path).sort(), ["auth.md", "broken.md", "source.md"]);
    assert.ok(tree.json.diagnostics.some((item: any) => item.path === "broken.md" && item.diagnostics.length > 0));

    const search = await call(h, "GET", "/api/docs/search?q=brokenneedle");
    assert.equal(search.status, 200);
    assert.equal(search.json.results[0].path, "broken.md");
    assert.ok(search.json.results[0].diagnostics.length > 0);
    assert.equal((await call(h, "GET", "/api/docs/search?q=brokenneedle&type=nope")).status, 400);

    const auth = await call(h, "GET", "/api/docs/page?path=auth.md");
    assert.equal(auth.status, 200);
    assert.equal(auth.json.title, "Authentication");
    assert.equal(auth.json.stale, true);
    assert.ok(auth.json.staleReasons.some((reason: string) => reason.includes("src/auth/session.ts")));
    assert.deepEqual(auth.json.backlinks, ["source.md"]);
    assert.match(auth.json.content, /Sessions live here/);

    const source = await call(h, "GET", "/api/docs/page?path=source.md");
    const link = source.json.links.find((item: any) => item.target === "auth");
    assert.equal(link.resolution, "resolved");
    assert.equal(link.targetPath, "auth.md");
    // An empty heading parameter means "no heading", not a heading named "".
    const emptyHeading = await call(h, "GET", "/api/docs/page?path=source.md&heading=");
    assert.equal(emptyHeading.status, 200);
    assert.match(emptyHeading.json.content, /Sources/);

    const broken = await call(h, "GET", "/api/docs/page?path=broken.md");
    assert.equal(broken.status, 200);
    assert.ok(broken.json.diagnostics.length > 0);

    assert.equal((await call(h, "GET", "/api/docs/page?path=missing.md")).status, 404);
    assert.equal((await call(h, "GET", "/api/docs/page")).status, 400);
  } finally {
    await h.close();
  }
});

test("docs writes require X-Genie, reject traversal and symlink escapes, and save atomically after metadata validation", async () => {
  const root = tmp();
  initGit(root);
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  try {
    // Writes need the custom header.
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "guide.md", content: "# Guide\n\ninitial body\n" } })).status, 403);

    const ok = await call(h, "POST", "/api/docs/page", { body: { path: "guide.md", content: "# Guide\n\ninitial body\n" }, genie: true });
    assert.equal(ok.status, 201);
    assert.equal(fs.readFileSync(path.join(root, "docs/guide.md"), "utf8"), "# Guide\n\ninitial body\n");
    assert.deepEqual(fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".tmp")), []);
    assert.equal((await call(h, "GET", "/api/docs/search?q=initial")).json.results[0].path, "guide.md");

    // A save refreshes the index: the edited body replaces the old one.
    const edited = await call(h, "POST", "/api/docs/page", { body: { path: "guide.md", content: "# Guide\n\neditedneedle body\n" }, genie: true });
    assert.equal(edited.status, 200);
    assert.match(edited.json.page.content, /editedneedle/);
    assert.ok(Array.isArray(edited.json.page.backlinks));
    assert.equal((await call(h, "GET", "/api/docs/search?q=editedneedle")).json.results[0].path, "guide.md");
    assert.equal((await call(h, "GET", "/api/docs/search?q=initial")).json.results.length, 0);

    // Empty content is refused rather than creating a blank page.
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "empty.md", content: "   \n" }, genie: true })).status, 400);
    assert.equal(fs.existsSync(path.join(root, "docs/empty.md")), false);

    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "guide.md", content: "# Other\n", mode: "create" }, genie: true })).status, 409);

    // Invalid metadata is rejected and leaves the existing file untouched.
    const invalid = await call(h, "POST", "/api/docs/page", { body: { path: "guide.md", content: fm("# Bad\n\n", "title: [broken\n"), mode: "update" }, genie: true });
    assert.equal(invalid.status, 422);
    assert.ok(Array.isArray(invalid.json.diagnostics) && invalid.json.diagnostics.length > 0);
    assert.equal(fs.readFileSync(path.join(root, "docs/guide.md"), "utf8"), "# Guide\n\neditedneedle body\n");

    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "absent.md", content: "# Absent\n", mode: "update" }, genie: true })).status, 404);

    // Traversal and absolute paths.
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "../escape.md", content: "# Escape\n" }, genie: true })).status, 400);
    assert.equal(fs.existsSync(path.join(root, "escape.md")), false);
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "/etc/genie-escape.md", content: "# Escape\n" }, genie: true })).status, 400);

    // Symlink escapes: a file link and a directory link inside docs.
    const outside = tmp();
    write(outside, "secret.md", "# Outside secret\n");
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "docs", "linked.md"));
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "linked.md", content: "# Hijacked\n" }, genie: true })).status, 400);
    assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "# Outside secret\n");

    fs.mkdirSync(path.join(outside, "dir"), { recursive: true });
    fs.symlinkSync(path.join(outside, "dir"), path.join(root, "docs", "linked-dir"));
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "linked-dir/evil.md", content: "# Evil\n" }, genie: true })).status, 400);
    assert.equal(fs.existsSync(path.join(outside, "dir", "evil.md")), false);

    // An in-docs symlink alias must not silently overwrite the file it points at.
    write(root, "docs/real.md", "# Real\n\noriginal\n");
    fs.symlinkSync(path.join(root, "docs", "real.md"), path.join(root, "docs", "alias.md"));
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "alias.md", content: "# Hijacked\n" }, genie: true })).status, 400);
    assert.equal(fs.readFileSync(path.join(root, "docs", "real.md"), "utf8"), "# Real\n\noriginal\n");

    // Raw filesystem errors on the write path are client errors, not 500s.
    fs.mkdirSync(path.join(root, "docs", "dir.md"), { recursive: true });
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "dir.md", content: "# Directory\n" }, genie: true })).status, 400);
    assert.equal((await call(h, "POST", "/api/docs/page", { body: { path: "bad\u0000.md", content: "# Nul\n" }, genie: true })).status, 400);
  } finally {
    await h.close();
  }
});

test("the docs version endpoint signals external edits and API saves, and refreshes the index", async () => {
  const root = tmp();
  initGit(root);
  write(root, "docs/first.md", "# First\n\nalpha content\n");
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  try {
    const v1 = (await call(h, "GET", "/api/docs/version")).json.version;
    assert.equal(typeof v1, "string");

    write(root, "docs/second.md", "# Second\n\nbetaphrase content\n");
    const v2 = (await call(h, "GET", "/api/docs/version")).json.version;
    assert.notEqual(v2, v1);
    // The version poll refreshed the index, so the new page is already searchable.
    assert.equal((await call(h, "GET", "/api/docs/search?q=betaphrase")).json.results[0].path, "second.md");

    const saved = await call(h, "POST", "/api/docs/page", { body: { path: "third.md", content: "# Third\n\ngammaphrase\n" }, genie: true });
    assert.equal(saved.status, 201);
    const v3 = (await call(h, "GET", "/api/docs/version")).json.version;
    assert.notEqual(v3, v2);
    // No further changes: the signal is stable between polls.
    assert.equal((await call(h, "GET", "/api/docs/version")).json.version, v3);
    assert.equal((await call(h, "GET", "/api/docs/search?q=gammaphrase")).json.results[0].path, "third.md");
  } finally {
    await h.close();
  }
});

test("docs saves broadcast a change event to SSE clients", async () => {
  const root = tmp();
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  let timer: NodeJS.Timeout;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("no SSE change event received")), 5000);
      timer.unref();
      const req = http.request({ host: "127.0.0.1", port: h.port, path: "/api/events" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (chunk.includes("event: change")) {
            res.destroy();
            clearTimeout(timer);
            resolve();
          }
        });
      });
      req.on("error", reject);
      req.end();
      void (async () => {
        await new Promise((r) => setTimeout(r, 100));
        await call(h, "POST", "/api/docs/page", { body: { path: "notify.md", content: "# Notify\n\nbody\n" }, genie: true });
      })();
    });
  } finally {
    clearTimeout(timer!);
    await h.close();
  }
});

test("the web app serves the main checkout's docs even when started from a linked worktree", async () => {
  const main = tmp();
  initGit(main);
  write(main, "docs/page.md", "# Main page\n\nmaincheckoutquartz\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "main docs");
  const tracker = Tracker.init(path.join(main, ".genie"));
  const worktree = path.join(tmp(), "linked");
  git(main, "worktree", "add", "-q", "-b", "docs-web-worktree", worktree);
  write(worktree, "docs/page.md", "# Worktree page\n\nbranchcheckoutcobalt\n");
  const h = await start(worktree, tracker);
  try {
    const tree = await call(h, "GET", "/api/docs/tree");
    assert.equal(tree.status, 200);
    assert.equal(tree.json.pages.find((page: any) => page.path === "page.md").title, "Main page");
    assert.equal((await call(h, "GET", "/api/docs/search?q=branchcheckoutcobalt")).json.results.length, 0);
    assert.equal((await call(h, "GET", "/api/docs/search?q=maincheckoutquartz")).json.results[0].path, "page.md");
  } finally {
    await h.close();
  }
});

test("the Host allowlist still rejects unexpected hosts for docs routes", async () => {
  const root = tmp();
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h.port, path: "/api/docs/tree", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421);
  } finally {
    await h.close();
  }
});

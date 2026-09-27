import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Tracker } from "../src/tracker/store.ts";
import {
  detectImageMime,
  isRasterFileName,
  MAX_INLINE_IMAGE_BYTES,
  normalizeRepoImagePath,
  parseImageRef,
  parseImageRefs,
  shouldInlineImage,
} from "../src/web/images.ts";
import { createWebApp, type WebApp } from "../src/web/server.ts";
import { artifactReadContent } from "../src/web/artifacts.ts";

// ------------------------------------------------------------------ fixtures

/** A real 1x1 PNG (magic + valid IHDR/IDAT so browsers render it too). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from("WEBP", "ascii"), Buffer.alloc(8)]);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-web-images-test-"));
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initGit(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "web-images-test@example.com");
  git(root, "config", "user.name", "Web Images Test");
}

function write(root: string, relative: string, data: string | Buffer): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

interface Harness {
  base: string;
  app: WebApp;
  tracker: Tracker;
  close: () => Promise<void>;
}

async function start(root: string, tracker: Tracker): Promise<Harness> {
  let app: WebApp | undefined;
  const server = http.createServer((req, res) => void app!.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  app = createWebApp(tracker, { port, cwd: root });
  return {
    base: `http://127.0.0.1:${port}`,
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

interface Res {
  status: number;
  headers: Headers;
  bytes: Buffer;
  json: any;
}

async function get(h: Harness, pathname: string): Promise<Res> {
  const res = await fetch(h.base + pathname);
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, bytes, json };
}

async function post(h: Harness, pathname: string, body: unknown): Promise<Res> {
  const res = await fetch(h.base + pathname, { method: "POST", headers: { "content-type": "application/json", "x-genie": "1" }, body: JSON.stringify(body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, bytes, json };
}

// ------------------------------------------------------------------ pure units

test("detectImageMime reads magic bytes, not the file name", () => {
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(detectImageMime(JPEG), "image/jpeg");
  assert.equal(detectImageMime(GIF), "image/gif");
  assert.equal(detectImageMime(WEBP), "image/webp");
  // A .txt name is irrelevant: only the bytes count.
  assert.equal(detectImageMime(PNG), "image/png");
  // Negatives: plain text, SVG, BMP and a truncated header.
  assert.equal(detectImageMime(Buffer.from("just a text artifact\n")), undefined);
  assert.equal(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), undefined);
  assert.equal(detectImageMime(Buffer.from([0x42, 0x4d, 0x00, 0x00])), undefined);
  assert.equal(detectImageMime(PNG.subarray(0, 4)), undefined);
  assert.equal(detectImageMime(new Uint8Array()), undefined);
  // A RIFF container that is not WebP (e.g. WAV) is rejected.
  assert.equal(detectImageMime(Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii")])), undefined);
});

test("isRasterFileName and shouldInlineImage follow the raster scope and cap", () => {
  assert.equal(isRasterFileName("shot.PNG"), true);
  assert.equal(isRasterFileName("shot.webp"), true);
  assert.equal(isRasterFileName("shot.txt"), false);
  assert.equal(isRasterFileName("shot.svg"), false);
  assert.equal(isRasterFileName("noextension"), false);
  assert.equal(shouldInlineImage("image/png", 10), true);
  assert.equal(shouldInlineImage("image/png", MAX_INLINE_IMAGE_BYTES), true);
  assert.equal(shouldInlineImage("image/png", MAX_INLINE_IMAGE_BYTES + 1), false);
  assert.equal(shouldInlineImage(undefined, 10), false);
});

test("normalizeRepoImagePath accepts plain relative paths and rejects escapes", () => {
  assert.equal(normalizeRepoImagePath("docs/shot.png"), "docs/shot.png");
  assert.equal(normalizeRepoImagePath("  docs/a b.png "), "docs/a b.png");
  assert.equal(normalizeRepoImagePath("../escape.png"), undefined);
  assert.equal(normalizeRepoImagePath("a/../../b.png"), undefined);
  assert.equal(normalizeRepoImagePath("/etc/passwd.png"), undefined);
  assert.equal(normalizeRepoImagePath("C:/windows.png"), undefined);
  assert.equal(normalizeRepoImagePath("a\\b.png"), undefined);
  assert.equal(normalizeRepoImagePath("a\0b.png"), undefined);
  assert.equal(normalizeRepoImagePath("a//b.png"), undefined);
  assert.equal(normalizeRepoImagePath("./b.png"), undefined);
  assert.equal(normalizeRepoImagePath(""), undefined);
});

test("parseImageRefs finds local references and leaves everything else as text", () => {
  const artifact = parseImageRef("artifact:G-18/3");
  assert.deepEqual(artifact, { kind: "artifact", task: "G-18", n: 3, raw: "artifact:G-18/3" });
  assert.deepEqual(parseImageRef("docs/shot.png"), { kind: "path", path: "docs/shot.png", raw: "docs/shot.png" });
  assert.equal(parseImageRef("artifact:G-18"), undefined);
  assert.equal(parseImageRef("artifact:G-18/x"), undefined);
  // No external URLs, ever.
  assert.equal(parseImageRef("https://example.com/a.png"), undefined);
  assert.equal(parseImageRef(""), undefined);

  const segments = parseImageRefs("look !image[shot.png] and !image[artifact:G-18/2] done");
  assert.deepEqual(
    segments.map((s) => (s.type === "text" ? s.text : s.ref.kind)),
    ["look ", "path", " and ", "artifact", " done"],
  );

  // Malformed, empty, missing bracket and out-of-root references all stay text.
  for (const text of ["!image[]", "!image[", "!image[shot.png", "!image[../etc/passwd]", "!image[/etc/x.png]", "!img[shot.png]", "no references here"]) {
    const parts = parseImageRefs(text);
    assert.deepEqual(parts, [{ type: "text", text }]);
  }

  // A newline cannot terminate a reference.
  assert.deepEqual(parseImageRefs("!image[a\nb.png]"), [{ type: "text", text: "!image[a\nb.png]" }]);
});

// ------------------------------------------------------------------ agent block

test("artifactReadContent attaches a raster image block within the cap and notes the fallbacks", () => {
  const image = artifactReadContent({ n: 3, name: "shot.txt", kind: "log", content: PNG, text: undefined });
  assert.equal(image.length, 2);
  assert.equal(image[0].type, "text");
  assert.match((image[0] as { text: string }).text, /^# artifact #3 shot\.txt \(log\)\n\nImage attached \(image\/png/);
  assert.deepEqual(image[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });

  // Above the inline cap: keep the text behaviour, add an explicit note, no image block.
  const tooBig = artifactReadContent({ n: 4, name: "big.png", kind: "log", content: Buffer.concat([PNG, Buffer.alloc(MAX_INLINE_IMAGE_BYTES)]), text: undefined });
  assert.equal(tooBig.length, 1);
  assert.equal(tooBig[0].type, "text");
  assert.match((tooBig[0] as { text: string }).text, /is binary \(\d+ bytes\); larger than the \d+ byte inline cap/);

  // Unsupported binary type: same explicit note, never an image block.
  const binary = artifactReadContent({ n: 5, name: "blob.bin", kind: "log", content: Buffer.from([0x00, 0x01, 0xff, 0xfe]), text: undefined });
  assert.equal(binary.length, 1);
  assert.match((binary[0] as { text: string }).text, /only PNG, JPEG, GIF and WebP/);

  // Text artifacts are unchanged apart from the shared header.
  const plain = artifactReadContent({ n: 6, name: "notes.md", kind: "analysis", content: Buffer.from("body"), text: "body" });
  assert.deepEqual(plain, [{ type: "text", text: "# artifact #6 notes.md (analysis)\n\nbody" }]);
});

// ------------------------------------------------------------------ HTTP routes

test("GET /api/images serves a contained raster with correct headers and rejects escapes", async () => {
  const root = tmp();
  initGit(root);
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  try {
    write(root, "docs/shot.png", PNG);
    write(root, "docs/vector.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    write(root, "docs/big.png", Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));

    const ok = await get(h, "/api/images?path=docs%2Fshot.png");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("content-disposition"), "inline");
    assert.deepEqual(ok.bytes, PNG);

    // Content-based type: a .txt file holding PNG bytes is served as image/png.
    write(root, "docs/mislabeled.txt", PNG);
    const mislabeled = await get(h, "/api/images?path=docs%2Fmislabeled.txt");
    assert.equal(mislabeled.status, 200);
    assert.equal(mislabeled.headers.get("content-type"), "image/png");

    // Traversal, absolute, backslash, NUL and empty.
    assert.equal((await get(h, "/api/images?path=..%2Fescape.png")).status, 400);
    assert.equal((await get(h, "/api/images?path=%2Fetc%2Fpasswd")).status, 400);
    assert.equal((await get(h, "/api/images?path=a%5Cb.png")).status, 400);
    assert.equal((await get(h, "/api/images?path=a%00b.png")).status, 400);
    assert.equal((await get(h, "/api/images")).status, 400);
    assert.equal((await get(h, "/api/images?path=https%3A%2F%2Fexample.com%2Fx.png")).status, 400);

    // Missing file, unsupported type, oversized file.
    assert.equal((await get(h, "/api/images?path=docs%2Fmissing.png")).status, 404);
    assert.equal((await get(h, "/api/images?path=docs%2Fvector.svg")).status, 415);
    assert.equal((await get(h, "/api/images?path=docs%2Fbig.png")).status, 413);

    // Symlinks: a link to an outside file and a link inside the root are both refused.
    const outside = tmp();
    write(outside, "secret.png", PNG);
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(root, "docs", "linked.png"));
    assert.equal((await get(h, "/api/images?path=docs%2Flinked.png")).status, 400);

    write(root, "docs/real.png", PNG);
    fs.symlinkSync(path.join(root, "docs", "real.png"), path.join(root, "docs", "alias.png"));
    assert.equal((await get(h, "/api/images?path=docs%2Falias.png")).status, 400);

    // A directory is not a servable image.
    fs.mkdirSync(path.join(root, "docs", "dir.png"), { recursive: true });
    assert.equal((await get(h, "/api/images?path=docs%2Fdir.png")).status, 404);
  } finally {
    await h.close();
  }
});

test("artifact raw path serves inline bytes while JSON and download stay unchanged", async () => {
  const root = tmp();
  initGit(root);
  const tracker = Tracker.init(path.join(root, ".genie"));
  const h = await start(root, tracker);
  try {
    const created = await post(h, "/api/tasks", { title: "image artifact" });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const shot = write(root, "shot.txt", PNG);
    tracker.addArtifact({ name: "owner", role: "human" }, id, { kind: "log", file: shot, name: "shot.txt" });
    tracker.addArtifact({ name: "owner", role: "human" }, id, { kind: "other", content: "plain text body" });

    // Default JSON metadata is unchanged, plus a content-derived mime for images.
    const meta = await get(h, `/api/tasks/${id}/artifacts/1`);
    assert.equal(meta.status, 200);
    assert.equal(meta.json.name, "shot.txt");
    assert.equal(meta.json.mime, "image/png");
    assert.equal(meta.json.text, undefined);

    const textMeta = await get(h, `/api/tasks/${id}/artifacts/2`);
    assert.equal(textMeta.status, 200);
    assert.equal(textMeta.json.mime, undefined);
    assert.equal(textMeta.json.text, "plain text body");

    // Raw bytes are inline and typed from the content, despite the .txt name.
    const raw = await get(h, `/api/tasks/${id}/artifacts/1?raw=1`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    assert.equal(raw.headers.get("content-disposition"), 'inline; filename="shot.txt"');
    assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(raw.bytes, PNG);

    // Download is untouched: attachment, octet-stream.
    const dl = await get(h, `/api/tasks/${id}/artifacts/1?download=1`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-disposition"), 'attachment; filename="shot.txt"');
    assert.equal(dl.headers.get("content-type"), "application/octet-stream");

    // A non-image artifact has no raw path.
    assert.equal((await get(h, `/api/tasks/${id}/artifacts/2?raw=1`)).status, 415);
    assert.equal((await get(h, `/api/tasks/${id}/artifacts/9?raw=1`)).status, 422);
  } finally {
    await h.close();
  }
});

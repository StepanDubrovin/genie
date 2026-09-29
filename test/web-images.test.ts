// Image references in team chat (web/src/shared/lib/images.ts). The server side
// — which files are served and how — is tested in crates/genie/tests/api.rs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { imageRefSrc, isRasterFileName, normalizeRepoImagePath, parseImageRef, parseImageRefs } from "../web/src/shared/lib/images.ts";

test("a raster file name is a cheap hint, not the type", () => {
  assert.equal(isRasterFileName("shot.PNG"), true);
  assert.equal(isRasterFileName("shot.webp"), true);
  assert.equal(isRasterFileName("shot.txt"), false);
  assert.equal(isRasterFileName("shot.svg"), false);
  assert.equal(isRasterFileName("noextension"), false);
});

test("only plain relative paths are image paths", () => {
  assert.equal(normalizeRepoImagePath("docs/shot.png"), "docs/shot.png");
  assert.equal(normalizeRepoImagePath("  docs/a b.png "), "docs/a b.png");
  for (const bad of ["../escape.png", "a/../../b.png", "/etc/passwd.png", "C:/windows.png", "a\\b.png", "a\0b.png", "a//b.png", "./b.png", ""]) {
    assert.equal(normalizeRepoImagePath(bad), undefined, JSON.stringify(bad));
  }
});

test("local references become images and everything else stays text", () => {
  assert.deepEqual(parseImageRef("artifact:G-18/3"), { kind: "artifact", task: "G-18", n: 3, raw: "artifact:G-18/3" });
  assert.deepEqual(parseImageRef("docs/shot.png"), { kind: "path", path: "docs/shot.png", raw: "docs/shot.png" });
  assert.equal(parseImageRef("artifact:G-18"), undefined);
  assert.equal(parseImageRef("artifact:G-18/x"), undefined);
  assert.equal(parseImageRef("https://example.com/a.png"), undefined, "no external URLs, ever");
  assert.equal(parseImageRef(""), undefined);

  const segments = parseImageRefs("look !image[shot.png] and !image[artifact:G-18/2] done");
  assert.deepEqual(
    segments.map((s) => (s.type === "text" ? s.text : s.ref.kind)),
    ["look ", "path", " and ", "artifact", " done"],
  );
  for (const text of ["!image[]", "!image[", "!image[shot.png", "!image[../etc/passwd]", "!image[/etc/x.png]", "!img[shot.png]", "no references here"]) {
    assert.deepEqual(parseImageRefs(text), [{ type: "text", text }], text);
  }
  assert.deepEqual(parseImageRefs("!image[a\nb.png]"), [{ type: "text", text: "!image[a\nb.png]" }], "a newline cannot end a reference");
});

test("an image path in a team's chat is read from that team's worktree", () => {
  const shot = parseImageRef("docs/shot.png");
  assert.ok(shot);
  assert.equal(imageRefSrc(shot), "/api/images?path=docs%2Fshot.png");
  assert.equal(imageRefSrc(shot, "shop-G-7"), "/api/images?path=docs%2Fshot.png&team=shop-G-7");
  const artifact = parseImageRef("artifact:G-7/3");
  assert.ok(artifact);
  assert.equal(imageRefSrc(artifact, "shop-G-7"), "/api/tasks/G-7/artifacts/3?raw=1", "artifacts belong to the task, not the worktree");
});

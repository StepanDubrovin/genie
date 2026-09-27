import assert from "node:assert/strict";
import { test } from "node:test";
import { callText, preview, resultText, snippet, statusTone } from "../src/extension/render.ts";

test("genie_task call rows show the action and its target", () => {
  assert.equal(callText("genie_task", { action: "status", id: "G-2", status: "review" }), "genie_task status G-2 → review");
  assert.equal(callText("genie_task", { action: "show", id: "G-2" }), "genie_task show G-2");
  assert.equal(callText("genie_task", { action: "ready" }), "genie_task ready");
  assert.equal(callText("genie_task", { action: "list", statuses: ["in_progress", "review"], includeClosed: true }), "genie_task list [in_progress, review; +closed]");
  assert.equal(callText("genie_task", { action: "check", id: "G-2", criterion: 5 }), "genie_task check G-2 #5");
  assert.equal(callText("genie_task", { action: "artifact", id: "G-2", kind: "test-report", name: "report.md" }), "genie_task artifact G-2 test-report · report.md");
  assert.equal(callText("genie_task", { action: "split", id: "G-2", children: [{ title: "a" }, { title: "b" }] }), "genie_task split G-2 ×2 children");
  assert.equal(callText("genie_task", { action: "update", id: "G-2", plan: "do it", acceptance: ["a", "b"] }), "genie_task update G-2 plan, +criteria×2");
  assert.equal(callText("genie_task", { action: "comment", id: "G-2", kind: "note", text: "looking into it" }), 'genie_task comment G-2 [note] · "looking into it"');
});

test("genie_task call rows degrade gracefully while arguments stream", () => {
  assert.equal(callText("genie_task", {}), "genie_task …");
  assert.equal(callText("genie_task", undefined), "genie_task …");
});

test("team call rows summarize their roster and flags", () => {
  assert.equal(
    callText("team_spawn", { task: "G-2", members: [{ role: "analyst" }, { role: "executor" }], worktree: true }),
    "team_spawn G-2 2 members: analyst, executor · worktree",
  );
  assert.equal(callText("team_spawn", { task: "G-2", template: "pair", mode: "headless" }), "team_spawn G-2 template pair · headless");
  assert.equal(callText("team_add_member", { team: "G-2", members: [{ role: "tester" }] }), "team_add_member G-2 +1: tester");
  assert.equal(callText("team_send", { to: "reviewer", text: "check   the tests", urgent: true }), 'team_send → reviewer ! "check the tests"');
  assert.equal(callText("team_status", { team: "G-2" }), "team_status G-2");
  assert.equal(callText("team_status", {}), "team_status");
  assert.equal(callText("team_set_status", { status: "implementing parser" }), 'team_set_status "implementing parser"');
  assert.equal(callText("team_stop", { team: "G-2", removeWorktree: true }), "team_stop G-2 remove worktree");
});

test("unknown tools fall back to their label", () => {
  assert.equal(callText("something_else", { action: "x" }), "something_else");
});

test("preview keeps collapsed output short and expands to the full text", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  assert.deepEqual(preview(lines, false).shown.length, 8);
  assert.equal(preview(lines, false).hidden, 4);
  assert.equal(preview(lines, true).hidden, 0);
  assert.deepEqual(preview(["only"], false), { shown: ["only"], hidden: 0 });
});

test("statusTone maps statuses to semantic tones", () => {
  assert.equal(statusTone("done"), "success");
  assert.equal(statusTone("approved"), "success");
  assert.equal(statusTone("needs_owner"), "warning");
  assert.equal(statusTone("cancelled"), "error");
  assert.equal(statusTone("in_progress"), "accent");
  assert.equal(statusTone("draft"), "muted");
});

test("snippet collapses whitespace and clips long text", () => {
  assert.equal(snippet("  a\n b\tc  "), "a b c");
  assert.equal(snippet("abcdef", 4), "abc…");
  assert.equal(snippet("abc", 4), "abc");
});

test("resultText joins text blocks and ignores non-text content", () => {
  assert.equal(
    resultText({
      content: [
        { type: "text", text: "first" },
        { type: "image" },
        { type: "text", text: "second" },
      ],
    }),
    "first\nsecond",
  );
});

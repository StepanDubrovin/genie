// The web's agent-configuration helpers (web/src/entities/agent-config/model.ts):
// permissions from checkboxes, role-file edits that keep everything else, the
// template graph and which templates a task can use.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowDeny,
  basePermissions,
  layoutTeam,
  liveTeam,
  newRoleFile,
  reached,
  type RoleDef,
  setFrontmatterKey,
  splitFrontmatter,
  type TeamDef,
  type TeamSpecView,
  templatesFor,
} from "../web/src/entities/agent-config/model.ts";

const ORDER = ["status.refine", "status.start", "status.submit", "status.approve", "task.check", "docs.read"];

test("checkboxes become allow and deny relative to the class, or to the parent role", () => {
  assert.deepEqual(allowDeny(["status.approve", "docs.read"], ["docs.read", "task.check", "status.approve"], ORDER), { allow: ["task.check"], deny: [] });
  assert.deepEqual(allowDeny(["status.approve", "docs.read"], ["docs.read"], ORDER), { allow: [], deny: ["status.approve"] });
  const role = (id: string, extra: Partial<RoleDef>): RoleDef =>
    ({ id, title: id, description: "", class: "reviewer", names: [], allow: [], deny: [], capabilities: [], files: "read", denyCommands: [], mcp: [], stages: [], origin: "custom", ...extra }) as RoleDef;
  const classes = { reviewer: ["status.approve", "docs.read"] };
  const parent = role("reviewer", { capabilities: ["status.approve", "docs.read", "task.check"] });
  assert.deepEqual(basePermissions(role("sec", { extends: "reviewer" }), [parent], classes), parent.capabilities);
  assert.deepEqual(basePermissions(role("sec", {}), [parent], classes), classes.reviewer);
});

const FILE = `---
title: Ревьюер безопасности
allow: [task.check]
deny:
  - status.approve
instructions: |
  Check secrets.

  Then OWASP.
mcp: [semgrep]
---
You review security.
`;

test("a role file field is replaced, added or removed; the rest stays", () => {
  let t = setFrontmatterKey(FILE, "deny", ["status.return"]);
  assert.match(t, /^deny: \[status\.return\]$/m);
  assert.doesNotMatch(t, /- status\.approve/);
  t = setFrontmatterKey(t, "instructions", undefined);
  assert.doesNotMatch(t, /OWASP|instructions/);
  assert.match(t, /^mcp: \[semgrep\]$/m, "the field after the removed block survives");
  t = setFrontmatterKey(t, "mcp", ["semgrep", "github:get_*"]);
  assert.match(t, /^mcp: \[semgrep, "github:get_\*"\]$/m, "items with `:` are quoted");
  t = setFrontmatterKey(t, "denyCommands", ["git push*"]);
  assert.match(t, /^denyCommands: \["git push\*"\]$/m);
  t = setFrontmatterKey(t, "description", "Checks: secrets, OWASP");
  assert.match(t, /^description: Checks: secrets, OWASP$/m);
  t = setFrontmatterKey(t, "model", "[x]");
  assert.match(t, /^model: "\[x\]"$/m, "a scalar that would read as a list is quoted");
  t = setFrontmatterKey(t, "instructions", "Line one\nLine two");
  assert.match(t, /^instructions: \|\n {2}Line one\n {2}Line two$/m);
  const fm = splitFrontmatter(t);
  assert.ok(fm);
  assert.equal(fm.body, "You review security.\n", "the prompt is untouched");
  assert.equal(fm.lines.filter((l) => l.startsWith("title:")).length, 1);
});

test("a file without frontmatter gets one; an override may be frontmatter only", () => {
  assert.equal(setFrontmatterKey("Prompt only.\n", "model", "openai/gpt-6"), "---\nmodel: openai/gpt-6\n---\nPrompt only.\n");
  assert.equal(setFrontmatterKey("---\n---\n", "allow", []), "---\nallow: []\n---\n");
  assert.equal(setFrontmatterKey("---\nallow: []\n---\n", "allow", undefined), "---\n---\n");
  const created = newRoleFile({ title: "QA", description: "Tests things.", base: "tester", prompt: "You test.\n" });
  assert.equal(created, "---\ntitle: QA\ndescription: Tests things.\nbase: tester\n---\nYou test.\n");
});

test("the template graph puts the orchestrator on top and flags members named by problems", () => {
  const g = layoutTeam(
    [
      { key: "executor", label: "Исполнитель", sub: "executor" },
      { key: "reviewer", label: "Ревьюер", sub: "reviewer" },
    ],
    [
      { from: "executor", to: ["reviewer"], type: "handoff", on: "review" },
      { from: "reviewer", to: ["executor"], type: "returns", on: "changes_requested" },
      { from: "reviewer", to: ["orchestrator"], type: "reports" },
      { from: "ghost", to: ["executor"], type: "consults" },
    ],
    ["`reviewer` waits for a handoff that never comes"],
  );
  assert.deepEqual(
    g.nodes.map((n) => [n.key, !!n.flagged]),
    [
      ["orchestrator", false],
      ["executor", false],
      ["reviewer", true],
    ],
  );
  const [orch, exec, rev] = g.nodes;
  assert.ok(orch.y < exec.y && exec.y === rev.y && exec.x < rev.x);
  assert.equal(g.edges.length, 3, "a relation from an unknown member is not drawn");
  const handoff = g.edges.find((e) => e.type === "handoff")!;
  const back = g.edges.find((e) => e.type === "returns")!;
  assert.ok(handoff.ly < exec.y && back.ly > exec.y, "forward above the row, returns below");
  assert.ok(g.height > back.ly);
});

test("a task before ready gets refinement templates, a ready one delivery templates", () => {
  const t = (id: string, stage: "refinement" | "delivery") => ({ id, stage }) as TeamDef;
  const teams = [t("research", "refinement"), t("standard", "delivery"), t("pair", "delivery")];
  assert.deepEqual(templatesFor(teams, "refining").map((x) => x.id), ["research"]);
  assert.deepEqual(templatesFor(teams, "ready").map((x) => x.id), ["standard", "pair"]);
  assert.deepEqual(templatesFor(teams, "changes_requested").map((x) => x.id), ["standard", "pair"]);
});

test("a running team shows who works and who waits for whose handoff", () => {
  const spec: TeamSpecView = {
    stage: "delivery",
    workspace: "worktree",
    mail: "open",
    members: [
      { key: "executor", name: "bender", role: "executor" },
      { key: "reviewer", name: "yoda", role: "reviewer" },
      { key: "tester", name: "chaos", role: "tester" },
    ],
    relations: [
      { from: "executor", to: ["reviewer", "tester"], type: "handoff", on: "review" },
      { from: "reviewer", to: ["executor"], type: "returns", on: "changes_requested" },
    ],
  };
  const members = [
    { name: "bender", activity: "working", state: "active" },
    { name: "yoda", activity: "idle", state: "active" },
    { name: "chaos", activity: "error", state: "active" },
  ];
  const now = liveTeam(spec, members, "in_progress", true);
  assert.equal(now.live.executor.state, "working");
  assert.deepEqual(now.live.reviewer, { state: "waiting", note: "ждёт Bender" });
  assert.equal(now.live.tester.state, "error", "an error shows whatever the flow");
  assert.deepEqual(now.pending, ["executor->reviewer"]);
  const inReview = liveTeam(spec, members, "review", true);
  assert.equal(inReview.live.reviewer.state, "idle", "the handoff has happened");
  assert.deepEqual(inReview.pending, []);
  assert.equal(liveTeam(spec, members, "review", false).live.executor.state, "stopped");
  assert.ok(reached("approved", "review") && !reached("changes_requested", "review") && reached("changes_requested", "in_progress"));
});

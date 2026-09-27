import type { Task, TaskSummary } from "./model.ts";

const STATUS_ICON: Record<string, string> = {
  inbox: "✉",
  draft: "·",
  refining: "?",
  ready: "○",
  in_progress: "◐",
  review: "◑",
  changes_requested: "↺",
  approved: "◕",
  needs_owner: "!",
  done: "●",
  cancelled: "✕",
};

export function statusIcon(status: string): string {
  return STATUS_ICON[status] ?? " ";
}

export function oneLine(t: TaskSummary): string {
  const flags: string[] = [];
  if (t.needsOwner) flags.push(`OWNER: ${t.needsOwner.question}`);
  if (t.blocked) flags.push(`BLOCKED: ${t.blocked.reason}`);
  if (t.openDeps.length) flags.push(`waits ${t.openDeps.join(",")}`);
  if (t.team) flags.push(`team ${t.team}`);
  const ac = t.acceptanceTotal ? ` [${t.acceptanceDone}/${t.acceptanceTotal}]` : "";
  return `${statusIcon(t.status)} ${t.id.padEnd(6)} P${t.priority} ${t.status.padEnd(17)} ${t.type === "epic" ? "[epic] " : ""}${t.title}${ac}${flags.length ? `  (${flags.join("; ")})` : ""}`;
}

export function renderTask(t: Task, opts: { history?: boolean } = {}): string {
  const out: string[] = [];
  out.push(`# ${t.id}: ${t.title}`);
  out.push("");
  out.push(`- status: **${t.status}**${t.blocked ? ` — BLOCKED by ${t.blocked.by}: ${t.blocked.reason}` : ""}`);
  if (t.needsOwner) out.push(`- waiting for the owner (asked by ${t.needsOwner.by}, returns to ${t.needsOwner.previous}): ${t.needsOwner.question}`);
  out.push(`- type: ${t.type}, priority: P${t.priority}`);
  if (t.mergeStrategy) out.push(`- integration: ${t.mergeStrategy}`);
  if (t.parent) out.push(`- parent: ${t.parent}`);
  if (t.children.length) out.push(`- children: ${t.children.join(", ")}`);
  if (t.deps.length) out.push(`- depends on: ${t.deps.join(", ")}`);
  if (t.labels.length) out.push(`- labels: ${t.labels.join(", ")}`);
  if (t.team) out.push(`- team: ${t.team}${t.assignees.length ? ` (${t.assignees.join(", ")})` : ""}`);
  if (t.worktree) out.push(`- worktree: ${t.worktree.path}${t.worktree.branch ? ` @ ${t.worktree.branch}` : ""}`);
  out.push("", "## Description", "", t.description.trim() || "_empty_", "", "## Acceptance criteria", "");
  if (t.acceptance.length) {
    for (const a of t.acceptance) out.push(`- [${a.done ? "x" : " "}] #${a.id} ${a.text}${a.checkedBy ? ` _(checked by ${a.checkedBy})_` : ""}`);
  } else {
    out.push("_none_");
  }
  if (t.plan.trim()) out.push("", "## Plan", "", t.plan.trim());
  if (t.notes.trim()) out.push("", "## Notes", "", t.notes.trim());
  if (t.artifacts.length) {
    out.push("", "## Artifacts (read one with action artifact_read / `genie artifact-show`)", "");
    for (const a of t.artifacts) out.push(`- #${a.id} [${a.kind}] ${a.name} (${a.size} B) — ${a.author} (${a.role}), ${a.at}${a.note ? ` — ${a.note}` : ""}`);
  }
  if (t.comments.length) {
    out.push("", "## Comments", "");
    for (const c of t.comments) out.push(`- **${c.author}** (${c.role}, ${c.kind}, ${c.at}):\n  ${c.text.replace(/\n/g, "\n  ")}`);
  }
  if (opts.history) {
    out.push("", "## History", "");
    for (const h of t.history) out.push(`- ${h.at} ${h.actor} (${h.role}): ${h.event}${h.from ? ` ${h.from} → ${h.to}` : ""}${h.note ? ` — ${h.note}` : ""}`);
  }
  return out.join("\n");
}

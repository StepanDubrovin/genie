// Theme-aware, width-safe presentation for the genie tools' transcript rows.
//
// Presentation only: nothing here touches tool behavior. Pure summary helpers
// (`callSegments` / `callText` / `preview`) are exported for tests; the
// `renderCallRow` / `renderResult` adapters are thin wrappers over Pi's
// `Text` and `TruncatedText` components.

import { keyHint, keyText, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText, type Component } from "@earendil-works/pi-tui";

export type Tone = "title" | "accent" | "text" | "muted" | "dim" | "warning" | "error" | "success";

export interface Segment {
  text: string;
  tone: Tone;
  strong?: boolean;
}

/** Lines shown before a collapsed result starts counting hidden ones. */
export const COLLAPSED_LINES = 8;

const TITLE = (name: string): Segment => ({ text: name, tone: "title", strong: true });
const ACCENT = (t: string): Segment => ({ text: t, tone: "accent", strong: true });
const MUTED = (t: string): Segment => ({ text: t, tone: "muted" });
const DIM = (t: string): Segment => ({ text: t, tone: "dim" });
const PLAIN = (t: string): Segment => ({ text: t, tone: "text" });
const SPACE: Segment = { text: " ", tone: "muted" };
const SEP: Segment = { text: " · ", tone: "muted" };
const ARROW: Segment = { text: " → ", tone: "muted" };

// ---------------------------------------------------------------- primitives

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? sanitize(value) : "";
}

/** Replace control characters (newlines, tabs, ESC) with spaces so a row cannot distort. */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collapse whitespace and clip to `max` characters with an ellipsis. */
export function snippet(value: unknown, max = 56): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const flat = sanitize(raw).replace(/\s+/g, " ").trim();
  if (max <= 1) return flat.slice(0, Math.max(0, max));
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function quoted(text: string): string {
  return `"${text}"`;
}

function baseName(file: string): string {
  if (!file) return "";
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Semantic tone for a tracker status. */
export function statusTone(status: string): Tone {
  switch (status) {
    case "done":
    case "approved":
      return "success";
    case "cancelled":
      return "error";
    case "needs_owner":
      return "warning";
    case "in_progress":
    case "review":
      return "accent";
    default:
      return "muted";
  }
}

function colorOf(tone: Tone): ThemeColor {
  switch (tone) {
    case "title":
      return "toolTitle";
    case "accent":
      return "accent";
    case "muted":
      return "muted";
    case "dim":
      return "dim";
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "success":
      return "success";
    default:
      return "text";
  }
}

function mergeDetails(out: Segment[], details: Segment[][]): Segment[] {
  const nonEmpty = details.filter((d) => d.length);
  nonEmpty.forEach((d, i) => {
    out.push(i === 0 ? SPACE : SEP, ...d);
  });
  return out;
}

// ---------------------------------------------------------------- call summaries

const UPDATE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["title", "title"],
  ["description", "description"],
  ["type", "type"],
  ["priority", "priority"],
  ["plan", "plan"],
  ["appendNotes", "notes"],
  ["mergeStrategy", "merge strategy"],
  ["labels", "labels"],
  ["acceptance", "+criteria"],
  ["removeAcceptance", "-criteria"],
  ["deps", "+deps"],
  ["removeDeps", "-deps"],
];

function updatedFields(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, label] of UPDATE_FIELDS) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) out.push(`${label}×${v.length}`);
      continue;
    }
    if (typeof v === "string" && !v.trim()) continue;
    out.push(label);
  }
  return out;
}

function callFlags(a: Record<string, unknown>, defs: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [key, label] of defs) if (a[key] === true) out.push(label);
  return out;
}

function roleList(members: Record<string, unknown>[], max: number): string {
  return snippet(
    members.map((m) => str(m.role) || "?").join(", "),
    max,
  );
}

function genieTaskCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("genie_task")];
  const action = str(a.action);
  if (!action) return [...out, DIM(" …")];
  out.push({ text: ` ${action}`, tone: "accent" });
  const id = str(a.id);
  if (id) out.push(ACCENT(` ${id}`));

  const details: Segment[][] = [];
  switch (action) {
    case "list": {
      const filters: string[] = [];
      const statuses = arr(a.statuses).map(str).filter(Boolean);
      if (statuses.length) filters.push(statuses.join(", "));
      if (a.includeClosed) filters.push("+closed");
      const parent = str(a.parent);
      if (parent) filters.push(`parent ${parent}`);
      if (filters.length) details.push([MUTED(`[${filters.join("; ")}]`)]);
      break;
    }
    case "create": {
      const title = str(a.title);
      if (title) details.push([PLAIN(quoted(snippet(title, 48)))]);
      const type = str(a.type);
      if (type) details.push([MUTED(type)]);
      const parent = str(a.parent);
      if (parent) details.push([MUTED(`parent ${parent}`)]);
      break;
    }
    case "update": {
      const fields = updatedFields(a);
      if (fields.length) details.push([MUTED(fields.join(", "))]);
      break;
    }
    case "status": {
      const status = str(a.status);
      if (status) out.push(ARROW, { text: status, tone: statusTone(status), strong: true });
      break;
    }
    case "comment":
    case "block": {
      const kind = str(a.kind);
      if (kind) details.push([MUTED(`[${kind}]`)]);
      const text = action === "block" ? str(a.text) || str(a.note) : str(a.text);
      if (text) details.push([DIM(quoted(snippet(text, 56)))]);
      break;
    }
    case "check":
    case "uncheck": {
      const criterion = a.criterion;
      if (typeof criterion === "number") details.push([PLAIN(`#${criterion}`)]);
      break;
    }
    case "artifact": {
      const kind = str(a.kind);
      if (kind) details.push([MUTED(kind)]);
      const name = str(a.name) || baseName(str(a.file));
      if (name) details.push([PLAIN(name)]);
      break;
    }
    case "artifact_read": {
      const artifact = a.artifact;
      if (typeof artifact === "number") details.push([PLAIN(`#${artifact}`)]);
      break;
    }
    case "split": {
      const count = arr(a.children).length;
      if (count) details.push([MUTED(`×${count} children`)]);
      break;
    }
  }
  return mergeDetails(out, details);
}

function teamSpawnCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("team_spawn")];
  const task = str(a.task);
  if (task) out.push(ACCENT(` ${task}`));
  const details: Segment[][] = [];
  const members = arr(a.members).map(rec);
  if (members.length) {
    const noun = members.length === 1 ? "member" : "members";
    details.push([MUTED(`${members.length} ${noun}: `), MUTED(roleList(members, 60))]);
  } else {
    details.push([MUTED(`template ${str(a.template) || "standard"}`)]);
  }
  const flags = callFlags(a, [
    ["worktree", "worktree"],
    ["force", "force"],
  ]);
  const mode = str(a.mode);
  if (mode && mode !== "auto") flags.push(mode);
  if (flags.length) details.push([MUTED(flags.join(" · "))]);
  return mergeDetails(out, details);
}

function teamAddMemberCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("team_add_member")];
  const team = str(a.team);
  if (team) out.push(ACCENT(` ${team}`));
  const members = arr(a.members).map(rec);
  const details: Segment[][] = [];
  if (members.length) details.push([MUTED(`+${members.length}: `), MUTED(roleList(members, 48))]);
  return mergeDetails(out, details);
}

function teamSendCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("team_send"), ARROW, ACCENT(str(a.to) || "…")];
  if (a.urgent) out.push({ text: " !", tone: "warning", strong: true });
  const text = snippet(str(a.text), 64);
  const details: Segment[][] = [];
  if (text) details.push([DIM(quoted(text))]);
  const team = str(a.team);
  if (team) details.push([MUTED(`team ${team}`)]);
  return mergeDetails(out, details);
}

function teamStatusCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("team_status")];
  const team = str(a.team);
  if (team) out.push(ACCENT(` ${team}`));
  return out;
}

function teamSetStatusCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("team_set_status")];
  const status = snippet(str(a.status), 64);
  if (status) out.push(PLAIN(` ${quoted(status)}`));
  return out;
}

function teamStopCall(a: Record<string, unknown>): Segment[] {
  const out: Segment[] = [TITLE("team_stop")];
  const team = str(a.team);
  if (team) out.push(ACCENT(` ${team}`));
  const flags = callFlags(a, [
    ["removeWorktree", "remove worktree"],
    ["forceRemove", "force"],
  ]);
  if (flags.length) out.push(SPACE, MUTED(flags.join(" · ")));
  return out;
}

/** Action-specific call summary for any genie-registered tool. */
export function callSegments(name: string, args: unknown): Segment[] {
  const a = rec(args);
  switch (name) {
    case "genie_task":
      return genieTaskCall(a);
    case "team_spawn":
      return teamSpawnCall(a);
    case "team_add_member":
      return teamAddMemberCall(a);
    case "team_send":
      return teamSendCall(a);
    case "team_status":
      return teamStatusCall(a);
    case "team_set_status":
      return teamSetStatusCall(a);
    case "team_stop":
      return teamStopCall(a);
    default:
      return [TITLE(name)];
  }
}

/** Plain-text form of a call summary, for tests and diagnostics. */
export function callText(name: string, args: unknown): string {
  return callSegments(name, args)
    .map((s) => s.text)
    .join("");
}

/** Apply theme colors and emphasis to a segment list. */
export function styleSegments(segs: Segment[], theme: Theme): string {
  return segs
    .map((s) => {
      const colored = theme.fg(colorOf(s.tone), s.text);
      return s.strong ? theme.bold(colored) : colored;
    })
    .join("");
}

// ---------------------------------------------------------------- result summaries

export interface TextBlock {
  type: string;
  text?: string;
}

export interface ResultLike {
  content: TextBlock[];
}

export interface ResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

export interface ResultContext {
  isError: boolean;
  expanded: boolean;
}

/** Join the text blocks of a tool result; non-text blocks are ignored. */
export function resultText(result: ResultLike): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** Split content into the lines shown collapsed and the number hidden. */
export function preview(lines: string[], expanded: boolean, max = COLLAPSED_LINES): { shown: string[]; hidden: number } {
  if (expanded || lines.length <= max) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, max), hidden: lines.length - max };
}

// ---------------------------------------------------------------- components

/** One-line, width-safe call row. */
export function renderCallRow(name: string, args: unknown, theme: Theme): Component {
  return new TruncatedText(styleSegments(callSegments(name, args), theme), 0, 0);
}

/**
 * Compact result view: a state glyph, the first `COLLAPSED_LINES` lines and a
 * hidden-line count when collapsed; full output (and diagnostics) when expanded.
 * Errors are shown in the theme's error color and partial results stay dim.
 */
export function renderResult(result: ResultLike, options: ResultOptions, theme: Theme, context: ResultContext): Component {
  const raw = resultText(result)
    .replace(/\r/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
  const lines = raw.length ? raw.split("\n") : [];
  const state: "error" | "partial" | "success" = context.isError ? "error" : options.isPartial ? "partial" : "success";
  const tone: Tone = state === "error" ? "error" : state === "partial" ? "dim" : "text";

  const { shown, hidden } = preview(lines, options.expanded);
  const out = shown.map((line) => theme.fg(tone, line));
  if (hidden > 0) out.push(theme.fg("muted", `… ${hidden} more line${hidden === 1 ? "" : "s"} (`) + expandHint() + theme.fg("muted", ")"));
  if (!out.length) {
    const empty = state === "partial" ? "…" : state === "error" ? "failed" : "(no output)";
    out.push(theme.fg(state === "error" ? "error" : "muted", empty));
  }
  // The partial glyph is redundant when the body already starts with an ellipsis.
  const suppressGlyph = state === "partial" && (shown[0] ?? "").trimStart().startsWith("…");
  if (!suppressGlyph) {
    const glyph = state === "error" ? theme.fg("error", "✗") : state === "partial" ? theme.fg("dim", "…") : theme.fg("success", "✓");
    out[0] = `${glyph} ${out[0]}`;
  }
  return new Text(out.join("\n"), 0, 0);
}

function expandHint(): string {
  try {
    // keyText is empty outside an interactive session (e.g. HTML export).
    return keyText("app.tools.expand") ? keyHint("app.tools.expand", "to expand") : "expand";
  } catch {
    return "expand";
  }
}

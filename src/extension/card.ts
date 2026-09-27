// Live team progress rendering for the orchestrator's chat: an inline card under
// team_spawn / team_add_member results and a compact widget above the editor.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Member, Team, TeamBus } from "../team/bus.ts";
import type { Status } from "../tracker/model.ts";
import type { Tracker } from "../tracker/store.ts";
import { displayName, memberLabel } from "../team/names.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STAGES: Status[] = ["refining", "ready", "in_progress", "review", "approved", "done"];

function stageOf(status: Status, previous?: Status): number {
  const s = status === "needs_owner" && previous ? previous : status;
  if (s === "changes_requested") return STAGES.indexOf("in_progress") + 1;
  const i = STAGES.indexOf(s);
  return i < 0 ? 0 : i + 1;
}

function bar(theme: Theme, filled: number, total: number): string {
  return theme.fg("accent", "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(Math.max(0, total - filled)));
}

function elapsed(fromIso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}m` : m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function shortModel(model?: string): string {
  if (!model) return "default";
  const id = model.slice(model.indexOf("/") + 1);
  return id.length > 22 ? `${id.slice(0, 21)}…` : id;
}

function memberGlyph(m: Member, team: Team, frame: number, theme: Theme): string {
  if (team.state === "stopped" || m.state === "stopped") return theme.fg("dim", "■");
  if (m.activity === "error") return theme.fg("error", "✗");
  if (m.state === "starting") return theme.fg("warning", SPINNER[frame % SPINNER.length]);
  if (m.activity === "working") return theme.fg("accent", SPINNER[frame % SPINNER.length]);
  return theme.fg("muted", "○");
}

export interface TeamSnapshot {
  team: Team;
  status: Status;
  title: string;
  previous?: Status;
  pending: Record<string, number>;
}

export function snapshot(bus: TeamBus, tracker: Tracker, teamId: string): TeamSnapshot | undefined {
  try {
    const team = bus.get(teamId);
    const task = tracker.get(team.task);
    const pending: Record<string, number> = {};
    for (const m of team.members) pending[m.name] = bus.pending(team.id, m.name);
    return { team, status: task.status, title: task.title, previous: task.needsOwner?.previous, pending };
  } catch {
    return undefined;
  }
}

export function isAnimating(s: TeamSnapshot | undefined): boolean {
  return !!s && s.team.state === "active";
}

/** Full card: header with spinner, stage bar and elapsed time, one line per member. */
export function renderCard(s: TeamSnapshot | undefined, theme: Theme, frame: number, width: number): string[] {
  if (!s) return [truncateToWidth(theme.fg("dim", "team not found"), width)];
  const { team } = s;
  const done = s.status === "done";
  const head =
    team.state === "active"
      ? s.status === "needs_owner"
        ? theme.fg("warning", "!")
        : theme.fg("accent", SPINNER[frame % SPINNER.length])
      : done
        ? theme.fg("success", "✓")
        : theme.fg("dim", "■");
  const status = s.status === "needs_owner" ? theme.fg("warning", "needs owner") : s.status === "done" ? theme.fg("success", "done") : theme.fg("text", s.status.replace("_", " "));
  const stage = stageOf(s.status, s.previous);
  const lines = [
    `${head} ${theme.bold(`Team ${team.id}`)} ${theme.fg("muted", "·")} ${s.title} ${theme.fg("muted", "·")} ${status}  ${bar(theme, stage, STAGES.length)}  ${theme.fg("dim", elapsed(team.created))}${team.worktree ? theme.fg("dim", `  ⎇ ${team.worktree.branch}`) : ""}`,
  ];
  for (const m of team.members) {
    const mail = s.pending[m.name] ? theme.fg("warning", ` ✉${s.pending[m.name]}`) : "";
    const statusText = m.activity === "error" ? theme.fg("error", m.status) : theme.fg(m.activity === "working" ? "text" : "muted", m.status);
    lines.push(`  ${memberGlyph(m, team, frame, theme)} ${memberLabel(m.name, m.role).padEnd(24)} ${theme.fg("dim", shortModel(m.model).padEnd(23))} ${statusText}${mail}`);
  }
  return lines.map((l) => truncateToWidth(l, width));
}

/** One line per active team for the widget above the editor. */
export function renderWidgetLines(snaps: TeamSnapshot[], theme: Theme, frame: number, width: number): string[] {
  return snaps.map((s) => {
    const working = s.team.members.filter((m) => m.activity === "working").length;
    const head = s.status === "needs_owner" ? theme.fg("warning", "!") : working ? theme.fg("accent", SPINNER[frame % SPINNER.length]) : theme.fg("muted", "○");
    const members = s.team.members
      .map((m) => `${memberGlyph(m, s.team, frame, theme)} ${displayName(m.name)}${s.pending[m.name] ? theme.fg("warning", `✉${s.pending[m.name]}`) : ""}`)
      .join("  ");
    return truncateToWidth(`${head} ${theme.bold(s.team.id)} ${bar(theme, stageOf(s.status, s.previous), STAGES.length)} ${theme.fg("muted", s.status.replace("_", " "))}  ${members}`, width);
  });
}

/** A component that re-reads state on every render. */
export class LiveLines implements Component {
  private read: (width: number) => string[];
  constructor(read: (width: number) => string[]) {
    this.read = read;
  }
  render(width: number): string[] {
    return this.read(width);
  }
  invalidate(): void {}
}

// Team operations shared by the pi extension, the CLI and the web server:
// launching members, adding/removing them, stopping and deleting teams, and
// stopping teams whose task was closed.

import { CLOSED, type MemberRole, type Task } from "../tracker/model.ts";
import type { Tracker } from "../tracker/store.ts";
import { BROADCAST, type Member, ORCHESTRATOR, type StopReason, type Team, type TeamBus } from "./bus.ts";
import { type GenieConfig, loadConfig, loadRole, type MemberSpec, resolveMember } from "./config.ts";
import { assignNames, displayName, memberLabel } from "./names.ts";
import { discoverMembers, launchHeadless, launchHerdr, type LaunchSpec, removeWorktree, stopMember } from "./spawn.ts";

export type Named = MemberSpec & { name: string };
export type LaunchMode = "herdr" | "headless";

export function resolveLaunchMode(requested: string | undefined, cfg: GenieConfig): LaunchMode {
  const mode = requested ?? cfg.spawn.mode ?? "auto";
  if (mode === "herdr" || mode === "headless") return mode;
  return process.env.HERDR_ENV === "1" ? "herdr" : "headless";
}

/** The first message every member receives: who they are, the team, and what to do first. */
export function kickoff(teamId: string, task: Task, cwd: string, worktree: Team["worktree"], all: Named[], s: Named, extra?: string, joining = false): string {
  const hasAnalyst = all.some((x) => x.role === "analyst");
  const tester = all.find((x) => x.role === "tester");
  const notify = `message the reviewer${tester ? ` and the tester (${tester.name})` : ""}`;
  const refinement = !["ready", "changes_requested", "in_progress", "review"].includes(task.status);
  const first: Record<MemberRole, string> = {
    analyst: refinement
      ? "The task is not ready yet: research it, propose a precise description and verifiable acceptance criteria (genie_task update), write your findings as an `analysis` artifact, then report to the orchestrator."
      : "Start now: analyse the task, save the plan (genie_task update → plan), then hand over to the executor with team_send.",
    executor:
      hasAnalyst && !joining
        ? `Wait for the analyst's handoff before implementing: publish a waiting status (team_set_status) and end your turn without messaging anyone. When you start: genie_task status → in_progress; when you hand over: commit, attach a test-report artifact, genie_task status → review, then ${notify}.`
        : `Start now: genie_task status → in_progress, implement, commit, attach a test-report artifact, genie_task status → review, then ${notify}.`,
    reviewer: refinement
      ? "Challenge the analyst's findings: when the analyst shares them, check them for gaps and risks and send your feedback directly to the analyst."
      : "Wait until the executor asks for review: publish a waiting status (team_set_status) and end your turn without messaging anyone. When reviewing: check each verified criterion, attach one review artifact, set status approved or changes_requested, then message the executor (and the orchestrator on approval).",
    tester:
      "Wait until the executor submits the work for review, then test it: write/run tests against the acceptance criteria, attach a test-report artifact, and send the results to the executor and reviewer. If tests fail, set status changes_requested with a note.",
    documenter: "Wait until the implementation is approved or the orchestrator asks you, then write/update the documentation, attach a `doc` artifact and tell the orchestrator.",
  };
  return [
    `${joining ? "You are joining team" : "Welcome to team"} ${teamId}, ${displayName(s.name)}! You are the ${s.role}; teammates address you as "${s.name}". Task: ${task.id} — ${task.title} (status ${task.status}). Read it with genie_task {"action":"show"}.`,
    worktree ? `Working directory: ${cwd} (branch ${worktree.branch}, base ${String(worktree.base).slice(0, 10)}).` : `Working directory: ${cwd}.`,
    `Team: ${all.map((x) => `${memberLabel(x.name, x.role, "en")} (\`${x.name}\`)`).join(", ")}, plus orchestrator.`,
    first[s.role],
    extra ? `\nFrom ${joining ? "whoever added you" : "the orchestrator"}: ${extra}` : "",
  ].join("\n");
}

/** Start member processes; never waits for them to become ready. */
export async function launchMembers(
  tracker: Tracker,
  bus: TeamBus,
  team: Team,
  specs: Named[],
  mode: LaunchMode,
  opts: { anchorPane?: string; resume?: Map<string, string | undefined>; cfg?: GenieConfig } = {},
): Promise<void> {
  const cfg = opts.cfg ?? loadConfig(tracker.dir);
  const logDir = bus.runtimeDir(team.id);
  const launchSpecs: LaunchSpec[] = specs.map((s) => ({ team, member: s, role: loadRole(s.role, tracker.dir), genieDir: tracker.dir, cwd: team.cwd, cfg, resumeSession: opts.resume?.get(s.name) }));
  const runtimes = mode === "herdr" ? await launchHerdr(launchSpecs, logDir, opts.anchorPane) : launchSpecs.map((s) => launchHeadless(s, logDir));
  specs.forEach((s, i) => bus.updateMember(team.id, s.name, { runtime: runtimes[i] }));
}

/** Names in use by active teams, so new members get distinct names. */
export function takenNames(bus: TeamBus): Set<string> {
  return new Set(bus.list().flatMap((t) => t.members.map((m) => m.name)));
}

/**
 * Add members to an active team: assign names, register, send kickoffs, tell the
 * rest of the team, and launch (next to the team's herdr panes when it has them).
 */
export async function addMembers(
  tracker: Tracker,
  bus: TeamBus,
  teamId: string,
  requested: MemberSpec[],
  opts: { by: string; note?: string; maxMembers?: number } ,
): Promise<Named[]> {
  const cfg = loadConfig(tracker.dir);
  const team = bus.get(teamId);
  if (team.state !== "active") throw new Error(`team ${team.id} is stopped`);
  const max = opts.maxMembers ?? cfg.limits.maxMembersPerTeam;
  if (team.members.length + requested.length > max) throw new Error(`limit: at most ${max} members per team`);
  const specs = assignNames(requested.map((m) => resolveMember(m, cfg)), takenNames(bus), cfg.names) as Named[];
  for (const s of specs) {
    if (!/^[a-z][a-z0-9_-]*$/.test(s.name)) throw new Error(`member name "${s.name}" must match [a-z][a-z0-9_-]*`);
    if ([ORCHESTRATOR, BROADCAST].includes(s.name)) throw new Error(`member name "${s.name}" is reserved`);
    if (team.members.some((m) => m.name === s.name)) throw new Error(`team ${team.id} already has a member ${s.name}`);
  }
  const at = new Date().toISOString();
  for (const s of specs) bus.addMember(team.id, { name: s.name, role: s.role, model: s.model, thinking: s.thinking, instructions: s.instructions, status: "starting", statusAt: at, state: "starting" });
  const updated = bus.get(team.id);
  const task = tracker.get(team.task);
  const all: Named[] = updated.members.map((m) => ({ name: m.name, role: m.role, model: m.model }));
  for (const s of specs) bus.send({ team: team.id, from: ORCHESTRATOR, fromRole: "orchestrator", to: s.name, kind: "kickoff", text: kickoff(team.id, task, team.cwd, team.worktree, all, s, opts.note, true) });
  for (const m of team.members) {
    bus.send({ team: team.id, from: ORCHESTRATOR, fromRole: "orchestrator", to: m.name, kind: "system", text: `New teammate(s): ${specs.map((s) => memberLabel(s.name, s.role, "en")).join(", ")} (added by ${opts.by}).` });
  }
  const herdrPane = team.members.find((m) => m.runtime?.kind === "herdr" && m.runtime.paneId)?.runtime?.paneId;
  const mode: LaunchMode = herdrPane && process.env.HERDR_ENV === "1" ? "herdr" : "headless";
  await launchMembers(tracker, bus, updated, specs, mode, { anchorPane: mode === "herdr" ? herdrPane : undefined, cfg });
  bus.log(team.id, { event: "members_added", by: opts.by, members: specs.map((s) => s.name) });
  return specs;
}

async function killMember(genieDir: string, teamId: string, m: Member): Promise<void> {
  await stopMember(m.runtime);
  // A member may have been restarted outside our records: stop whatever still runs.
  for (const f of discoverMembers(genieDir)) {
    if (f.team === teamId && f.member === m.name) await stopMember({ kind: "headless", pid: f.pid });
  }
}

/** Remove one member: stop its process, drop it from the roster, tell the team. */
export async function removeMember(tracker: Tracker, bus: TeamBus, teamId: string, name: string, by: string): Promise<void> {
  const team = bus.get(teamId);
  const m = team.members.find((x) => x.name === name);
  if (!m) throw new Error(`team ${teamId} has no member ${name}`);
  await killMember(tracker.dir, teamId, m);
  bus.removeMember(teamId, name);
  const rest = team.members.filter((x) => x.name !== name);
  if (team.state === "active") {
    for (const r of rest) bus.send({ team: teamId, from: ORCHESTRATOR, fromRole: "orchestrator", to: r.name, kind: "system", text: `${memberLabel(m.name, m.role, "en")} left the team (removed by ${by}). Do not wait for them.` });
    bus.send({ team: teamId, from: ORCHESTRATOR, fromRole: "orchestrator", to: ORCHESTRATOR, kind: "system", text: `${memberLabel(m.name, m.role, "en")} was removed from team ${teamId} by ${by}.` });
  }
}

export interface StopOptions {
  reason: StopReason;
  by: string;
  removeWorktree?: boolean;
  forceRemove?: boolean;
}

/** Stop every member, mark the team stopped, optionally remove its worktree, release an open task. */
export async function stopTeam(tracker: Tracker, bus: TeamBus, teamId: string, opts: StopOptions): Promise<string[]> {
  const team = bus.get(teamId);
  for (const m of team.members) await killMember(tracker.dir, team.id, m);
  bus.setState(team.id, "stopped", opts.reason);
  bus.log(team.id, { event: "team_stopped", by: opts.by, reason: opts.reason });
  const out = [`team ${team.id} stopped`];
  if (team.worktree) {
    if (opts.removeWorktree) {
      try {
        removeWorktree(team.worktree.path, opts.forceRemove);
        out.push(`worktree ${team.worktree.path} removed; branch ${team.worktree.branch} kept`);
      } catch (err) {
        out.push(`worktree not removed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      out.push(`worktree kept: ${team.worktree.path} (branch ${team.worktree.branch})`);
    }
  }
  try {
    const task = tracker.get(team.task);
    if (!CLOSED.includes(task.status) && task.team === team.id) {
      tracker.assignTeam({ name: "orchestrator", role: "orchestrator" }, task.id, undefined);
      out.push(`${task.id} released (status ${task.status})`);
    }
  } catch {
    // task gone
  }
  if (opts.reason === "owner") bus.notifyOrchestrator(opts.by, `The owner stopped team ${team.id} (task ${team.task}).`, team.task);
  return out;
}

/** Stop (if needed) and delete a team with its roster, mail and log. */
export async function deleteTeam(tracker: Tracker, bus: TeamBus, teamId: string, opts: { by: string; removeWorktree?: boolean; forceRemove?: boolean }): Promise<string[]> {
  const team = bus.get(teamId);
  const out = team.state === "active" || team.members.some((m) => m.state !== "stopped") ? await stopTeam(tracker, bus, teamId, { reason: "owner", ...opts }) : [];
  if (team.state === "stopped" && opts.removeWorktree && team.worktree) {
    try {
      removeWorktree(team.worktree.path, opts.forceRemove);
      out.push(`worktree ${team.worktree.path} removed`);
    } catch (err) {
      out.push(`worktree not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  bus.deleteTeam(teamId);
  out.push(`team ${teamId} deleted`);
  return out;
}

/** Teams still running although their task is done or cancelled get stopped. */
export async function reapClosedTeams(tracker: Tracker, bus: TeamBus): Promise<string[]> {
  const stopped: string[] = [];
  for (const team of bus.list()) {
    let status: string | undefined;
    try {
      status = tracker.get(team.task).status;
    } catch {
      status = undefined;
    }
    if (status && !CLOSED.includes(status as never)) continue;
    await stopTeam(tracker, bus, team.id, { reason: "task_closed", by: "genie" });
    stopped.push(team.id);
  }
  return stopped;
}

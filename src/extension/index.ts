// genie — orchestrator + focus teams for pi.
//
// One extension, two faces:
//   orchestrator — the owner's session. Intake, decomposition, team dispatch, acceptance.
//   member       — analyst / executor / reviewer / tester / documenter processes started by
//                  team_spawn (GENIE_ROLE, GENIE_TEAM, GENIE_MEMBER, GENIE_TASK, GENIE_DIR in env).
// Everything is shared through the tracker database in .genie/genie.db.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DocsContext, formatReadResult, formatSearchResults, writeDocNote } from "../docs/context.ts";
import { DOC_STATUSES, DOC_TYPES } from "../docs/parser.ts";
import { DocsService } from "../docs/service.ts";
import { notifyOn } from "../notify.ts";
import { artifactReadContent } from "../web/artifacts.ts";
import { BROADCAST, HEARTBEAT_STALE_MS, type Mail, MAIL_INTENTS, MAIL_LEVELS, type Member, ORCHESTRATOR, START_GRACE_MS, type Team, TeamBus } from "../team/bus.ts";
import { renderDigest } from "../team/digest.ts";
import { type GenieConfig, languagePolicy, loadConfig, loadRole, type MemberSpec, PACKAGE_ROOT, resolveMember } from "../team/config.ts";
import { assignNames, displayName, memberLabel } from "../team/names.ts";
import { addMembers, deleteTeam, kickoff, launchMembers, type Named, reapClosedTeams, removeMember, stopTeam } from "../team/ops.ts";
import { createWorktree, discoverMembers, herdrAgentName, isAlive, launchHeadless, launchHerdr, type LaunchSpec, removeWorktree, stopMember } from "../team/spawn.ts";
import { defaultGenieDir, now, repoInfo } from "../tracker/fsutil.ts";
import { type Actor, ARTIFACT_KINDS, CLOSED, COMMENT_KINDS, MEMBER_ROLES, type MemberRole, type Status, STATUSES, TASK_TYPES, type Task } from "../tracker/model.ts";
import { oneLine, renderTask } from "../tracker/render.ts";
import { GenieError, Tracker } from "../tracker/store.ts";
import { isAnimating, LiveLines, renderCard, renderWidgetLines, snapshot, type TeamSnapshot } from "./card.ts";
import { renderCallRow, renderResult, type ResultContext, type ResultLike, type ResultOptions } from "./render.ts";
import { settingsMenu } from "./settings.ts";

type Mode = { kind: "off" } | { kind: "orchestrator" } | { kind: "member"; role: MemberRole; team: string; member: string; task: string };

const DOCS_TOOLS = ["docs_search", "docs_read", "docs_note"];
const ORCHESTRATOR_TOOLS = ["genie_task", "team_spawn", "team_add_member", "team_remove_member", "team_send", "team_status", "team_recover", "team_stop", ...DOCS_TOOLS];
const MEMBER_TOOLS = ["genie_task", "team_send", "team_status", "team_set_status", ...DOCS_TOOLS];
const ALL_TOOLS = [...new Set([...ORCHESTRATOR_TOOLS, ...MEMBER_TOOLS])];
const POLL_MS = 1000;
const HEARTBEAT_EVERY_MS = 5_000;
const SUPERVISE_EVERY_MS = 10_000;
const FRAME_MS = 120;
/** Roles allowed in a team for a task that is not ready yet (research / refinement teams). */
const REFINEMENT_ROLES: MemberRole[] = ["analyst", "reviewer", "documenter"];

function text(t: string, details: unknown = undefined) {
  return { content: [{ type: "text" as const, text: t }], details };
}

function envMode(): Mode | undefined {
  const role = process.env.GENIE_ROLE;
  if (role && (MEMBER_ROLES as readonly string[]).includes(role)) {
    const { GENIE_TEAM: team, GENIE_MEMBER: member, GENIE_TASK: task } = process.env;
    if (team && member && task) return { kind: "member", role: role as MemberRole, team, member, task };
  }
  if (role === "orchestrator") return { kind: "orchestrator" };
  if (role === "off") return { kind: "off" };
  return undefined;
}

export default function genie(pi: ExtensionAPI) {
  let mode: Mode = { kind: "off" };
  let tracker: Tracker | undefined;
  let bus: TeamBus | undefined;
  let docsContext: DocsContext | undefined;
  let lastCtx: ExtensionContext | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let animator: ReturnType<typeof setInterval> | undefined;
  let unsubscribeNotify: (() => void) | undefined;
  let tui: TUI | undefined;
  let frame = 0;
  let runMode: ExtensionContext["mode"] = "tui";
  const cardInvalidators = new Map<string, () => void>();
  const snapCache = new Map<string, { at: number; snap: TeamSnapshot | undefined }>();

  const cfg = (): GenieConfig => loadConfig(tracker?.dir);
  const actor = (): Actor => (mode.kind === "member" ? { name: mode.member, role: mode.role } : { name: ORCHESTRATOR, role: "orchestrator" });

  const need = (): { tracker: Tracker; bus: TeamBus } => {
    if (!tracker || !bus) throw new GenieError("no genie tracker in this project; run /genie init (or `genie init`)");
    return { tracker, bus };
  };

  /** Docs services always resolve against the caller's own project root (worktree or main checkout). */
  function docsService(ctx: ExtensionContext): DocsService {
    const { tracker } = need();
    const c = cfg();
    return new DocsService({ db: tracker.db, cwd: ctx.cwd, trackerDir: tracker.dir, docsRoot: c.docs?.root });
  }

  function cachedSnapshot(teamId: string): TeamSnapshot | undefined {
    if (!tracker || !bus) return undefined;
    const hit = snapCache.get(teamId);
    if (hit && Date.now() - hit.at < 400) return hit.snap;
    const snap = snapshot(bus, tracker, teamId);
    snapCache.set(teamId, { at: Date.now(), snap });
    return snap;
  }

  function applyTools(): void {
    const allowed = mode.kind === "orchestrator" ? ORCHESTRATOR_TOOLS : mode.kind === "member" ? MEMBER_TOOLS : [];
    const others = pi.getActiveTools().filter((n) => !ALL_TOOLS.includes(n));
    pi.setActiveTools([...others, ...allowed]);
  }

  function resolveMode(ctx: ExtensionContext): void {
    const fromEnv = envMode();
    tracker?.close();
    tracker = Tracker.tryOpen(ctx.cwd);
    bus = tracker ? new TeamBus(tracker) : undefined;
    if (tracker) tracker.gates = cfg().gates ?? {};
    docsContext = tracker ? new DocsContext({ db: tracker.db, trackerDir: tracker.dir, docsRoot: cfg().docs?.root }) : undefined;
    mode = fromEnv ?? (tracker ? { kind: "orchestrator" } : { kind: "off" });
    if (mode.kind === "member" && !tracker) {
      ctx.ui.notify(`genie: GENIE_DIR not found for member ${mode.member}; team tools disabled`, "error");
      mode = { kind: "off" };
    }
    unsubscribeNotify?.();
    unsubscribeNotify = mode.kind === "orchestrator" && tracker ? notifyOn(tracker, cfg()) : undefined;
    applyTools();
  }

  // ---------------------------------------------------------------- mail

  function formatMail(m: Mail): string {
    if (m.kind === "kickoff") return `[genie kickoff · team ${m.team}]\n\n${m.text}`;
    if (m.kind === "owner") return `[genie · owner activity${m.task ? ` · ${m.task}` : ""}]\n\n${m.text}`;
    const intent = m.intent ? ` · ${m.intent}` : "";
    return `[genie mail · team ${m.team} · from ${m.from} (${m.fromRole}) · ${m.level}${intent}]\n\n${m.text}`;
  }

  /** Orchestrator batch: specials (kickoff/owner/system) verbatim first, then the digest. */
  function renderOrchestratorBatch(mails: Mail[]): string {
    const specials = mails.filter((m) => m.kind !== "message");
    const messages = mails.filter((m) => m.kind === "message");
    const parts: string[] = [];
    if (specials.length) parts.push(specials.map(formatMail).join("\n\n---\n\n"));
    if (messages.length) parts.push(renderDigest(messages));
    return parts.join("\n\n---\n\n");
  }

  function deliver(mails: Mail[], opts: { steer?: boolean } = {}): void {
    if (!mails.length) return;
    const hint =
      mode.kind === "orchestrator"
        ? "(Act only if a decision, answer, unblock or acceptance is needed; purely informational updates need no reply — just end your turn.)"
        : "(Reply with team_send only if a reply is needed; do not send acknowledgements.)";
    const body = mode.kind === "orchestrator" && !opts.steer ? renderOrchestratorBatch(mails) : mails.map(formatMail).join("\n\n---\n\n");
    const content = `${body}\n\n${hint}`;
    const idle = safeIdle();
    // sendUserMessage goes through the regular prompt path, so before_agent_start
    // injects the role section; custom messages with triggerTurn would bypass it.
    if (idle) pi.sendUserMessage(content);
    // Re-checked here so a slice claimed while idle is never dropped if the session
    // became busy in between: it queues as a follow-up instead of being lost.
    else pi.sendUserMessage(content, { deliverAs: opts.steer ? "steer" : "followUp" });
  }

  /**
   * Claim mail at delivery time: while idle take the whole slice as ONE batch;
   * while busy take nothing except urgent mail, which steers on its own.
   */
  function deliverFor(team: string | undefined, member: string): void {
    if (!bus) return;
    if (runMode === "print" || runMode === "json") return;
    const { batch, steers } = bus.takeMail(team, member, safeIdle());
    deliver(batch);
    for (const m of steers) deliver([m], { steer: true });
  }

  /** A captured ctx goes stale after reload/session replacement; never let that break the timers. */
  function safeIdle(): boolean {
    try {
      return lastCtx ? lastCtx.isIdle() && !lastCtx.hasPendingMessages() : true;
    } catch {
      lastCtx = undefined;
      return true;
    }
  }

  function safeNotify(msg: string, level: "info" | "warning" | "error"): void {
    try {
      lastCtx?.ui.notify(msg, level);
    } catch {
      lastCtx = undefined;
    }
  }

  function poll(): void {
    if (!bus) return;
    // One-shot print/json runs must not be extended by queued mail.
    if (runMode === "print" || runMode === "json") return;
    try {
      if (mode.kind === "member" && Date.now() - lastBeat >= HEARTBEAT_EVERY_MS) {
        lastBeat = Date.now();
        bus.heartbeat(mode.team, mode.member, process.pid);
      }
      if (mode.kind === "orchestrator" && Date.now() - lastSupervise >= SUPERVISE_EVERY_MS) {
        lastSupervise = Date.now();
        supervise();
      }
      if (mode.kind === "member") deliverFor(mode.team, mode.member);
      else if (mode.kind === "orchestrator" && cfg().orchestrator?.autoWake !== false) deliverFor(undefined, ORCHESTRATOR);
      refreshStatus();
    } catch (err) {
      safeNotify(`genie: mail poll failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  }

  // ---------------------------------------------------------------- supervision & recovery

  let lastBeat = 0;
  let lastSupervise = 0;

  /** Is the member's process still there? Uses the recorded pid, then a /proc scan. */
  function processAlive(teamId: string, m: Member, found: () => Map<string, number>): boolean {
    if (m.runtime?.pid && isAlive(m.runtime.pid)) return true;
    const pid = found().get(`${teamId}/${m.name}`);
    return !!pid && isAlive(pid);
  }

  function lazyDiscovery(): () => Map<string, number> {
    let cache: Map<string, number> | undefined;
    return () => (cache ??= new Map(discoverMembers(tracker!.dir).map((f) => [`${f.team}/${f.member}`, f.pid])));
  }

  /**
   * Orchestrator-side watchdog: members that never check in after launch or stop
   * sending heartbeats (and whose process is gone) are marked lost, and the
   * orchestrator gets one urgent message suggesting team_recover.
   */
  function supervise(): void {
    if (!bus || !tracker) return;
    // Teams whose task was closed elsewhere (e.g. dragged to Done in the web UI) are stopped.
    void reapClosedTeams(tracker, bus)
      .then((ids) => ids.length && safeNotify(`genie: stopped team(s) of closed tasks: ${ids.join(", ")}`, "info"))
      .catch(() => undefined);
    const found = lazyDiscovery();
    for (const team of bus.recoverable()) {
      for (const m of team.members) {
        if (m.state === "stopped" || m.state === "lost") continue;
        const beat = m.heartbeatAt ? Date.parse(m.heartbeatAt) : 0;
        const age = Date.now() - (beat || Date.parse(m.statusAt));
        if (age < (beat ? HEARTBEAT_STALE_MS : START_GRACE_MS)) continue;
        if (processAlive(team.id, m, found)) {
          // Alive but silent (e.g. an older genie version): adopt it.
          bus.heartbeat(team.id, m.name, found().get(`${team.id}/${m.name}`));
          continue;
        }
        reportLost(team.id, m, beat ? `stopped responding (last heartbeat ${Math.round(age / 1000)}s ago)` : "did not start");
      }
    }
  }

  /** Mark a member lost and tell the orchestrator once, so it can run team_recover. */
  function reportLost(teamId: string, m: Member, why: string): void {
    if (!bus) return;
    bus.markLost(teamId, m.name, why);
    bus.send({
      team: teamId,
      from: "genie",
      fromRole: "system",
      to: ORCHESTRATOR,
      kind: "system",
      urgent: true,
      text: `${memberLabel(m.name, m.role, "en")} in team ${teamId} ${why}. Run team_recover to restart it — its conversation continues from its saved session.`,
    });
  }

  /**
   * Find running member processes, reconnect them, and optionally restart lost members
   * (continuing their saved pi session). Returns a human-readable report.
   */
  async function recoverTeams(opts: { team?: string; restart: boolean }): Promise<{ report: string; changed: boolean }> {
    const { tracker, bus } = need();
    const found = discoverMembers(tracker.dir);
    const alive = new Map(found.map((f) => [`${f.team}/${f.member}`, f.pid]));
    const lines: string[] = [];
    let changed = false;
    for (const f of found) {
      if (opts.team && f.team !== opts.team) continue;
      try {
        const r = bus.heartbeat(f.team, f.member, f.pid);
        if (r.revived || r.teamRevived) changed = true;
      } catch {
        // process of a team this tracker no longer knows
      }
    }
    const teams = bus.recoverable().filter((t) => !opts.team || t.id === opts.team);
    for (const team of teams) {
      const parts: string[] = [];
      const lost: Member[] = [];
      for (const m of team.members) {
        const pid = alive.get(`${team.id}/${m.name}`) ?? (m.runtime?.pid && isAlive(m.runtime.pid) ? m.runtime.pid : undefined);
        if (m.state === "stopped") parts.push(`${memberLabel(m.name, m.role, "en")}: stopped`);
        else if (pid) parts.push(`${memberLabel(m.name, m.role, "en")}: running (pid ${pid})`);
        else if (m.state === "starting" && Date.now() - Date.parse(m.statusAt) < START_GRACE_MS) parts.push(`${memberLabel(m.name, m.role, "en")}: starting`);
        else lost.push(m);
      }
      if (lost.length && opts.restart) {
        const c = cfg();
        const anchor = team.members.find((m) => m.runtime?.kind === "herdr" && m.runtime.paneId && !lost.includes(m))?.runtime?.paneId;
        const useHerdr = process.env.HERDR_ENV === "1" && lost.some((m) => m.runtime?.kind === "herdr");
        const specs: Named[] = lost.map((m) => resolveMember({ name: m.name, role: m.role, model: m.model, thinking: m.thinking, instructions: m.instructions }, c) as Named);
        const at = now();
        for (const m of lost) bus.updateMember(team.id, m.name, { state: "starting", status: "restarting after lost contact" });
        if (team.state === "stopped") bus.setState(team.id, "active");
        try {
          await launch(specs, bus.get(team.id), useHerdr ? "herdr" : "headless", anchor, new Map(lost.map((m) => [m.name, m.sessionFile])));
          for (const m of lost) {
            bus.send({
              team: team.id,
              from: ORCHESTRATOR,
              fromRole: "orchestrator",
              to: m.name,
              kind: "system",
              text: `You were restarted after the team lost contact with you (${at}). Re-read the task (genie_task show) and the latest messages, tell your teammates where you stand, then continue your work.`,
            });
            parts.push(`${memberLabel(m.name, m.role, "en")}: restarted${m.sessionFile ? " (session resumed)" : " (fresh session)"}`);
          }
          bus.log(team.id, { event: "team_restarted", members: lost.map((m) => m.name) });
          changed = true;
        } catch (err) {
          for (const m of lost) bus.markLost(team.id, m.name, `restart failed: ${err instanceof Error ? err.message : String(err)}`);
          parts.push(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        for (const m of lost) {
          if (m.state !== "lost") {
            reportLost(team.id, m, "is not running (process not found)");
            changed = true;
          }
          parts.push(`${memberLabel(m.name, m.role, "en")}: LOST${m.sessionFile ? " (session saved, restartable)" : ""}`);
        }
      }
      lines.push(`team ${team.id} (${bus.get(team.id).state}) → ${team.task}\n  ${parts.join("\n  ")}`);
    }
    return { report: lines.join("\n") || "no teams to recover", changed };
  }

  // ---------------------------------------------------------------- UI: widget, status, animation

  function activeSnapshots(): TeamSnapshot[] {
    if (!bus || mode.kind !== "orchestrator") return [];
    return bus
      .list()
      .map((t) => cachedSnapshot(t.id))
      .filter((s): s is TeamSnapshot => !!s);
  }

  function installWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (mode.kind !== "orchestrator") {
      ctx.ui.setWidget("genie", undefined);
      return;
    }
    ctx.ui.setWidget("genie", (t: TUI, theme: Theme) => {
      tui = t;
      return new LiveLines((width) => renderWidgetLines(activeSnapshots(), theme, frame, width));
    });
  }

  function refreshStatus(): void {
    try {
      refreshStatusUnsafe();
    } catch {
      lastCtx = undefined;
    }
  }

  function refreshStatusUnsafe(): void {
    const ctx = lastCtx;
    if (!ctx?.hasUI || !tracker) return;
    if (mode.kind === "orchestrator") {
      const c = tracker.counts();
      const open = Object.entries(c)
        .filter(([s]) => !CLOSED.includes(s as Status))
        .reduce((n, [, v]) => n + v, 0);
      const parts = [`${open} open`];
      if (c.inbox) parts.push(`${c.inbox} inbox`);
      if (c.needs_owner) parts.push(`${c.needs_owner} need you`);
      ctx.ui.setStatus("genie", `genie: ${parts.join(" · ")}`);
    } else if (mode.kind === "member") {
      let status = "?";
      try {
        status = tracker.get(mode.task).status;
      } catch {
        // ignore
      }
      ctx.ui.setStatus("genie", `genie: ${memberLabel(mode.member, mode.role)} · team ${mode.team} · ${mode.task} ${status}`);
    }
  }

  function animate(): void {
    frame++;
    const anyActive = activeSnapshots().length > 0;
    for (const [teamId, invalidate] of cardInvalidators) {
      invalidate();
      if (!isAnimating(cachedSnapshot(teamId))) cardInvalidators.delete(teamId);
    }
    if (anyActive || cardInvalidators.size) tui?.requestRender();
  }

  function startTimers(): void {
    stopTimers();
    if (mode.kind === "off") return;
    // The first poll waits one interval so the session's own first prompt goes first.
    poller = setInterval(poll, POLL_MS);
    poller.unref?.();
    if (mode.kind === "orchestrator" && runMode === "tui") {
      animator = setInterval(animate, FRAME_MS);
      animator.unref?.();
    }
  }

  function stopTimers(): void {
    if (poller) clearInterval(poller);
    if (animator) clearInterval(animator);
    poller = animator = undefined;
  }

  // ---------------------------------------------------------------- prompt

  function promptSection(): string | undefined {
    if (!tracker || !bus || mode.kind === "off") return undefined;
    const c = cfg();
    if (mode.kind === "orchestrator") {
      const role = loadRole("orchestrator", tracker.dir);
      const templates = Object.entries(c.teams ?? {}).map(([name, t]) => `- ${name}: ${t.description ?? ""} Members: ${t.members.map((m) => `${m.name}/${m.role}`).join(", ")}; worktree: ${t.worktree ? "yes" : "no"}`);
      const models = MEMBER_ROLES.map((r) => `${r} → ${c.roleModels?.[r]?.model ?? "pi default"}`).join(", ");
      const teams = bus.list().map((t) => `- ${t.id} → ${t.task} (${t.members.map((m) => `${m.name}: ${m.status}`).join("; ")})`);
      const counts = tracker.counts();
      return [
        role.prompt,
        "",
        languagePolicy(c),
        "",
        "## Workspace",
        `Tracker: ${tracker.dir}. Inbox: ${counts.inbox ?? 0}. Waiting for the owner: ${counts.needs_owner ?? 0}. Ready queue: ${tracker.readyQueue().map((t) => t.id).join(", ") || "empty"}.`,
        `Open epics: ${
          tracker
            .list({ type: ["epic"] })
            .map((e) => `${e.id} "${e.title}" (${e.status}, ${e.childrenClosed}/${e.children} tasks closed)`)
            .join("; ") || "none"
        }.`,
        `Workflow statuses: ${STATUSES.join(", ")}.`,
        `Limits: at most ${c.limits.maxMembersPerTeam} members per team and ${c.limits.maxActiveTeams} active teams.`,
        `Default models per role: ${models}.`,
        "",
        "Team templates (presets; compose members freely when the task needs it):",
        ...templates,
        "",
        teams.length ? "Active teams:" : "No active teams.",
        ...teams,
      ].join("\n");
    }
    const m = mode;
    const role = loadRole(m.role, tracker.dir);
    let team: Team | undefined;
    try {
      team = bus.get(m.team);
    } catch {
      // team deleted
    }
    const me = team?.members.find((x) => x.name === m.member);
    let epic: Task | undefined;
    try {
      epic = tracker.epicContext(m.task).epic;
    } catch {
      // task deleted
    }
    return [
      role.prompt,
      "",
      languagePolicy(c),
      "",
      "## Your team",
      `You are ${displayName(m.member)}, the ${m.role} of team ${m.team}, working on task ${m.task}. Teammates call you "${m.member}".`,
      team?.worktree ? `Working directory: ${team.cwd} (git worktree, branch ${team.worktree.branch}, base commit ${team.worktree.base}).` : `Working directory: ${team?.cwd ?? "(unknown)"}.`,
      "Teammates (message them with team_send using the lowercase id; `orchestrator` is the task owner, `all` broadcasts). Refer to teammates by name:",
      ...(team?.members.map((x) => `- ${memberLabel(x.name, x.role, "en")} (id \`${x.name}\`), model ${x.model ?? "default"}${x.name === m.member ? " — you" : ""}`) ?? []),
      me?.instructions ? `\nSpecific instructions for you: ${me.instructions}` : "",
      role.mcp.includes("*") ? "" : `\nMCP servers you may use: ${role.mcp.join(", ") || "none"}.`,
      "",
      epic
        ? `\nYour task is part of epic ${epic.id} — ${epic.title}. \`genie_task show\` of your task includes the epic's goal and lists its shared artifacts (${epic.artifacts.length}); read the relevant ones with artifact_read and id ${epic.id}. Material useful for the whole epic goes to the epic (comment / artifact with id ${epic.id}), everything else stays on your task.`
        : "",
      "",
      "The tracker is only reachable through genie_task; do not look for its files. Keep the task up to date: comment progress and decisions, attach artifacts, move the status when your step is done. You may only modify your own task and its sub-tasks (and comment on / attach artifacts to its epic). You cannot start other agents.",
    ].join("\n");
  }

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    runMode = ctx.mode;
    resolveMode(ctx);
    if (mode.kind === "member" && bus) {
      try {
        bus.updateMember(mode.team, mode.member, { state: "active", sessionFile: ctx.sessionManager.getSessionFile() });
        bus.heartbeat(mode.team, mode.member, process.pid);
        lastBeat = Date.now();
        bus.log(mode.team, { event: "member_started", member: mode.member });
      } catch {
        // team missing: messages will fail loudly
      }
    }
    installWidget(ctx);
    startTimers();
    refreshStatus();
    // After a restart/reload the orchestrator reconnects to teams that kept working.
    if (mode.kind === "orchestrator" && bus && (runMode === "tui" || runMode === "rpc")) {
      setTimeout(() => {
        recoverTeams({ restart: false })
          .then((r) => {
            if (r.changed) safeNotify(`genie: reconnected to running teams\n${r.report}`, "info");
          })
          .catch(() => undefined);
      }, 3000).unref?.();
    }
  });

  pi.on("session_shutdown", async () => {
    stopTimers();
    unsubscribeNotify?.();
    unsubscribeNotify = undefined;
    cardInvalidators.clear();
    if (mode.kind === "member" && bus) {
      try {
        bus.updateMember(mode.team, mode.member, { state: "stopped" });
        bus.setActivity(mode.team, mode.member, "idle");
        bus.log(mode.team, { event: "member_stopped", member: mode.member });
      } catch {
        // ignore
      }
    }
    // Members are independent processes: they keep working while the orchestrator restarts.
    tracker?.close();
    tracker = undefined;
    bus = undefined;
    docsContext = undefined;
    lastCtx = undefined;
    tui = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    lastCtx = ctx;
    const section = promptSection();
    const inventory = docsContext?.l0(ctx.cwd);
    if (section) event.systemPromptOptions.sections.genie = inventory ? `${section}\n\n${inventory.text}` : section;
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    if (mode.kind === "member" && bus) bus.setActivity(mode.team, mode.member, "working");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastCtx = ctx;
    if (mode.kind === "member" && bus) {
      const m = mode;
      const current = bus.get(m.team).members.find((x) => x.name === m.member);
      if (current?.activity !== "error") bus.setActivity(m.team, m.member, "idle");
    }
    // The step just ended: deliver the freshly unblocked mail now instead of up
    // to a tick later (the poller remains the backstop).
    try {
      if (mode.kind === "member") deliverFor(mode.team, mode.member);
      else if (mode.kind === "orchestrator" && cfg().orchestrator?.autoWake !== false) deliverFor(undefined, ORCHESTRATOR);
    } catch (err) {
      safeNotify(`genie: mail delivery failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    refreshStatus();
  });

  // Surface model/provider failures of members: otherwise a member whose model is
  // unavailable just goes silent and the team stalls.
  let lastErrorAt = 0;
  pi.on("message_end", async (event) => {
    if (mode.kind !== "member" || !bus) return undefined;
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (msg.role !== "assistant" || msg.stopReason !== "error") return undefined;
    const error = (msg.errorMessage ?? "unknown model error").slice(0, 500);
    try {
      bus.log(mode.team, { event: "agent_error", member: mode.member, error });
      bus.setStatus(mode.team, mode.member, `ERROR: ${error.slice(0, 120)}`);
      bus.setActivity(mode.team, mode.member, "error");
      if (Date.now() - lastErrorAt > 60_000) {
        lastErrorAt = Date.now();
        bus.send({ team: mode.team, from: mode.member, fromRole: mode.role, to: ORCHESTRATOR, urgent: true, kind: "system", text: `My model request failed and I cannot continue: ${error}` });
      }
    } catch {
      // team missing
    }
    return undefined;
  });

  // ---------------------------------------------------------------- guards

  pi.on("tool_call", async (event) => {
    if (mode.kind === "off" || !tracker) return undefined;
    const input = event.input as Record<string, unknown>;
    const genieDir = tracker.dir;
    const touchesTracker = (s: string) => s.includes(genieDir) || /(^|[\s/"'=])\.genie(\/|\s|$|["'])/.test(s) || s.includes("genie.db");

    // Task content reaches agents only on request, through genie_task / the genie CLI.
    if (["read", "grep", "find", "ls", "edit", "write"].includes(event.toolName)) {
      const p = String(input.path ?? input.file_path ?? "");
      if (p && (path.resolve(lastCtx?.cwd ?? ".", p).startsWith(genieDir) || touchesTracker(p))) {
        return { block: true, reason: "genie: the tracker is only accessible through the genie_task tool" };
      }
    }
    if (event.toolName === "bash") {
      const cmd = String(input.command ?? "");
      // The orchestrator never waits for teams: messages wake it up.
      const sleepFor = Math.max(0, ...[...cmd.matchAll(/\bsleep\s+(\d+)/g)].map((m) => Number(m[1])));
      if (mode.kind === "orchestrator" && sleepFor >= 20 && bus?.list().length) {
        return { block: true, reason: "genie: do not wait for teams — end your turn. Team messages wake you automatically, and you are warned if a member is lost (then use team_recover)." };
      }
      if (touchesTracker(cmd) && !/^\s*genie\s/.test(cmd)) return { block: true, reason: "genie: use genie_task (or the `genie` CLI) instead of reading the tracker files" };
      if (mode.kind === "member" && /(^|[;&|(]\s*|\bexec\s+)(pi|claude|codex|opencode)(\s|$)|herdr\s+(agent\s+start|pane\s+split|tab\s+create)/.test(cmd)) {
        return { block: true, reason: "genie: team members cannot start other agents; ask the orchestrator (team_send) if more help is needed" };
      }
    }

    // MCP allowlist per role (pi-mcp-adapter proxy tool).
    if (mode.kind === "member" && event.toolName === "mcp") {
      const allowed = loadRole(mode.role, genieDir).mcp;
      if (allowed.includes("*")) return undefined;
      if (input.action === "install") return { block: true, reason: `genie: role ${mode.role} may not install MCP servers` };
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const server = (input.server ?? input.connect ?? input.instructions) as string | undefined;
      const tool = input.tool as string | undefined;
      if (server && !allowed.some((a) => norm(a) === norm(server))) return { block: true, reason: `genie: role ${mode.role} may use MCP servers: ${allowed.join(", ") || "none"}` };
      if (!server && tool && !allowed.some((a) => norm(tool).startsWith(`${norm(a)}_`))) {
        return { block: true, reason: `genie: role ${mode.role} may use MCP servers: ${allowed.join(", ") || "none"}; pass server explicitly` };
      }
    }
    return undefined;
  });

  // ---------------------------------------------------------------- genie_task

  /**
   * Members may modify their own task and its sub-tasks. With `allowEpic`, they may
   * also comment on / attach shared artifacts to the epic their task belongs to.
   */
  function assertScope(id: string, opts: { allowEpic?: boolean } = {}): void {
    if (mode.kind !== "member" || !tracker) return;
    const own = tracker.normalizeId(mode.task);
    let cur: Task | undefined = tracker.get(id);
    const target = cur.id;
    if (opts.allowEpic && cur.type === "epic" && tracker.get(own).parent === cur.id) return;
    while (cur) {
      if (cur.id === own) return;
      cur = cur.parent ? tracker.get(cur.parent) : undefined;
    }
    throw new GenieError(`${target} is outside your task ${own}; ask the orchestrator`);
  }

  pi.registerTool({
    name: "genie_task",
    label: "Genie task",
    description:
      "Local task tracker shared by the orchestrator and all team members. Actions: list, ready (ready queue), epics (epics with progress), show, create, update, status, comment, check/uncheck (acceptance criterion), artifact (attach), artifact_read, split, block, unblock. Epics (type epic) group tasks of a milestone: goal, success criteria, roadmap (plan) and shared artifacts; create a task in an epic with parent, move a task in or out with update + parent (an empty parent removes it); show of a task includes its epic's goal and shared artifacts. Members may only modify their own task and its sub-tasks (plus comments and artifacts on its epic); only the orchestrator can move tasks to draft/ready/needs_owner/done/cancelled. Use status needs_owner (with note = the question) when only the owner can decide.",
    promptSnippet: "Read and update tasks in the local genie tracker",
    parameters: Type.Object({
      action: StringEnum(["list", "ready", "epics", "show", "create", "update", "status", "comment", "check", "uncheck", "artifact", "artifact_read", "split", "block", "unblock"] as const),
      id: Type.Optional(Type.String({ description: "Task id, e.g. G-7 (a bare number is accepted). Members default to their own task." })),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String({ description: "Markdown description (create/update)" })),
      type: Type.Optional(StringEnum(TASK_TYPES)),
      priority: Type.Optional(Type.Number({ description: "0 (urgent) … 4 (low)" })),
      acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria to add (create/update)" })),
      removeAcceptance: Type.Optional(Type.Array(Type.Number(), { description: "Criterion numbers to remove (update)" })),
      plan: Type.Optional(Type.String({ description: "Implementation plan, replaces the current one (update)" })),
      appendNotes: Type.Optional(Type.String({ description: "Timestamped entry appended to the task notes (update)" })),
      mergeStrategy: Type.Optional(Type.String({ description: "How the result is integrated, agreed with the owner (orchestrator; create/update)" })),
      labels: Type.Optional(Type.Array(Type.String())),
      deps: Type.Optional(Type.Array(Type.String(), { description: "Dependency task ids to add (create/update)" })),
      removeDeps: Type.Optional(Type.Array(Type.String())),
      parent: Type.Optional(Type.String({ description: "Epic (or parent task) id: create a task in it, or move a task into it with update (\"\" removes it from its epic)" })),
      status: Type.Optional(StringEnum(STATUSES, { description: "Target status (status action)" })),
      note: Type.Optional(Type.String({ description: "Reason / summary recorded with a status change or artifact; the question for needs_owner" })),
      force: Type.Optional(Type.Boolean({ description: "Orchestrator only: bypass Definition of Ready/Done checks" })),
      text: Type.Optional(Type.String({ description: "Comment text (comment) or block reason (block)" })),
      kind: Type.Optional(Type.String({ description: `Comment kind (${COMMENT_KINDS.join(", ")}) or artifact kind (${ARTIFACT_KINDS.join(", ")})` })),
      criterion: Type.Optional(Type.Number({ description: "Acceptance criterion number (check/uncheck)" })),
      artifact: Type.Optional(Type.Number({ description: "Artifact number (artifact_read)" })),
      content: Type.Optional(Type.String({ description: "Artifact content (artifact)" })),
      file: Type.Optional(Type.String({ description: "Existing file to store as an artifact (artifact)" })),
      name: Type.Optional(Type.String({ description: "Artifact name, e.g. review.md or zcl_foo.abap (artifact)" })),
      children: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.Optional(Type.String()),
            acceptance: Type.Optional(Type.Array(Type.String())),
            deps: Type.Optional(Type.Array(Type.String())),
            type: Type.Optional(StringEnum(TASK_TYPES)),
            priority: Type.Optional(Type.Number()),
          }),
          { description: "Child tasks (split)" },
        ),
      ),
      includeClosed: Type.Optional(Type.Boolean({ description: "Include done/cancelled tasks (list)" })),
      statuses: Type.Optional(Type.Array(StringEnum(STATUSES), { description: "Filter by status (list)" })),
    }),
    renderCall: (args, theme) => renderCallRow("genie_task", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("genie_task", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const { tracker } = need();
      const me = actor();
      const id = p.id ?? (mode.kind === "member" ? mode.task : undefined);
      const requireId = (): string => {
        if (!id) throw new GenieError(`action ${p.action} needs id`);
        return id;
      };
      const write = (): string => {
        const tid = requireId();
        assertScope(tid);
        return tid;
      };
      switch (p.action) {
        case "list": {
          const tasks = tracker.list({ status: p.statuses as Status[] | undefined, includeClosed: p.includeClosed, parent: p.parent });
          return text(tasks.length ? tasks.map(oneLine).join("\n") : "no tasks", { ids: tasks.map((t) => t.id) });
        }
        case "ready": {
          const tasks = tracker.readyQueue();
          return text(tasks.length ? tasks.map(oneLine).join("\n") : "ready queue is empty", { ids: tasks.map((t) => t.id) });
        }
        case "show": {
          const t = tracker.get(requireId());
          return text(renderTask(t, tracker.epicContext(t.id)), { id: t.id });
        }
        case "epics": {
          const epics = tracker.list({ type: ["epic"], includeClosed: p.includeClosed });
          return text(epics.length ? epics.map(oneLine).join("\n") : "no epics", { ids: epics.map((t) => t.id) });
        }
        case "create": {
          if (p.parent) assertScope(p.parent);
          const t = tracker.create(me, {
            title: p.title ?? "",
            type: p.type,
            description: p.description,
            acceptance: p.acceptance,
            priority: p.priority,
            parent: p.parent,
            deps: p.deps,
            labels: p.labels,
            mergeStrategy: p.mergeStrategy,
          });
          return text(`created ${t.id}: ${t.title} (draft)`, { id: t.id });
        }
        case "update": {
          const t = tracker.update(me, write(), {
            title: p.title,
            type: p.type,
            description: p.description,
            plan: p.plan,
            appendNotes: p.appendNotes,
            mergeStrategy: p.mergeStrategy,
            priority: p.priority,
            labels: p.labels,
            addAcceptance: p.acceptance,
            removeAcceptance: p.removeAcceptance,
            addDeps: p.deps,
            removeDeps: p.removeDeps,
            parent: p.parent === undefined ? undefined : p.parent === "" ? null : p.parent,
          });
          return text(`updated ${t.id}`, { id: t.id });
        }
        case "status": {
          if (!p.status) throw new GenieError("status action needs status");
          const t = tracker.setStatus(me, write(), p.status as Status, { note: p.note, force: p.force });
          if (t.team && bus?.exists(t.team)) bus.log(t.team, { event: "task_status", task: t.id, status: t.status, by: me.name });
          if (CLOSED.includes(t.status) && bus && mode.kind === "orchestrator") await reapClosedTeams(tracker, bus);
          return text(`${t.id} → ${t.status}`, { id: t.id, status: t.status });
        }
        case "comment": {
          const cid = requireId();
          assertScope(cid, { allowEpic: true });
          const t = tracker.comment(me, cid, p.text ?? "", (p.kind ?? "note") as never);
          return text(`commented on ${t.id}`, { id: t.id });
        }
        case "check":
        case "uncheck": {
          if (p.criterion === undefined) throw new GenieError("check needs criterion");
          const t = tracker.check(me, write(), p.criterion, p.action === "check");
          return text(t.acceptance.map((a) => `[${a.done ? "x" : " "}] #${a.id} ${a.text}`).join("\n"), { id: t.id });
        }
        case "artifact": {
          const aid = requireId();
          assertScope(aid, { allowEpic: true });
          const t = tracker.addArtifact(me, aid, { kind: (p.kind ?? "other") as never, content: p.content, file: p.file, name: p.name, note: p.note });
          const a = t.artifacts.at(-1)!;
          return text(`attached artifact #${a.id} ${a.name} (${a.kind}) to ${t.id}`, { id: t.id, artifact: a.id });
        }
        case "artifact_read": {
          if (p.artifact === undefined) throw new GenieError("artifact_read needs artifact (number)");
          const taskId = requireId();
          const a = tracker.readArtifact(taskId, p.artifact);
          // Supported raster images within the cap become an image block (see artifactReadContent).
          // A non-vision session model gets the runtime's own "image omitted" note.
          const content = artifactReadContent({ n: p.artifact, name: a.name, kind: a.kind, content: a.content, text: a.text, modelSupportsImages: ctx.model?.input.includes("image") });
          return { content, details: { id: taskId, artifact: p.artifact } };
        }
        case "split": {
          if (!p.children?.length) throw new GenieError("split needs children");
          const created = tracker.split(me, requireId(), p.children);
          return text(created.map((c) => `created ${c.id}: ${c.title}`).join("\n"), { ids: created.map((c) => c.id) });
        }
        case "block": {
          const t = tracker.block(me, write(), p.text ?? p.note ?? "no reason given");
          if (t.team && bus?.exists(t.team)) bus.log(t.team, { event: "blocked", task: t.id, by: me.name, reason: t.blocked?.reason });
          return text(`${t.id} blocked`, { id: t.id });
        }
        case "unblock": {
          const t = tracker.unblock(me, write());
          return text(`${t.id} unblocked`, { id: t.id });
        }
      }
    },
  });

  // ---------------------------------------------------------------- team_spawn / team_add_member

  const memberSchema = Type.Object({
    name: Type.Optional(Type.String({ description: "Lowercase id, unique among active teams. Omit it: a playful name is picked automatically (e.g. sherlock the analyst, bender the executor)" })),
    role: StringEnum(MEMBER_ROLES),
    model: Type.Optional(Type.String({ description: "provider/model id; defaults to the role default from config" })),
    thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max" })),
    instructions: Type.Optional(Type.String({ description: "Extra instructions for this member" })),
  });

  function validateSpecs(specs: Named[], existing: string[], ctx: ExtensionContext): void {
    const names = new Set(existing);
    for (const s of specs) {
      if (!/^[a-z][a-z0-9_-]*$/.test(s.name)) throw new GenieError(`member name "${s.name}" must match [a-z][a-z0-9_-]*`);
      if (s.name === ORCHESTRATOR || s.name === BROADCAST) throw new GenieError(`member name "${s.name}" is reserved`);
      if (names.has(s.name)) throw new GenieError(`duplicate member name ${s.name}`);
      names.add(s.name);
      if (s.model) {
        const slash = s.model.indexOf("/");
        const found = slash > 0 ? ctx.modelRegistry.find(s.model.slice(0, slash), s.model.slice(slash + 1)) : undefined;
        if (!found) {
          const known = ctx.modelRegistry
            .getAvailable()
            .map((m) => `${m.provider}/${m.id}`)
            .slice(0, 40);
          throw new GenieError(`model ${s.model} for ${s.name} is not known to pi. Available: ${known.join(", ")}`);
        }
      }
    }
  }

  async function launch(specs: Named[], team: Team, launchMode: string, anchorPane?: string, resume?: Map<string, string | undefined>): Promise<void> {
    const { tracker, bus } = need();
    await launchMembers(tracker, bus, team, specs, launchMode === "herdr" ? "herdr" : "headless", { anchorPane, resume, cfg: cfg() });
  }

  /** Live team card for a result that carries a team id; undefined falls back to plain text. */
  function teamCard(details: unknown, theme: Theme, invalidate: () => void) {
    const teamId = (details as { team?: string } | undefined)?.team;
    if (!teamId) return undefined;
    if (!cachedSnapshot(teamId)) return undefined;
    if (isAnimating(cachedSnapshot(teamId))) cardInvalidators.set(teamId, invalidate);
    return new LiveLines((width) => renderCard(cachedSnapshot(teamId), theme, frame, width));
  }

  type ToolResult = ResultLike & { details?: unknown };

  /** Shared result renderer: spawn/add-member keep the live card, everything else shows a compact summary. */
  function renderToolResult(toolName: string, result: ToolResult, options: ResultOptions, theme: Theme, context: ResultContext & { invalidate: () => void }) {
    if (toolName === "team_spawn" || toolName === "team_add_member") {
      const card = teamCard(result.details, theme, context.invalidate);
      if (card) return card;
    }
    return renderResult(result, options, theme, context);
  }

  pi.registerTool({
    name: "team_spawn",
    label: "Spawn team",
    description:
      "Start a focus team for one task: pi agents in roles analyst / executor / reviewer / tester / documenter, each with its own model. Compose the roster to fit the task (members) or use a template. Tasks that are not ready yet may only get refinement teams (analyst, reviewer, documenter). Creates a dedicated git worktree when requested, opens members in herdr panes (inside herdr) or headless, and sends each member its kickoff. Members then coordinate directly with each other.",
    promptSnippet: "Start a focus team of agents for a task",
    parameters: Type.Object({
      task: Type.String({ description: "Task id" }),
      template: Type.Optional(Type.String({ description: "Team template preset (standard, pair, abap, spike, research…)" })),
      members: Type.Optional(Type.Array(memberSchema, { description: "Explicit roster; overrides the template members" })),
      worktree: Type.Optional(Type.Boolean({ description: "Override the template: create a dedicated git worktree" })),
      mode: Type.Optional(StringEnum(["auto", "herdr", "headless"] as const)),
      kickoff: Type.Optional(Type.String({ description: "Extra context for the whole team (constraints, priorities)" })),
      force: Type.Optional(Type.Boolean({ description: "Spawn even if the task status does not fit the roster" })),
    }),
    renderCall: (args, theme) => renderCallRow("team_spawn", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_spawn", result, options, theme, context),
    async execute(_id, p, _signal, onUpdate, ctx) {
      lastCtx = ctx;
      if (mode.kind !== "orchestrator") throw new GenieError("only the orchestrator can spawn teams");
      const { tracker, bus } = need();
      const c = cfg();
      const task = tracker.get(p.task);
      if (task.type === "epic") throw new GenieError(`${task.id} is an epic; spawn teams for its children`);
      if (task.team && bus.exists(task.team) && bus.get(task.team).state === "active") throw new GenieError(`${task.id} already has an active team ${task.team}; use team_add_member`);
      const active = bus.list().length;
      if (active >= c.limits.maxActiveTeams) throw new GenieError(`limit reached: ${active} active teams (max ${c.limits.maxActiveTeams}); stop a team first`);
      const templateName = p.template ?? (p.members?.length ? undefined : "standard");
      const template = templateName ? c.teams?.[templateName] : undefined;
      if (templateName && !template && !p.members?.length) throw new GenieError(`unknown team template ${templateName}; known: ${Object.keys(c.teams ?? {}).join(", ")}`);
      const taken = new Set(bus.list().flatMap((t) => t.members.map((m) => m.name)));
      const specs: Named[] = assignNames((p.members?.length ? (p.members as MemberSpec[]) : template!.members).map((m) => resolveMember(m, c)), taken, c.names);
      if (!specs.length) throw new GenieError("a team needs at least one member");
      if (specs.length > c.limits.maxMembersPerTeam) throw new GenieError(`limit: at most ${c.limits.maxMembersPerTeam} members per team (requested ${specs.length})`);
      const refinement = ["inbox", "draft", "refining"].includes(task.status);
      if (!p.force) {
        if (refinement && specs.some((s) => !REFINEMENT_ROLES.includes(s.role))) {
          throw new GenieError(`${task.id} is ${task.status}: only refinement roles (${REFINEMENT_ROLES.join(", ")}) until it is ready`);
        }
        if (!refinement && !["ready", "changes_requested"].includes(task.status)) throw new GenieError(`${task.id} is ${task.status}; teams start from ready (or pass force)`);
      }
      validateSpecs(specs, [], ctx);
      if (task.status === "inbox" || task.status === "draft") tracker.setStatus(actor(), task.id, "refining");

      const teamId = bus.freeId(task.id);
      const useWorktree = p.worktree ?? template?.worktree ?? false;
      const notes: string[] = [];
      let worktree: Team["worktree"];
      if (useWorktree) {
        if (repoInfo(ctx.cwd)) {
          onUpdate?.(text(`creating worktree for ${teamId}…`));
          worktree = createWorktree(ctx.cwd, teamId, task.id, c);
        } else {
          notes.push("not a git repository: worktree skipped, team works in the current directory");
        }
      }
      const cwd = worktree?.path ?? ctx.cwd;
      const at = now();
      const team = bus.create({
        id: teamId,
        task: task.id,
        template: p.members?.length ? undefined : templateName,
        cwd,
        worktree,
        members: specs.map((s): Omit<Member, "activity"> => ({ name: s.name, role: s.role, model: s.model, thinking: s.thinking, instructions: s.instructions, status: "starting", statusAt: at, state: "starting" })),
      });
      tracker.assignTeam(actor(), task.id, teamId, worktree ? { path: worktree.path, branch: worktree.branch } : undefined, specs.map((s) => `${s.name}@${teamId}`));
      const fresh = tracker.get(task.id);
      const epic = tracker.epicContext(fresh.id).epic;
      for (const s of specs) bus.send({ team: teamId, from: ORCHESTRATOR, fromRole: "orchestrator", to: s.name, kind: "kickoff", text: kickoff(teamId, fresh, cwd, worktree, specs, s, p.kickoff, false, epic, { db: tracker.db, trackerDir: tracker.dir, docsRoot: c.docs?.root }) });

      const requested = p.mode ?? c.spawn.mode ?? "auto";
      const launchMode = requested === "auto" ? (process.env.HERDR_ENV === "1" ? "herdr" : "headless") : requested;
      onUpdate?.(text(`launching ${specs.length} member(s) (${launchMode})…`));
      try {
        await launch(specs, team, launchMode);
      } catch (err) {
        bus.setState(teamId, "stopped", "launch_failed");
        bus.log(teamId, { event: "launch_failed", error: String(err) });
        tracker.assignTeam(actor(), task.id, undefined);
        throw new GenieError(`launch failed: ${err instanceof Error ? err.message : String(err)}${worktree ? ` (worktree ${worktree.path} kept)` : ""}`);
      }
      tracker.comment(actor(), task.id, `Team ${teamId} started (${launchMode}): ${specs.map((s) => `${s.name}/${s.role}=${s.model ?? "default"}`).join(", ")}${worktree ? `; worktree ${worktree.path} on ${worktree.branch}` : ""}`, "progress");
      return text(
        [
          `team ${teamId} started for ${task.id} (${launchMode})`,
          ...specs.map((s) => `- ${s.name}: ${s.role}, ${s.model ?? "default model"}${launchMode === "herdr" ? ` (herdr agent ${herdrAgentName(teamId, s.name)})` : ""}`),
          worktree ? `worktree: ${worktree.path} (branch ${worktree.branch})` : `cwd: ${cwd}`,
          ...notes,
          "Members are starting in the background and check in on their own; you do not wait for them. You receive their messages automatically, and a warning if one fails to start. End your turn now.",
        ].join("\n"),
        { team: teamId },
      );
    },
  });

  pi.registerTool({
    name: "team_add_member",
    label: "Add team member",
    description: "Attach additional members (e.g. an analyst for extra research, a tester or a documenter) to an active team. Respects the per-team member limit.",
    parameters: Type.Object({
      team: Type.String(),
      members: Type.Array(memberSchema),
      kickoff: Type.Optional(Type.String({ description: "Why they join and what to do" })),
    }),
    renderCall: (args, theme) => renderCallRow("team_add_member", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_add_member", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (mode.kind !== "orchestrator") throw new GenieError("only the orchestrator can add members");
      const { tracker, bus } = need();
      for (const m of p.members as MemberSpec[]) {
        const model = resolveMember(m, cfg()).model;
        const slash = model?.indexOf("/") ?? -1;
        if (model && !(slash > 0 && ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1)))) throw new GenieError(`model ${model} is not known to pi`);
      }
      const added = await addMembers(tracker, bus, p.team, p.members as MemberSpec[], { by: "orchestrator", note: p.kickoff });
      snapCache.delete(p.team);
      return text(`added ${added.map((s) => `${memberLabel(s.name, s.role, "en")} [${s.name}] (${s.model ?? "default"})`).join(", ")} to team ${p.team}`, { team: p.team });
    },
  });

  pi.registerTool({
    name: "team_remove_member",
    label: "Remove team member",
    description: "Remove a member from a team: its process is stopped and the rest of the team is told not to wait for it.",
    parameters: Type.Object({ team: Type.String(), member: Type.String({ description: "Member name (lowercase id)" }) }),
    renderCall: (args, theme) => renderCallRow("team_remove_member", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_remove_member", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (mode.kind !== "orchestrator") throw new GenieError("only the orchestrator can remove members");
      const { tracker, bus } = need();
      await removeMember(tracker, bus, p.team, p.member, "orchestrator");
      snapCache.delete(p.team);
      return text(`removed ${p.member} from team ${p.team}`, { team: p.team });
    },
  });

  // ---------------------------------------------------------------- team_send / status / stop

  pi.registerTool({
    name: "team_send",
    label: "Team message",
    description:
      'Send a message to a team member, to "orchestrator", or to "all" (broadcast). The level decides the delivery mode: low waits quietly until the recipient is free, normal (default) is delivered after its current step, high (or urgent: true) steers and interrupts it. intent explains what the mail is for and shapes the orchestrator digest. Keep messages short and point to the task/artifacts for details.',
    promptSnippet: "Message a teammate or the orchestrator directly",
    parameters: Type.Object({
      to: Type.String({ description: 'Member name, "orchestrator" or "all"' }),
      text: Type.String(),
      level: Type.Optional(StringEnum(MAIL_LEVELS, { description: "low = quiet until the recipient is free, normal = after the current step (default), high = interrupt now" })),
      intent: Type.Optional(StringEnum(MAIL_INTENTS, { description: "question | blocker | verdict | done | fyi — shapes the orchestrator's digest" })),
      urgent: Type.Optional(Type.Boolean({ description: "Alias for level: high (backwards compatible)" })),
      team: Type.Optional(Type.String({ description: "Team id (orchestrator only; defaults to the only active team)" })),
    }),
    renderCall: (args, theme) => renderCallRow("team_send", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_send", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const { bus } = need();
      let teamId: string;
      if (mode.kind === "member") teamId = mode.team;
      else {
        const active = bus.list();
        if (p.team) teamId = p.team;
        else if (active.length === 1) teamId = active[0].id;
        else throw new GenieError(`specify team; active teams: ${active.map((t) => t.id).join(", ") || "none"}`);
      }
      const me = actor();
      const sent = bus.send({ team: teamId, from: me.name, fromRole: me.role, to: p.to, text: p.text, level: p.level, intent: p.intent, urgent: p.urgent });
      return text(`delivered to ${sent.map((m) => m.to).join(", ")}`, { team: teamId });
    },
  });

  function describeTeam(t: Team, verbose: boolean): string {
    const { tracker, bus } = need();
    let taskStatus = "?";
    try {
      taskStatus = tracker.get(t.task).status;
    } catch {
      // ignore
    }
    const lines = [
      `team ${t.id} (${t.state}) — task ${t.task} [${taskStatus}]${t.worktree ? ` — ${t.worktree.path} @ ${t.worktree.branch}` : ""}`,
      ...t.members.map((m) => {
        const seen = m.heartbeatAt ? ` · seen ${Math.round((Date.now() - Date.parse(m.heartbeatAt)) / 1000)}s ago` : "";
        return `  ${memberLabel(m.name, m.role, "en")} [${m.name}] (${m.model ?? "default"}, ${m.state}/${m.activity}${seen}): ${m.status}${bus.pending(t.id, m.name) ? ` — ${bus.pending(t.id, m.name)} unread` : ""}`;
      }),
    ];
    if (verbose) {
      lines.push("  recent events:");
      for (const e of bus.readLog(t.id, 15)) lines.push(`    ${String(e.at).slice(11, 19)} ${e.event} ${JSON.stringify({ ...e, at: undefined, event: undefined })}`);
    }
    return lines.join("\n");
  }

  pi.registerTool({
    name: "team_status",
    label: "Team status",
    description: "Show team rosters, member statuses and activity, unread mail and recent team events. Members see their own team.",
    parameters: Type.Object({ team: Type.Optional(Type.String({ description: "Team id for a detailed view with recent events" })) }),
    renderCall: (args, theme) => renderCallRow("team_status", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_status", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const { bus } = need();
      const teamId = mode.kind === "member" ? mode.team : p.team;
      if (teamId) return text(describeTeam(bus.get(teamId), true), { team: teamId });
      const teams = bus.list();
      return text(teams.length ? teams.map((t) => describeTeam(t, false)).join("\n\n") : "no active teams");
    },
  });

  pi.registerTool({
    name: "team_set_status",
    label: "Set my status",
    description: "Publish a one-line status visible to the whole team and the orchestrator (e.g. 'implementing parser, 3/5 tests green').",
    parameters: Type.Object({ status: Type.String() }),
    renderCall: (args, theme) => renderCallRow("team_set_status", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_set_status", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (mode.kind !== "member") throw new GenieError("only team members have a status");
      need().bus.setStatus(mode.team, mode.member, p.status);
      return text("status published");
    },
  });

  pi.registerTool({
    name: "team_recover",
    label: "Recover teams",
    description:
      "Find running team member processes and reconnect to them (also teams whose launch looked failed), and restart members that were lost — a restarted member continues its saved conversation. Use it when a member is reported lost, after an orchestrator restart, or when a team seems silent.",
    promptSnippet: "Reconnect to running teams and restart lost members",
    parameters: Type.Object({
      team: Type.Optional(Type.String({ description: "Limit to one team" })),
      restart: Type.Optional(Type.Boolean({ description: "Restart lost members (default true)" })),
    }),
    renderCall: (args, theme) => renderCallRow("team_recover", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_recover", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (mode.kind !== "orchestrator") throw new GenieError("only the orchestrator can recover teams");
      const r = await recoverTeams({ team: p.team, restart: p.restart ?? true });
      snapCache.clear();
      return text(r.report, { team: p.team });
    },
  });

  pi.registerTool({
    name: "team_stop",
    label: "Stop team",
    description: "Stop all members of a team. Optionally remove its git worktree (the branch is kept for merging). If the task is not done, it is released from the team so it can be re-dispatched.",
    parameters: Type.Object({
      team: Type.String(),
      removeWorktree: Type.Optional(Type.Boolean({ description: "git worktree remove (branch is kept)" })),
      forceRemove: Type.Optional(Type.Boolean({ description: "Remove the worktree even with uncommitted changes" })),
    }),
    renderCall: (args, theme) => renderCallRow("team_stop", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("team_stop", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (mode.kind !== "orchestrator") throw new GenieError("only the orchestrator can stop teams");
      const { tracker, bus } = need();
      const out = await stopTeam(tracker, bus, p.team, { reason: "orchestrator", by: "orchestrator", removeWorktree: p.removeWorktree, forceRemove: p.forceRemove });
      snapCache.delete(p.team);
      return text(out.join("\n"));
    },
  });

  pi.registerTool({
    name: "docs_search",
    label: "Search docs",
    description:
      "Full-text search (SQLite FTS5, BM25) over this project's documentation. Returns path, title, type, status, refresh date, stale/draft/diagnostic markers, the matched snippet and per-file frontmatter diagnostics. Russian is not stemmed: search literal forms or use page aliases.",
    promptSnippet: "Search the project's docs",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms (FTS5, no stemming)" }),
      type: Type.Optional(StringEnum(DOC_TYPES)),
      status: Type.Optional(StringEnum(DOC_STATUSES)),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20, max 100)" })),
    }),
    renderCall: (args, theme) => renderCallRow("docs_search", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("docs_search", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      // Pass type/status/limit straight through: the "exclude deprecated unless
      // requested" default belongs to the service (bug G-19), not this tool.
      const results = docsService(ctx).search(p.query, { limit: p.limit, type: p.type, status: p.status });
      return text(formatSearchResults(results, p.query), { count: results.length });
    },
  });

  pi.registerTool({
    name: "docs_read",
    label: "Read docs",
    description:
      "Read one documentation page: metadata, staleness reasons, frontmatter diagnostics, wiki links/backlinks and content. Pass `heading` for one section or `wholePage: true` for the whole page (whole-page reads must be explicit). Content is clipped to `maxChars` (a character cap, because the docs service clips by characters; default 12000, max 100000) and carries a truncation marker.",
    promptSnippet: "Read a documentation page or heading",
    parameters: Type.Object({
      path: Type.String({ description: "Docs-root-relative path, e.g. architecture.md or reference/auth" }),
      heading: Type.Optional(Type.String({ description: "Read only this heading's section" })),
      maxChars: Type.Optional(Type.Number({ description: "Character cap (default 12000, max 100000)" })),
      wholePage: Type.Optional(Type.Boolean({ description: "Read the whole page (required without `heading`)" })),
    }),
    renderCall: (args, theme) => renderCallRow("docs_read", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("docs_read", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const result = docsService(ctx).read(p.path, { heading: p.heading, maxChars: p.maxChars, wholePage: p.wholePage });
      return text(formatReadResult(result), { path: result.path });
    },
  });

  pi.registerTool({
    name: "docs_note",
    label: "Capture a note",
    description:
      "Capture a quick note as <docs-root>/inbox/YYYY-MM-DD-slug.md (type note, status draft). The file is never overwritten and is written atomically; the index is refreshed so the note is immediately searchable. A note is a normal Markdown file: it is not automatically reviewed or merged, promotion and pruning are manual, and a note left uncommitted in a deleted worktree is lost — commit it if it matters.",
    promptSnippet: "Capture a docs note in the inbox",
    parameters: Type.Object({
      title: Type.String({ description: "Note title (also the filename slug)" }),
      body: Type.String({ description: "Markdown body" }),
      tags: Type.Optional(Type.Array(Type.String())),
      related: Type.Optional(Type.Array(Type.String(), { description: "Task/epic ids (defaults to your task)" })),
    }),
    renderCall: (args, theme) => renderCallRow("docs_note", args, theme),
    renderResult: (result, options, theme, context) => renderToolResult("docs_note", result, options, theme, context),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const related = p.related ?? (mode.kind === "member" ? [mode.task] : undefined);
      const written = writeDocNote(docsService(ctx), { title: p.title, body: p.body, tags: p.tags, related });
      return text(`note written: docs/${written.path}\nA note is not automatically reviewed or merged; commit it or it can be lost with a deleted worktree.`, { path: written.path });
    },
  });

  // ---------------------------------------------------------------- /genie command

  function startWeb(ctx: ExtensionContext, extra: string[]): void {
    const { tracker } = need();
    const port = cfg().web.port;
    const child = spawn(path.join(PACKAGE_ROOT, "bin", "genie"), ["web", "--port", String(port), ...extra], {
      cwd: tracker.root,
      env: { ...process.env, GENIE_DIR: tracker.dir },
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => ctx.ui.notify(`genie web failed: ${err.message}`, "error"));
    child.unref();
    ctx.ui.notify(`genie web → http://127.0.0.1:${port}${extra.includes("--tailscale") ? " (and on the tailnet)" : ""}`, "info");
  }

  pi.registerCommand("genie", {
    description: "genie: board | init | settings | web [--tailscale] | recover [team] | team <id> [stop|delete|add <role>|remove <member>] | mail <id> | on | off",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const [sub = "board", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const say = (msg: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, level);
      try {
        switch (sub) {
          case "init": {
            Tracker.init(defaultGenieDir(ctx.cwd)).close();
            resolveMode(ctx);
            installWidget(ctx);
            startTimers();
            say(`genie tracker ready at ${defaultGenieDir(ctx.cwd)}; this session is the orchestrator`);
            return;
          }
          case "settings":
            await settingsMenu(ctx, tracker?.dir);
            if (tracker) tracker.gates = cfg().gates ?? {};
            return;
          case "web":
            return startWeb(ctx, rest);
          case "recover": {
            const r = await recoverTeams({ team: rest.find((x) => !x.startsWith("--")), restart: !rest.includes("--no-restart") });
            snapCache.clear();
            return say(r.report);
          }
          case "on":
            if (!Tracker.tryOpen(ctx.cwd)) return say("no tracker here; run /genie init", "warning");
            process.env.GENIE_ROLE = "orchestrator";
            resolveMode(ctx);
            installWidget(ctx);
            startTimers();
            return say("genie orchestrator mode on");
          case "off":
            process.env.GENIE_ROLE = "off";
            stopTimers();
            resolveMode(ctx);
            ctx.ui.setWidget("genie", undefined);
            ctx.ui.setStatus("genie", undefined);
            return say("genie off for this session");
          case "team": {
            const { tracker, bus } = need();
            const [id = mode.kind === "member" ? mode.team : "", action, ...more] = rest;
            const flags = new Set(more.filter((x) => x.startsWith("--")));
            const args = more.filter((x) => !x.startsWith("--"));
            if (!action) return say(describeTeam(bus.get(id), true));
            if (action === "stop") return say((await stopTeam(tracker, bus, id, { reason: "owner", by: "owner", removeWorktree: flags.has("--rm-worktree") })).join("\n"));
            if (action === "delete") {
              if (!(await ctx.ui.confirm("Delete team", `Stop and delete team ${id} with its chat history?`))) return;
              return say((await deleteTeam(tracker, bus, id, { by: "owner", removeWorktree: flags.has("--rm-worktree") })).join("\n"));
            }
            if (action === "remove" && args[0]) {
              await removeMember(tracker, bus, id, args[0], "owner");
              return say(`removed ${args[0]} from team ${id}`);
            }
            if (action === "add" && args[0]) {
              const added = await addMembers(tracker, bus, id, [{ role: args[0] as MemberSpec["role"], name: args[1] }], { by: "owner" });
              return say(`added ${added.map((a) => memberLabel(a.name, a.role)).join(", ")} to team ${id}`);
            }
            return say("usage: /genie team <id> [stop|delete [--rm-worktree] | add <role> [name] | remove <member>]", "warning");
          }
          case "mail": {
            const { bus } = need();
            const id = rest[0] ?? (mode.kind === "member" ? mode.team : "");
            const mails = bus.history(id, 20);
            return say(mails.map((m) => `${m.at.slice(11, 19)} ${m.from} → ${m.to}: ${m.text.slice(0, 300)}`).join("\n") || "no mail");
          }
          default: {
            const { tracker, bus } = need();
            const tasks = tracker.list({ excludeEpics: true });
            const epics = tracker.list({ type: ["epic"] });
            const lines = (epics.length ? [`EPICS (${epics.length})`, ...epics.map((e) => `  ${oneLine(e)}`), ""] : []).concat(STATUSES.flatMap((s) => {
              const g = tasks.filter((t) => t.status === s);
              return g.length ? [`${s.toUpperCase()} (${g.length})`, ...g.map((t) => `  ${oneLine(t)}`)] : [];
            }));
            const teams = bus.list().map((t) => describeTeam(t, false));
            return say([...lines, ...(teams.length ? ["", ...teams] : [])].join("\n") || "board is empty");
          }
        }
      } catch (err) {
        say(`genie: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}

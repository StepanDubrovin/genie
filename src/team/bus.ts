// Team registry and peer-to-peer mailboxes, stored in the tracker database.
//
// Every agent is an independent pi process. Messages are rows, so members talk
// to each other directly without the orchestrator's model (or even its process)
// relaying them, and a team survives an orchestrator restart.

import * as fs from "node:fs";
import * as path from "node:path";
import type { MemberRole } from "../tracker/model.ts";
import { now } from "../tracker/fsutil.ts";
import type { Tracker } from "../tracker/store.ts";
import type { Db } from "../tracker/db.ts";

export const ORCHESTRATOR = "orchestrator";
export const BROADCAST = "all";

export interface MemberRuntime {
  kind: "herdr" | "headless" | "manual";
  paneId?: string;
  pid?: number;
}

export type Activity = "idle" | "working" | "error";

export interface Member {
  name: string;
  role: MemberRole;
  model?: string;
  thinking?: string;
  /** Member-specific instructions from the team template or the orchestrator. */
  instructions?: string;
  status: string;
  statusAt: string;
  state: "starting" | "active" | "stopped";
  activity: Activity;
  activityAt?: string;
  runtime?: MemberRuntime;
  sessionFile?: string;
}

export interface Team {
  id: string;
  task: string;
  template?: string;
  cwd: string;
  worktree?: { path: string; branch: string; base?: string };
  state: "active" | "stopped";
  created: string;
  updated: string;
  members: Member[];
}

export interface Mail {
  id: number;
  at: string;
  /** null for the orchestrator's global mailbox (owner activity). */
  team: string | null;
  from: string;
  fromRole: string;
  to: string;
  text: string;
  urgent?: boolean;
  kind: "message" | "kickoff" | "system" | "owner";
  task?: string;
  deliveredAt?: string;
}

interface MemberRow {
  team: string;
  name: string;
  role: MemberRole;
  model: string | null;
  thinking: string | null;
  instructions: string | null;
  status: string;
  status_at: string;
  state: Member["state"];
  activity: Activity;
  activity_at: string | null;
  runtime: string | null;
  session_file: string | null;
}

interface MailRow {
  id: number;
  team: string | null;
  at: string;
  sender: string;
  sender_role: string;
  recipient: string;
  text: string;
  urgent: number;
  kind: Mail["kind"];
  task: string | null;
  delivered_at: string | null;
}

const toMail = (r: MailRow): Mail => ({
  id: r.id,
  at: r.at,
  team: r.team,
  from: r.sender,
  fromRole: r.sender_role,
  to: r.recipient,
  text: r.text,
  urgent: !!r.urgent,
  kind: r.kind,
  task: r.task ?? undefined,
  deliveredAt: r.delivered_at ?? undefined,
});

const toMember = (r: MemberRow): Member => ({
  name: r.name,
  role: r.role,
  model: r.model ?? undefined,
  thinking: r.thinking ?? undefined,
  instructions: r.instructions ?? undefined,
  status: r.status,
  statusAt: r.status_at,
  state: r.state,
  activity: r.activity,
  activityAt: r.activity_at ?? undefined,
  runtime: r.runtime ? (JSON.parse(r.runtime) as MemberRuntime) : undefined,
  sessionFile: r.session_file ?? undefined,
});

export class TeamBus {
  readonly genieDir: string;
  private db: Db;

  constructor(tracker: Tracker) {
    this.genieDir = tracker.dir;
    this.db = tracker.db;
  }

  exists(team: string): boolean {
    return !!this.db.get("SELECT 1 FROM teams WHERE id = ?", team);
  }

  get(team: string): Team {
    const t = this.db.get<{ id: string; task: string; template: string | null; cwd: string; worktree: string | null; state: Team["state"]; created: string; updated: string }>(
      "SELECT * FROM teams WHERE id = ?",
      team,
    );
    if (!t) throw new Error(`team ${team} not found`);
    return {
      id: t.id,
      task: t.task,
      template: t.template ?? undefined,
      cwd: t.cwd,
      worktree: t.worktree ? JSON.parse(t.worktree) : undefined,
      state: t.state,
      created: t.created,
      updated: t.updated,
      members: this.db.all<MemberRow>("SELECT * FROM members WHERE team = ? ORDER BY ord", team).map(toMember),
    };
  }

  list(opts: { includeStopped?: boolean } = {}): Team[] {
    return this.db
      .all<{ id: string }>(`SELECT id FROM teams ${opts.includeStopped ? "" : "WHERE state = 'active'"} ORDER BY created`)
      .map((r) => this.get(r.id));
  }

  /** Pick a free team id derived from the task id: G-7, G-7b, G-7c… */
  freeId(task: string): string {
    if (!this.exists(task)) return task;
    for (let c = 98; c < 123; c++) {
      const id = `${task}${String.fromCharCode(c)}`;
      if (!this.exists(id)) return id;
    }
    return `${task}-${Date.now().toString(36)}`;
  }

  create(team: { id: string; task: string; template?: string; cwd: string; worktree?: Team["worktree"]; members: Omit<Member, "activity">[] }): Team {
    this.db.tx(() => {
      if (this.exists(team.id)) throw new Error(`team ${team.id} already exists`);
      const at = now();
      this.db.run(
        "INSERT INTO teams(id, task, template, cwd, worktree, state, created, updated) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
        team.id,
        team.task,
        team.template ?? null,
        team.cwd,
        team.worktree ? JSON.stringify(team.worktree) : null,
        at,
        at,
      );
      team.members.forEach((m, i) => this.insertMember(team.id, m, i));
      this.log(team.id, { event: "team_created", members: team.members.map((m) => `${m.name}:${m.role}:${m.model ?? "default"}`) });
    });
    return this.get(team.id);
  }

  private insertMember(team: string, m: Omit<Member, "activity">, ord: number): void {
    this.db.run(
      `INSERT INTO members(team, name, role, model, thinking, instructions, status, status_at, state, activity, runtime, ord)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
      team,
      m.name,
      m.role,
      m.model ?? null,
      m.thinking ?? null,
      m.instructions ?? null,
      m.status,
      m.statusAt,
      m.state,
      m.runtime ? JSON.stringify(m.runtime) : null,
      ord,
    );
  }

  addMember(team: string, m: Omit<Member, "activity">): Team {
    this.db.tx(() => {
      if (this.db.get("SELECT 1 FROM members WHERE team = ? AND name = ?", team, m.name)) throw new Error(`team ${team} already has a member ${m.name}`);
      const ord = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE team = ?", team)?.n ?? 0;
      this.insertMember(team, m, ord);
      this.log(team, { event: "member_added", member: `${m.name}:${m.role}:${m.model ?? "default"}` });
    });
    return this.get(team);
  }

  setState(team: string, state: Team["state"]): void {
    this.db.tx(() => {
      this.db.run("UPDATE teams SET state = ?, updated = ? WHERE id = ?", state, now(), team);
      if (state === "stopped") this.db.run("UPDATE members SET state = 'stopped', activity = 'idle' WHERE team = ?", team);
    });
  }

  updateMember(team: string, member: string, patch: Partial<Pick<Member, "state" | "runtime" | "sessionFile" | "status">>): void {
    const cols: string[] = [];
    const vals: (string | null)[] = [];
    const set = (col: string, value: string | null) => {
      cols.push(`${col} = ?`);
      vals.push(value);
    };
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.runtime !== undefined) set("runtime", JSON.stringify(patch.runtime));
    if (patch.sessionFile !== undefined) set("session_file", patch.sessionFile ?? null);
    if (patch.status !== undefined) {
      set("status", patch.status);
      set("status_at", now());
    }
    if (!cols.length) return;
    const res = this.db.run(`UPDATE members SET ${cols.join(", ")} WHERE team = ? AND name = ?`, ...vals, team, member);
    if (!res.changes) throw new Error(`team ${team} has no member ${member}`);
    this.db.run("UPDATE teams SET updated = ? WHERE id = ?", now(), team);
  }

  setStatus(team: string, member: string, status: string): void {
    if (member === ORCHESTRATOR) return;
    this.updateMember(team, member, { status });
    this.log(team, { event: "status", member, status });
  }

  setActivity(team: string, member: string, activity: Activity): void {
    this.db.run("UPDATE members SET activity = ?, activity_at = ? WHERE team = ? AND name = ?", activity, now(), team, member);
  }

  /** Deliver a message. `to` is a member name, "orchestrator" or "all" (everyone except the sender). */
  send(input: { team: string; from: string; fromRole: string; to: string; text: string; urgent?: boolean; kind?: Mail["kind"] }): Mail[] {
    const team = this.get(input.team);
    const names = [...team.members.map((m) => m.name), ORCHESTRATOR];
    let recipients: string[];
    if (input.to === BROADCAST) {
      recipients = names.filter((n) => n !== input.from);
    } else {
      if (!names.includes(input.to)) throw new Error(`team ${team.id} has no member "${input.to}". Members: ${names.join(", ")}`);
      recipients = [input.to];
    }
    const ids = this.db.tx(() => {
      const at = now();
      const out = recipients.map(
        (to) =>
          this.db.run(
            "INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, kind, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            team.id,
            at,
            input.from,
            input.fromRole,
            to,
            input.text,
            input.urgent ? 1 : 0,
            input.kind ?? "message",
            team.task,
          ).lastInsertRowid,
      );
      this.log(team.id, { event: "mail", from: input.from, to: input.to, urgent: !!input.urgent, text: truncate(input.text, 500) });
      return out;
    });
    return ids.map((id) => toMail(this.db.get<MailRow>("SELECT * FROM mail WHERE id = ?", id)!));
  }

  /**
   * Take unread mail for a member, marking it delivered in the same transaction,
   * so concurrent pollers never deliver a message twice. For the orchestrator
   * (team omitted) this includes its global mailbox and every active team.
   */
  receive(team: string | undefined, member: string): Mail[] {
    return this.db.tx(() => {
      const rows =
        team === undefined
          ? this.db.all<MailRow>(
              "SELECT * FROM mail WHERE recipient = ? AND delivered_at IS NULL AND (team IS NULL OR team IN (SELECT id FROM teams WHERE state = 'active')) ORDER BY id",
              member,
            )
          : this.db.all<MailRow>("SELECT * FROM mail WHERE team = ? AND recipient = ? AND delivered_at IS NULL ORDER BY id", team, member);
      const at = now();
      for (const r of rows) this.db.run("UPDATE mail SET delivered_at = ? WHERE id = ?", at, r.id);
      return rows.map(toMail);
    });
  }

  pending(team: string, member: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mail WHERE team = ? AND recipient = ? AND delivered_at IS NULL", team, member)?.n ?? 0;
  }

  /** Messages of a team, newest last. */
  history(team: string, limit = 50): Mail[] {
    return this.db
      .all<MailRow>("SELECT * FROM (SELECT * FROM mail WHERE team = ? ORDER BY id DESC LIMIT ?) ORDER BY id", team, limit)
      .map(toMail);
  }

  log(team: string, entry: Record<string, unknown>): void {
    const { event, ...data } = entry;
    this.db.run("INSERT INTO log(team, at, event, data) VALUES (?, ?, ?, ?)", team, now(), String(event ?? "event"), JSON.stringify(data));
  }

  readLog(team: string, limit = 100): Record<string, unknown>[] {
    return this.db
      .all<{ at: string; event: string; data: string }>("SELECT * FROM (SELECT * FROM log WHERE team = ? ORDER BY id DESC LIMIT ?) ORDER BY id", team, limit)
      .map((r) => ({ at: r.at, event: r.event, ...(JSON.parse(r.data) as Record<string, unknown>) }));
  }

  /** Directory for process logs (stderr of headless members). */
  runtimeDir(team: string): string {
    const dir = path.join(this.genieDir, "runtime", team);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

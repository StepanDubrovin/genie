import * as fs from "node:fs";
import * as path from "node:path";
import { Db, migrate, SCHEMA, SCHEMA_VERSION } from "./db.ts";
import { excludeFromGit, findGenieDir, now } from "./fsutil.ts";
import {
  type Actor,
  ARTIFACT_KINDS,
  type ArtifactKind,
  canTransition,
  CLOSED,
  COMMENT_KINDS,
  WORKING,
  type CommentKind,
  doneProblems,
  type Gates,
  isPrivileged,
  readinessProblems,
  type Role,
  type Status,
  STATUSES,
  type Task,
  TASK_TYPES,
  type TaskSummary,
  type TaskType,
} from "./model.ts";

export const DB_FILE = "genie.db";
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface Meta {
  prefix: string;
  project: string;
  created: string;
}

export interface CreateInput {
  title: string;
  type?: TaskType;
  description?: string;
  acceptance?: string[];
  priority?: number;
  parent?: string;
  deps?: string[];
  labels?: string[];
  mergeStrategy?: string;
  /** Initial status: "inbox" for owner submissions, "draft" otherwise. */
  status?: "inbox" | "draft";
}

export interface UpdateInput {
  title?: string;
  type?: TaskType;
  description?: string;
  plan?: string;
  /** Appended to notes with a timestamp header. */
  appendNotes?: string;
  notes?: string;
  priority?: number;
  labels?: string[];
  assignees?: string[];
  mergeStrategy?: string;
  addAcceptance?: string[];
  removeAcceptance?: number[];
  addDeps?: string[];
  removeDeps?: string[];
  /** Move the task into an epic (id) or out of it (null). */
  parent?: string | null;
}

export interface ListFilter {
  type?: TaskType[];
  /** Hide epics (task lists and boards show epics separately). */
  excludeEpics?: boolean;
  status?: Status[];
  team?: string;
  parent?: string;
  label?: string;
  includeClosed?: boolean;
  search?: string;
}

export interface TrackerEvent {
  type: "status";
  task: { id: string; title: string };
  from: Status;
  to: Status;
  actor: Actor;
  note?: string;
}

export class GenieError extends Error {}

function deny(actor: Actor, what: string): never {
  throw new GenieError(`role "${actor.role}" (${actor.name}) is not allowed to ${what}`);
}

function requireRole(actor: Actor, what: string, roles: Role[]): void {
  if (isPrivileged(actor.role) || roles.includes(actor.role)) return;
  deny(actor, what);
}

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(v: unknown, fallback: T): T => (typeof v === "string" && v ? (JSON.parse(v) as T) : fallback);

interface TaskRow {
  id: string;
  seq: number;
  title: string;
  type: TaskType;
  status: Status;
  priority: number;
  description: string;
  plan: string;
  notes: string;
  parent: string | null;
  labels: string;
  assignees: string;
  team: string | null;
  worktree: string | null;
  blocked: string | null;
  needs_owner: string | null;
  merge_strategy: string;
  created: string;
  updated: string;
}

export class Tracker {
  readonly dir: string;
  readonly db: Db;
  gates: Gates = {};
  private listeners: ((e: TrackerEvent) => void)[] = [];

  constructor(dir: string) {
    this.dir = dir;
    this.db = new Db(path.join(dir, DB_FILE));
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  static init(dir: string, opts: { prefix?: string; project?: string } = {}): Tracker {
    fs.mkdirSync(dir, { recursive: true });
    const t = new Tracker(dir);
    t.db.tx(() => {
      const set = (k: string, v: string) => t.db.run("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", k, v);
      set("schema", String(SCHEMA_VERSION));
      set("prefix", (opts.prefix ?? "G").toUpperCase());
      set("project", opts.project ?? path.basename(path.dirname(dir)));
      set("created", now());
      set("next_seq", "1");
    });
    excludeFromGit(dir);
    return t;
  }

  static open(cwd: string): Tracker {
    const dir = findGenieDir(cwd);
    if (!dir) throw new GenieError(`no genie tracker found from ${cwd}; run \`genie init\` first`);
    return new Tracker(dir);
  }

  static tryOpen(cwd: string): Tracker | undefined {
    const dir = findGenieDir(cwd);
    return dir ? new Tracker(dir) : undefined;
  }

  get root(): string {
    return path.dirname(this.dir);
  }

  onEvent(fn: (e: TrackerEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: TrackerEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // listeners must not break writes
      }
    }
  }

  private metaValue(key: string): string {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? "";
  }

  meta(): Meta {
    return { prefix: this.metaValue("prefix"), project: this.metaValue("project"), created: this.metaValue("created") };
  }

  normalizeId(id: string): string {
    const raw = id.trim().toUpperCase();
    if (/^\d+$/.test(raw)) return `${this.metaValue("prefix")}-${raw}`;
    return raw;
  }

  exists(id: string): boolean {
    return !!this.db.get("SELECT 1 FROM tasks WHERE id = ?", this.normalizeId(id));
  }

  private row(id: string): TaskRow {
    const nid = this.normalizeId(id);
    const r = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", nid);
    if (!r) throw new GenieError(`task ${nid} not found`);
    return r;
  }

  get(id: string): Task {
    const r = this.row(id);
    const acceptance = this.db
      .all<{ n: number; text: string; done: number; checked_by: string | null; checked_at: string | null }>("SELECT * FROM acceptance WHERE task = ? ORDER BY n", r.id)
      .map((a) => ({ id: a.n, text: a.text, done: !!a.done, checkedBy: a.checked_by ?? undefined, checkedAt: a.checked_at ?? undefined }));
    const comments = this.db.all<Task["comments"][number]>("SELECT id, at, author, role, kind, text FROM comments WHERE task = ? ORDER BY id", r.id);
    const artifacts = this.db
      .all<{ n: number; at: string; author: string; role: Role; kind: ArtifactKind; name: string; size: number; note: string | null }>(
        "SELECT n, at, author, role, kind, name, size, note FROM artifacts WHERE task = ? ORDER BY n",
        r.id,
      )
      .map((a) => ({ id: a.n, at: a.at, author: a.author, role: a.role, kind: a.kind, name: a.name, size: a.size, note: a.note ?? undefined }));
    const history = this.db
      .all<{ at: string; actor: string; role: Role; event: string; from_status: string | null; to_status: string | null; note: string | null }>("SELECT * FROM history WHERE task = ? ORDER BY id", r.id)
      .map((h) => ({ at: h.at, actor: h.actor, role: h.role, event: h.event, from: h.from_status ?? undefined, to: h.to_status ?? undefined, note: h.note ?? undefined }));
    return {
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      priority: r.priority,
      description: r.description,
      acceptance,
      plan: r.plan,
      notes: r.notes,
      mergeStrategy: r.merge_strategy,
      parent: r.parent ?? undefined,
      children: this.db.all<{ id: string }>("SELECT id FROM tasks WHERE parent = ? ORDER BY seq", r.id).map((c) => c.id),
      deps: this.db.all<{ dep: string }>("SELECT dep FROM deps WHERE task = ? ORDER BY dep", r.id).map((d) => d.dep),
      labels: parse(r.labels, []),
      assignees: parse(r.assignees, []),
      team: r.team ?? undefined,
      worktree: parse(r.worktree, undefined),
      blocked: parse(r.blocked, undefined),
      needsOwner: parse(r.needs_owner, undefined),
      comments,
      artifacts,
      history,
      created: r.created,
      updated: r.updated,
    };
  }

  list(filter: ListFilter = {}): TaskSummary[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status?.length) {
      where.push(`t.status IN (${filter.status.map(() => "?").join(",")})`);
      params.push(...filter.status);
    } else if (!filter.includeClosed) {
      where.push("t.status NOT IN ('done', 'cancelled')");
    }
    if (filter.team) {
      where.push("t.team = ?");
      params.push(filter.team);
    }
    if (filter.type?.length) {
      where.push(`t.type IN (${filter.type.map(() => "?").join(",")})`);
      params.push(...filter.type);
    }
    if (filter.excludeEpics) where.push("t.type != 'epic'");
    if (filter.parent) {
      where.push("t.parent = ?");
      params.push(this.normalizeId(filter.parent));
    }
    if (filter.label) {
      where.push("EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?)");
      params.push(filter.label);
    }
    if (filter.search) {
      where.push("(t.title LIKE ? OR t.id LIKE ?)");
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    const rows = this.db.all<TaskRow & { ac_done: number; ac_total: number; children: number; children_closed: number; comments: number; artifacts: number; deps_all: string | null; deps_open: string | null }>(
      `SELECT t.*,
        (SELECT COUNT(*) FROM acceptance a WHERE a.task = t.id AND a.done = 1) AS ac_done,
        (SELECT COUNT(*) FROM acceptance a WHERE a.task = t.id) AS ac_total,
        (SELECT COUNT(*) FROM tasks c WHERE c.parent = t.id) AS children,
        (SELECT COUNT(*) FROM tasks c WHERE c.parent = t.id AND c.status IN ('done', 'cancelled')) AS children_closed,
        (SELECT COUNT(*) FROM comments c WHERE c.task = t.id) AS comments,
        (SELECT COUNT(*) FROM artifacts a WHERE a.task = t.id) AS artifacts,
        (SELECT group_concat(d.dep) FROM deps d WHERE d.task = t.id) AS deps_all,
        (SELECT group_concat(d.dep) FROM deps d JOIN tasks x ON x.id = d.dep WHERE d.task = t.id AND x.status != 'done') AS deps_open
       FROM tasks t ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.priority, t.seq`,
      ...params,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      priority: r.priority,
      parent: r.parent ?? undefined,
      labels: parse(r.labels, []),
      team: r.team ?? undefined,
      blocked: parse(r.blocked, undefined),
      needsOwner: parse(r.needs_owner, undefined),
      acceptanceDone: r.ac_done,
      acceptanceTotal: r.ac_total,
      deps: r.deps_all ? r.deps_all.split(",") : [],
      openDeps: r.deps_open ? r.deps_open.split(",") : [],
      children: r.children,
      childrenClosed: r.children_closed,
      comments: r.comments,
      artifacts: r.artifacts,
      created: r.created,
      updated: r.updated,
    }));
  }

  /** Ready tasks whose dependencies are done, not blocked and not yet taken by a team. */
  readyQueue(): TaskSummary[] {
    return this.list({ status: ["ready"] }).filter((t) => !t.blocked && !t.team && t.openDeps.length === 0);
  }

  private history(task: string, actor: Actor, event: string, extra: { from?: string; to?: string; note?: string } = {}): void {
    this.db.run(
      "INSERT INTO history(task, at, actor, role, event, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      task,
      now(),
      actor.name,
      actor.role,
      event,
      extra.from ?? null,
      extra.to ?? null,
      extra.note ?? null,
    );
  }

  private touch(task: string): void {
    this.db.run("UPDATE tasks SET updated = ? WHERE id = ?", now(), task);
  }

  /** Owner activity wakes the orchestrator through its global mailbox. */
  /**
   * Keep an epic in step with its tasks: the first task a team works on starts the
   * epic; when every task is closed the orchestrator is asked to close the epic.
   */
  private followEpic(epicId: string, childId: string, childStatus: Status): void {
    const epic = this.db.get<{ id: string; type: TaskType; status: Status }>("SELECT id, type, status FROM tasks WHERE id = ?", epicId);
    if (!epic || epic.type !== "epic") return;
    const system: Actor = { name: "genie", role: "orchestrator" };
    if (WORKING.includes(childStatus) && ["draft", "refining", "ready"].includes(epic.status)) {
      this.db.tx(() => {
        this.db.run("UPDATE tasks SET status = 'in_progress', updated = ? WHERE id = ?", now(), epic.id);
        this.history(epic.id, system, "status", { from: epic.status, to: "in_progress", note: `work started on ${childId}` });
      });
    }
    if (CLOSED.includes(childStatus) && !CLOSED.includes(epic.status)) {
      const open = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE parent = ? AND status NOT IN ('done', 'cancelled')", epic.id)?.n ?? 0;
      if (open === 0) {
        this.db.run(
          "INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, kind, task) VALUES (NULL, ?, 'genie', 'system', 'orchestrator', ?, 0, 'system', ?)",
          now(),
          `All tasks of epic ${epic.id} are closed. Check the epic's success criteria and artifacts, then close it (done) or add the missing tasks.`,
          epic.id,
        );
      }
    }
  }

  /** Epic of a task plus the epic's tasks, for rendering context. */
  epicContext(id: string): { epic?: Task; children?: TaskSummary[] } {
    const t = this.row(id);
    if (t.type === "epic") return { children: this.list({ parent: t.id, includeClosed: true }) };
    const epic = this.epicOf(t.id);
    return epic ? { epic: this.get(epic) } : {};
  }

  /** The epic a task belongs to (directly or through its parent task), if any. */
  epicOf(id: string): string | undefined {
    let cur = this.db.get<{ parent: string | null }>("SELECT parent FROM tasks WHERE id = ?", this.normalizeId(id))?.parent;
    for (let depth = 0; cur && depth < 10; depth++) {
      const r = this.db.get<{ type: TaskType; parent: string | null }>("SELECT type, parent FROM tasks WHERE id = ?", cur);
      if (!r) return undefined;
      if (r.type === "epic") return cur;
      cur = r.parent;
    }
    return undefined;
  }

  private tellOrchestrator(actor: Actor, task: string, text: string): void {
    if (actor.role !== "human") return;
    this.db.run(
      "INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, kind, task) VALUES (NULL, ?, ?, 'human', 'orchestrator', ?, 0, 'owner', ?)",
      now(),
      actor.name,
      text,
      task,
    );
  }

  create(actor: Actor, input: CreateInput): Task {
    requireRole(actor, "create tasks", ["analyst"]);
    if (!input.title?.trim()) throw new GenieError("title is required");
    const type = input.type ?? "task";
    if (!TASK_TYPES.includes(type)) throw new GenieError(`unknown type ${type}`);
    const status: Status = input.status === "inbox" ? "inbox" : "draft";
    const id = this.db.tx(() => {
      const parent = input.parent ? this.normalizeId(input.parent) : null;
      if (parent && !this.exists(parent)) throw new GenieError(`parent ${parent} not found`);
      if (parent && type === "epic") throw new GenieError("epics cannot be nested");
      const deps = (input.deps ?? []).map((d) => this.normalizeId(d));
      for (const d of deps) if (!this.exists(d)) throw new GenieError(`dependency ${d} not found`);
      const seq = Number(this.metaValue("next_seq"));
      this.db.run("UPDATE meta SET value = ? WHERE key = 'next_seq'", String(seq + 1));
      const tid = `${this.metaValue("prefix")}-${seq}`;
      const at = now();
      this.db.run(
        `INSERT INTO tasks(id, seq, title, type, status, priority, description, parent, labels, merge_strategy, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tid,
        seq,
        input.title.trim(),
        type,
        status,
        clampPriority(input.priority ?? 2),
        input.description ?? "",
        parent,
        json(input.labels ?? []),
        input.mergeStrategy ?? "",
        at,
        at,
      );
      (input.acceptance ?? []).forEach((text, i) => this.db.run("INSERT INTO acceptance(task, n, text) VALUES (?, ?, ?)", tid, i + 1, text));
      for (const d of deps) this.db.run("INSERT INTO deps(task, dep) VALUES (?, ?)", tid, d);
      this.history(tid, actor, "created", { to: status });
      if (parent) {
        this.history(parent, actor, `child ${tid} added`);
        this.touch(parent);
      }
      this.tellOrchestrator(actor, tid, `New task ${tid} in the inbox from the owner: ${input.title.trim()}`);
      return tid;
    });
    return this.get(id);
  }

  update(actor: Actor, id: string, input: UpdateInput): Task {
    const r = this.row(id);
    const changed: string[] = [];
    const scope = (fields: string, roles: Role[]) => requireRole(actor, `change ${fields}`, roles);
    this.db.tx(() => {
      const set = (col: string, value: string | number, name: string) => {
        this.db.run(`UPDATE tasks SET ${col} = ? WHERE id = ?`, value, r.id);
        changed.push(name);
      };
      if (input.title !== undefined) {
        scope("title", ["analyst"]);
        set("title", input.title, "title");
      }
      if (input.type !== undefined) {
        scope("type", ["analyst"]);
        if (!TASK_TYPES.includes(input.type)) throw new GenieError(`unknown type ${input.type}`);
        if (input.type === "epic" && r.parent && input.parent !== null) throw new GenieError(`${r.id} is inside ${r.parent}; epics cannot be nested`);
        set("type", input.type, "type");
      }
      if (input.description !== undefined) {
        scope("description", ["analyst"]);
        set("description", input.description, "description");
      }
      if (input.priority !== undefined) {
        scope("priority", []);
        set("priority", clampPriority(input.priority), "priority");
      }
      if (input.mergeStrategy !== undefined) {
        scope("merge strategy", []);
        set("merge_strategy", input.mergeStrategy, "merge strategy");
      }
      if (input.plan !== undefined) {
        scope("plan", ["analyst", "executor"]);
        set("plan", input.plan, "plan");
      }
      if (input.notes !== undefined) set("notes", input.notes, "notes");
      if (input.appendNotes) {
        const cur = this.row(r.id).notes;
        set("notes", `${cur ? `${cur.trimEnd()}\n\n` : ""}### ${now()} — ${actor.name} (${actor.role})\n\n${input.appendNotes.trim()}\n`, "notes");
      }
      if (input.labels !== undefined) set("labels", json(input.labels), "labels");
      if (input.assignees !== undefined) {
        scope("assignees", []);
        set("assignees", json(input.assignees), "assignees");
      }
      if (input.addAcceptance?.length) {
        scope("acceptance criteria", ["analyst"]);
        let next = (this.db.get<{ m: number }>("SELECT COALESCE(MAX(n), 0) AS m FROM acceptance WHERE task = ?", r.id)?.m ?? 0) + 1;
        for (const text of input.addAcceptance) this.db.run("INSERT INTO acceptance(task, n, text) VALUES (?, ?, ?)", r.id, next++, text);
        changed.push("acceptance");
      }
      if (input.removeAcceptance?.length) {
        scope("acceptance criteria", ["analyst"]);
        for (const n of input.removeAcceptance) this.db.run("DELETE FROM acceptance WHERE task = ? AND n = ?", r.id, n);
        changed.push("acceptance");
      }
      if (input.parent !== undefined) {
        scope("epic", ["analyst"]);
        const target = input.parent === null ? null : this.normalizeId(input.parent);
        if (target !== r.parent) {
          if (target) {
            const epic = this.db.get<{ id: string; type: TaskType }>("SELECT id, type FROM tasks WHERE id = ?", target);
            if (!epic) throw new GenieError(`epic ${target} not found`);
            if (epic.type !== "epic") throw new GenieError(`${target} is not an epic (type ${epic.type})`);
            if (target === r.id) throw new GenieError("a task cannot be its own epic");
            if (r.type === "epic") throw new GenieError("epics cannot be nested");
          }
          if (r.parent) this.history(r.parent, actor, `child ${r.id} moved out`);
          if (target) this.history(target, actor, `child ${r.id} moved in`);
          this.db.run("UPDATE tasks SET parent = ? WHERE id = ?", target, r.id);
          changed.push(target ? `epic → ${target}` : "epic removed");
        }
      }
      if (input.addDeps?.length || input.removeDeps?.length) {
        scope("dependencies", ["analyst"]);
        for (const raw of input.addDeps ?? []) {
          const d = this.normalizeId(raw);
          if (!this.exists(d)) throw new GenieError(`dependency ${d} not found`);
          if (d === r.id) throw new GenieError("a task cannot depend on itself");
          this.db.run("INSERT OR IGNORE INTO deps(task, dep) VALUES (?, ?)", r.id, d);
        }
        for (const raw of input.removeDeps ?? []) this.db.run("DELETE FROM deps WHERE task = ? AND dep = ?", r.id, this.normalizeId(raw));
        changed.push("deps");
      }
      if (!changed.length) throw new GenieError("nothing to update");
      this.history(r.id, actor, `updated ${[...new Set(changed)].join(", ")}`);
      this.touch(r.id);
    });
    return this.get(r.id);
  }

  setStatus(actor: Actor, id: string, to: Status, opts: { note?: string; force?: boolean } = {}): Task {
    if (!STATUSES.includes(to)) throw new GenieError(`unknown status ${to}`);
    const task = this.get(id);
    const from = task.status;
    if (from === to) throw new GenieError(`${task.id} is already ${to}`);
    if (!canTransition(actor.role, from, to) && !(opts.force && isPrivileged(actor.role) && to !== "inbox")) {
      deny(actor, `move ${task.id} from ${from} to ${to}${actor.role === "orchestrator" ? " (review/approved are the team's verdicts; pass force only if the team cannot)" : ""}`);
    }
    if (opts.force && !isPrivileged(actor.role)) deny(actor, "force status changes");
    if (to === "needs_owner" && !opts.note?.trim()) throw new GenieError("needs_owner requires a note with the question for the owner");
    if (!opts.force) {
      if (to === "ready") {
        const known = new Map(task.deps.filter((d) => this.exists(d)).map((d) => [d, { status: this.row(d).status }]));
        const p = readinessProblems(task, known);
        if (p.length) throw new GenieError(`${task.id} is not ready: ${p.join("; ")} (use force to override)`);
      }
      if (to === "done") {
        const children = this.db.all<{ status: Status }>("SELECT status FROM tasks WHERE parent = ?", task.id).map((c) => c.status);
        const p = doneProblems(task, children);
        if (p.length) throw new GenieError(`${task.id} cannot be closed: ${p.join("; ")} (use force to override)`);
      }
      if (to === "in_progress") {
        const open = this.list({ status: undefined, includeClosed: true }).find((t) => t.id === task.id)?.openDeps ?? [];
        if (open.length) throw new GenieError(`${task.id} depends on unfinished tasks: ${open.join(", ")}`);
      }
      if (to === "review" && this.gates.requireTestReport && !task.artifacts.some((a) => a.kind === "test-report")) {
        throw new GenieError(`${task.id}: attach a test-report artifact before review`);
      }
      if (to === "approved" && this.gates.requireReviewArtifact && !task.artifacts.some((a) => a.kind === "review")) {
        throw new GenieError(`${task.id}: attach a review artifact before approving`);
      }
    }
    this.db.tx(() => {
      const at = now();
      const needsOwner = to === "needs_owner" ? json({ question: opts.note!.trim(), by: actor.name, at, previous: from }) : null;
      const blocked = CLOSED.includes(to) ? null : (this.row(task.id).blocked ?? null);
      this.db.run("UPDATE tasks SET status = ?, needs_owner = ?, blocked = ?, updated = ? WHERE id = ?", to, needsOwner, blocked, at, task.id);
      this.history(task.id, actor, "status", { from, to, note: opts.note });
      if (opts.note && to !== "needs_owner") {
        const kind: CommentKind = to === "changes_requested" || to === "approved" ? "review" : "progress";
        this.db.run("INSERT INTO comments(task, at, author, role, kind, text) VALUES (?, ?, ?, ?, ?, ?)", task.id, at, actor.name, actor.role, kind, `[${from} → ${to}] ${opts.note}`);
      }
      if (to === "needs_owner") {
        this.db.run("INSERT INTO comments(task, at, author, role, kind, text) VALUES (?, ?, ?, ?, 'question', ?)", task.id, at, actor.name, actor.role, `Needs owner decision: ${opts.note!.trim()}`);
      }
      this.tellOrchestrator(actor, task.id, `The owner moved ${task.id} from ${from} to ${to}${opts.note ? `: ${opts.note}` : ""}`);
    });
    this.emit({ type: "status", task: { id: task.id, title: task.title }, from, to, actor, note: opts.note });
    if (task.parent) this.followEpic(task.parent, task.id, to);
    return this.get(task.id);
  }

  comment(actor: Actor, id: string, text: string, kind: CommentKind = "note"): Task {
    if (!COMMENT_KINDS.includes(kind)) throw new GenieError(`unknown comment kind ${kind}`);
    if (!text.trim()) throw new GenieError("comment text is empty");
    const r = this.row(id);
    const effectiveKind: CommentKind = actor.role === "human" && kind === "note" ? "owner" : kind;
    this.db.tx(() => {
      this.db.run("INSERT INTO comments(task, at, author, role, kind, text) VALUES (?, ?, ?, ?, ?, ?)", r.id, now(), actor.name, actor.role, effectiveKind, text.trim());
      this.touch(r.id);
      const waiting = r.status === "needs_owner" ? " (the task is waiting for this decision)" : "";
      this.tellOrchestrator(actor, r.id, `The owner commented on ${r.id}${waiting}: ${text.trim()}`);
    });
    return this.get(r.id);
  }

  check(actor: Actor, id: string, criterion: number, done = true): Task {
    requireRole(actor, "check acceptance criteria", ["reviewer"]);
    const r = this.row(id);
    this.db.tx(() => {
      const res = this.db.run("UPDATE acceptance SET done = ?, checked_by = ?, checked_at = ? WHERE task = ? AND n = ?", done ? 1 : 0, done ? actor.name : null, done ? now() : null, r.id, criterion);
      if (!res.changes) throw new GenieError(`${r.id} has no acceptance criterion #${criterion}`);
      this.history(r.id, actor, `acceptance #${criterion} ${done ? "checked" : "unchecked"}`);
      this.touch(r.id);
    });
    return this.get(r.id);
  }

  /** Attach an artifact: the content lives in the database, not in files agents might read by accident. */
  addArtifact(actor: Actor, id: string, input: { kind?: ArtifactKind; file?: string; content?: string; name?: string; note?: string }): Task {
    const kind = input.kind ?? "other";
    if (!ARTIFACT_KINDS.includes(kind)) throw new GenieError(`unknown artifact kind ${kind}`);
    const r = this.row(id);
    let data: Uint8Array;
    let name: string;
    if (input.file) {
      if (!fs.existsSync(input.file)) throw new GenieError(`file ${input.file} not found`);
      data = new Uint8Array(fs.readFileSync(input.file));
      name = input.name ?? path.basename(input.file);
    } else if (input.content !== undefined) {
      data = new TextEncoder().encode(input.content);
      name = input.name ?? `${kind}.md`;
    } else {
      throw new GenieError("artifact needs either file or content");
    }
    if (data.byteLength > MAX_ARTIFACT_BYTES) throw new GenieError(`artifact is larger than ${MAX_ARTIFACT_BYTES} bytes`);
    this.db.tx(() => {
      const n = (this.db.get<{ m: number }>("SELECT COALESCE(MAX(n), 0) AS m FROM artifacts WHERE task = ?", r.id)?.m ?? 0) + 1;
      this.db.run(
        "INSERT INTO artifacts(task, n, at, author, role, kind, name, note, size, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        r.id,
        n,
        now(),
        actor.name,
        actor.role,
        kind,
        sanitize(name),
        input.note ?? null,
        data.byteLength,
        data,
      );
      this.history(r.id, actor, `artifact #${n} ${sanitize(name)} (${kind}) added`);
      this.touch(r.id);
    });
    return this.get(r.id);
  }

  readArtifact(id: string, n: number): { name: string; kind: ArtifactKind; content: Uint8Array; text: string | undefined } {
    const r = this.row(id);
    const a = this.db.get<{ name: string; kind: ArtifactKind; content: Uint8Array }>("SELECT name, kind, content FROM artifacts WHERE task = ? AND n = ?", r.id, n);
    if (!a) throw new GenieError(`${r.id} has no artifact #${n}`);
    const content = a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content as ArrayBuffer);
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      text = undefined;
    }
    return { name: a.name, kind: a.kind, content, text };
  }

  /**
   * Slice a task into atomic children. The parent becomes an epic — unless it already
   * belongs to an epic (epics are not nested): then the pieces join that epic and the
   * split task is cancelled.
   */
  split(actor: Actor, id: string, children: CreateInput[]): Task[] {
    requireRole(actor, "split tasks", []);
    const parent = this.get(id);
    const epic = parent.type === "epic" ? undefined : this.epicOf(parent.id);
    if (epic) {
      if (parent.team || WORKING.includes(parent.status)) throw new GenieError(`${parent.id} is being worked on; stop its team before splitting it`);
      return this.db.tx(() => {
        const out = children.map((c) => this.create(actor, { ...c, status: undefined, parent: epic, labels: c.labels ?? parent.labels }));
        const ids = out.map((c) => c.id).join(", ");
        this.db.run("UPDATE tasks SET status = 'cancelled', updated = ? WHERE id = ?", now(), parent.id);
        this.history(parent.id, actor, "status", { from: parent.status, to: "cancelled", note: `split into ${ids}` });
        this.history(epic, actor, `${parent.id} split into ${ids}`);
        return out;
      });
    }
    const created = this.db.tx(() => {
      const out = children.map((c) => this.create(actor, { ...c, status: undefined, parent: parent.id, labels: c.labels ?? parent.labels }));
      this.db.run("UPDATE tasks SET type = 'epic' WHERE id = ?", parent.id);
      this.history(parent.id, actor, `split into ${out.map((c) => c.id).join(", ")}`);
      return out;
    });
    return created;
  }

  block(actor: Actor, id: string, reason: string): Task {
    const r = this.row(id);
    this.db.tx(() => {
      this.db.run("UPDATE tasks SET blocked = ? WHERE id = ?", json({ reason, by: actor.name, at: now() }), r.id);
      this.history(r.id, actor, `blocked: ${reason}`);
      this.touch(r.id);
    });
    return this.get(r.id);
  }

  unblock(actor: Actor, id: string): Task {
    const r = this.row(id);
    this.db.tx(() => {
      this.db.run("UPDATE tasks SET blocked = NULL WHERE id = ?", r.id);
      this.history(r.id, actor, "unblocked");
      this.touch(r.id);
    });
    return this.get(r.id);
  }

  assignTeam(actor: Actor, id: string, team: string | undefined, worktree?: { path: string; branch?: string }, assignees?: string[]): Task {
    requireRole(actor, "assign teams", []);
    const r = this.row(id);
    this.db.tx(() => {
      this.db.run("UPDATE tasks SET team = ? WHERE id = ?", team ?? null, r.id);
      if (worktree) this.db.run("UPDATE tasks SET worktree = ? WHERE id = ?", json(worktree), r.id);
      if (assignees) this.db.run("UPDATE tasks SET assignees = ? WHERE id = ?", json(assignees), r.id);
      this.history(r.id, actor, team ? `assigned to team ${team}` : "team released");
      this.touch(r.id);
    });
    return this.get(r.id);
  }

  /** Counts per status, for sidebars and status lines. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ status: string; c: number }>("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status")) out[r.status] = r.c;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function clampPriority(p: number): number {
  return Math.min(4, Math.max(0, Math.round(p)));
}

function sanitize(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_");
}

// Task model and workflow rules shared by the CLI, the pi extension and the web UI.

export const STATUSES = [
  "inbox", // submitted by the owner (web/CLI); the orchestrator has not taken it yet
  "draft", // taken by the orchestrator, not analysed yet
  "refining", // orchestrator/analysts clarify scope and acceptance criteria
  "ready", // Definition of Ready met; can be handed to a team
  "in_progress", // a team is working on it
  "review", // executor submitted the result for review
  "changes_requested", // reviewer/tester sent it back
  "approved", // reviewer approved; waits for orchestrator acceptance
  "needs_owner", // stuck on a decision only the owner (human) can make
  "done", // accepted and closed by the orchestrator
  "cancelled",
] as const;
export type Status = (typeof STATUSES)[number];

export const CLOSED: Status[] = ["done", "cancelled"];

export const MEMBER_ROLES = ["analyst", "executor", "reviewer", "tester", "documenter"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ROLES = ["human", "orchestrator", ...MEMBER_ROLES] as const;
export type Role = (typeof ROLES)[number];

export const TASK_TYPES = ["epic", "task", "bug", "spike"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const COMMENT_KINDS = ["note", "progress", "question", "decision", "review", "handoff", "owner"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const ARTIFACT_KINDS = ["analysis", "plan", "code", "review", "test-report", "diff", "doc", "log", "other"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Actor {
  name: string;
  role: Role;
}

export interface AcceptanceCriterion {
  id: number;
  text: string;
  done: boolean;
  checkedBy?: string;
  checkedAt?: string;
}

export interface Comment {
  id: number;
  at: string;
  author: string;
  role: Role;
  kind: CommentKind;
  text: string;
}

export interface Artifact {
  /** Per-task number (#1, #2…). */
  id: number;
  at: string;
  author: string;
  role: Role;
  kind: ArtifactKind;
  name: string;
  size: number;
  note?: string;
}

export interface HistoryEntry {
  at: string;
  actor: string;
  role: Role;
  event: string;
  from?: string;
  to?: string;
  note?: string;
}

export interface NeedsOwner {
  question: string;
  by: string;
  at: string;
  /** Status to return to once the owner has answered. */
  previous: Status;
}

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  status: Status;
  /** 0 = urgent … 4 = low */
  priority: number;
  description: string;
  acceptance: AcceptanceCriterion[];
  /** Implementation plan (markdown), usually written by the analyst. */
  plan: string;
  /** Running implementation notes / final summary (markdown). */
  notes: string;
  /** How the result gets integrated (merge by orchestrator, PR, manual transfer to SAP…), agreed before dispatch. */
  mergeStrategy: string;
  parent?: string;
  children: string[];
  /** Tasks that must be done before this one can start. */
  deps: string[];
  labels: string[];
  assignees: string[];
  team?: string;
  worktree?: { path: string; branch?: string };
  blocked?: { reason: string; by: string; at: string };
  needsOwner?: NeedsOwner;
  comments: Comment[];
  artifacts: Artifact[];
  history: HistoryEntry[];
  created: string;
  updated: string;
}

/** Lightweight row for lists and boards. */
export interface TaskSummary {
  id: string;
  title: string;
  type: TaskType;
  status: Status;
  priority: number;
  parent?: string;
  labels: string[];
  team?: string;
  blocked?: { reason: string; by: string; at: string };
  needsOwner?: NeedsOwner;
  acceptanceDone: number;
  acceptanceTotal: number;
  deps: string[];
  openDeps: string[];
  children: number;
  comments: number;
  created: string;
  updated: string;
}

interface TransitionRule {
  from: Status | "*";
  to: Status;
  roles: Role[];
}

// "human" may do anything; "orchestrator" anything except the team's verdicts (see canTransition).
const TRANSITIONS: TransitionRule[] = [
  { from: "draft", to: "refining", roles: ["analyst"] },
  { from: "ready", to: "in_progress", roles: ["executor", "analyst"] },
  { from: "changes_requested", to: "in_progress", roles: ["executor"] },
  { from: "in_progress", to: "review", roles: ["executor"] },
  { from: "review", to: "changes_requested", roles: ["reviewer", "tester"] },
  { from: "review", to: "approved", roles: ["reviewer"] },
];

/** Transitions that only the orchestrator (or the human) may make. */
export const ORCHESTRATOR_ONLY: Status[] = ["draft", "ready", "needs_owner", "done", "cancelled"];

/** Team verdicts the orchestrator must not fake: it needs `force` to set them itself. */
export const TEAM_ONLY: Status[] = ["review", "approved"];

export function isPrivileged(role: Role): boolean {
  return role === "human" || role === "orchestrator";
}

export function canTransition(role: Role, from: Status, to: Status): boolean {
  if (from === to) return false;
  if (role === "human") return true;
  if (to === "inbox") return false;
  if (role === "orchestrator") return !TEAM_ONLY.includes(to);
  if (ORCHESTRATOR_ONLY.includes(to)) return false;
  return TRANSITIONS.some((t) => (t.from === "*" || t.from === from) && t.to === to && t.roles.includes(role));
}

export function allowedTransitions(role: Role, from: Status): Status[] {
  return STATUSES.filter((to) => canTransition(role, from, to));
}

/** Definition of Ready: problems that prevent moving a task to `ready`. */
export function readinessProblems(task: Task, all: Map<string, { status: Status }>): string[] {
  const problems: string[] = [];
  if (!task.description.trim()) problems.push("description is empty");
  if (task.acceptance.length === 0) problems.push("no acceptance criteria");
  if (task.type === "epic") problems.push("epics are not handed to teams; split it into tasks");
  for (const dep of task.deps) if (!all.has(dep)) problems.push(`dependency ${dep} does not exist`);
  return problems;
}

export interface Gates {
  /** Require a test-report artifact before in_progress → review. */
  requireTestReport?: boolean;
  /** Require a review artifact before review → approved. */
  requireReviewArtifact?: boolean;
}

/** Definition of Done: problems that prevent moving a task to `done`. */
export function doneProblems(task: Task, childStatuses: Status[]): string[] {
  const problems: string[] = [];
  const open = task.acceptance.filter((a) => !a.done);
  if (open.length) problems.push(`unchecked acceptance criteria: ${open.map((a) => `#${a.id}`).join(", ")}`);
  if (task.type === "epic") {
    const unfinished = childStatuses.filter((s) => !CLOSED.includes(s)).length;
    if (unfinished) problems.push(`${unfinished} unfinished child task(s)`);
  } else if (task.status !== "approved") {
    problems.push(`status is ${task.status}; a reviewer must approve it first`);
  }
  return problems;
}

export function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v);
}
export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}
export function isMemberRole(v: string): v is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(v);
}

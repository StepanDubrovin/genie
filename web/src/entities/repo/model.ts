// Repositories of a project: where they live, what agents may do in them, how a task's delivery stands.

export type PushMode = "none" | "pr_only" | "branches" | "direct";
export type MergeMode = "human" | "agent_after_approval" | "auto";

/** The repository's policy as stored; every field is optional (the defaults fill the rest). */
export interface RepoPolicy {
  read?: boolean;
  push?: PushMode;
  branch?: string;
  branches?: string[];
  protected?: string[];
  force_push?: boolean;
  delete_branches?: boolean;
  change_request?: { open?: boolean; base?: string[]; merge?: MergeMode; method?: string | null; require_ci?: boolean; approvals?: number };
}

export interface RepoHost {
  id: string;
  kind?: string;
  url?: string;
  webUrl?: string;
  problems?: string[];
  error?: string;
}

export interface ProjectRepo {
  project: string;
  name: string;
  host: RepoHost;
  remote: string;
  mount: string;
  defaultBranch: string;
  access: "read" | "write";
  policy: RepoPolicy;
  policyValid: boolean;
  created: string;
}

/** A host of `git.json` as the server describes it (never a secret). */
export interface GitHostInfo {
  id: string;
  kind: string;
  url: string;
  apiUrl?: string;
  transport: string;
  hasToken: boolean;
  problems: string[];
}

export interface CheckLine {
  level: "ok" | "warn" | "fail";
  text: string;
}

export interface Preset {
  id: string;
  name: string;
  hint: string;
  policy: RepoPolicy;
  /** Shown in red: this loosens what protects the default branch. */
  risky?: boolean;
}

/** The usual policies, so that nobody writes JSON to get the common cases. */
export const PRESETS: Preset[] = [
  { id: "read", name: "Только чтение", hint: "агенты читают код и ничего не публикуют", policy: { push: "none" } },
  {
    id: "pr-human",
    name: "Запрос на слияние, сливает человек",
    hint: "агент пушит только в ветку своей задачи и открывает PR/MR; сливает человек",
    policy: {},
  },
  {
    id: "pr-agent",
    name: "Запрос на слияние, после ревью сливает агент",
    hint: "слияние — после одобрения задачи ревьюером, зелёных проверок и одобрений на хостинге",
    policy: { change_request: { merge: "agent_after_approval" } },
  },
  {
    id: "pr-auto",
    name: "Запрос на слияние, сервер сливает сам",
    hint: "сервер сливает, когда задача одобрена и условия хостинга выполнены",
    policy: { change_request: { merge: "auto" } },
  },
  {
    id: "direct",
    name: "Прямой push в ветки",
    hint: "агент пушит в ветку задачи без обязательного PR/MR; защищённые ветки остаются защищёнными",
    policy: { push: "branches" },
  },
  {
    id: "direct-main",
    name: "Прямой push, в том числе в основную ветку",
    hint: "снимает защиту основной ветки на стороне genie — включайте, только если так задумано",
    policy: { push: "direct", protected: [] },
    risky: true,
  },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which preset a stored policy is exactly (`custom` when it is none of them). */
export function presetOf(policy: RepoPolicy | undefined): string {
  const p = policy ?? {};
  return PRESETS.find((x) => same(x.policy, p))?.id ?? "custom";
}

export function presetName(id: string): string {
  return PRESETS.find((p) => p.id === id)?.name ?? "Своя политика (JSON)";
}

/** A task's delivery in one repository (`task_repos`). */
export interface TaskRepo {
  project: string;
  task: string;
  repo: string;
  access: "read" | "write";
  branch: string;
  state: "pending" | "published" | "merged" | "abandoned";
  crNumber?: number | null;
  crUrl?: string | null;
  crState?: "open" | "merged" | "closed" | null;
  ciState?: "none" | "pending" | "passed" | "failed" | null;
  headSha?: string | null;
  updated: string;
}

export const CI_NAME: Record<string, string> = { none: "проверок нет", pending: "проверки идут", passed: "проверки прошли", failed: "проверки упали" };
export const CR_NAME: Record<string, string> = { open: "открыт", merged: "слит", closed: "закрыт без слияния" };

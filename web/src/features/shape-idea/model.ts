// An idea shaped with a planner agent: the plan it keeps in `plan.json` and
// what the person files from it. The server checks the plan again on apply.

/** The label of a task that is still an idea (the server's `IDEA_LABEL`). */
export const IDEA_LABEL = "идея";
/** The planner's team template. */
export const IDEA_TEMPLATE = "idea";
/** The artifact the planner keeps its proposal in. */
export const PLAN_ARTIFACT = "plan.json";

export interface PlanEpic {
  title: string;
  goal: string;
  criteria: string[];
  roadmap?: string;
}

export interface PlanTask {
  key: string;
  title: string;
  type: "task" | "bug" | "spike";
  description: string;
  criteria: string[];
  deps: string[];
}

export interface IdeaPlan {
  summary?: string;
  epic?: PlanEpic;
  tasks: PlanTask[];
  assumptions: string[];
  questions: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : []);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const TYPES = new Set(["task", "bug", "spike"]);

/**
 * The planner's `plan.json`, read leniently: a Markdown fence around the JSON,
 * missing keys or extra fields do not hide the plan. `undefined` when there is
 * no usable plan (not JSON, or no task with a title).
 */
export function parsePlan(raw: string | undefined): IdeaPlan | undefined {
  if (!raw) return undefined;
  const body = raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object") return undefined;
  const tasks: PlanTask[] = (Array.isArray(v.tasks) ? v.tasks : [])
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t, i) => ({
      key: text(t.key) || `t${i + 1}`,
      title: text(t.title),
      type: (TYPES.has(text(t.type)) ? text(t.type) : "task") as PlanTask["type"],
      description: text(t.description),
      criteria: strings(t.criteria),
      deps: strings(t.deps),
    }))
    .filter((t) => t.title);
  if (!tasks.length) return undefined;
  const e = v.epic as Record<string, unknown> | null | undefined;
  const epic = e && typeof e === "object" && text(e.title) ? { title: text(e.title), goal: text(e.goal), criteria: strings(e.criteria), roadmap: text(e.roadmap) || undefined } : undefined;
  return { summary: text(v.summary) || undefined, epic, tasks, assumptions: strings(v.assumptions), questions: strings(v.questions) };
}

/**
 * What goes to the server: the plan without the tasks the person unticked.
 * Dependencies on an unticked task are dropped with it. Without an epic the
 * first remaining task is the idea itself.
 */
export function planToApply(plan: IdeaPlan, off: ReadonlySet<string>): Omit<IdeaPlan, "assumptions" | "questions"> {
  const tasks = plan.tasks.filter((t) => !off.has(t.key)).map((t) => ({ ...t, deps: t.deps.filter((d) => !off.has(d)) }));
  return { summary: plan.summary, epic: plan.epic, tasks };
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** The apply button: «Завести эпик и 3 задачи», «Завести 2 задачи», «Завести задачу». */
export function applyLabel(epic: boolean, n: number): string {
  const tasks = `${n} ${plural(n, "задачу", "задачи", "задач")}`;
  if (epic) return n ? `Завести эпик и ${tasks}` : "Завести эпик";
  return n === 1 ? "Завести задачу" : `Завести ${tasks}`;
}

/** Index of the task (1-based) a dependency key points to, for «после 2». */
export function depLabel(plan: IdeaPlan, key: string): string {
  const i = plan.tasks.findIndex((t) => t.key === key);
  return i >= 0 ? String(i + 1) : key;
}

// Configuration and role definitions.
//
// Merge order (later wins):
//   <package>/config/default.json → ~/.pi/agent/genie/config.json → <.genie>/config.json
// Role prompts (whole file replaced, first found from the end wins):
//   <package>/agents/<role>.md → ~/.pi/agent/genie/agents/<role>.md → <.genie>/agents/<role>.md

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Gates, MemberRole } from "../tracker/model.ts";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface MemberSpec {
  name: string;
  role: MemberRole;
  /** provider/model, e.g. "openai-codex/gpt-6-luna" or "litellm/claude-opus-5-5" */
  model?: string;
  thinking?: string;
  /** Extra instructions appended to the role prompt for this member only. */
  instructions?: string;
}

export interface TeamTemplate {
  description?: string;
  /** Create a dedicated git worktree for the team (ignored outside git repos). */
  worktree?: boolean;
  members: MemberSpec[];
}

export interface GenieConfig {
  spawn: {
    /** auto: herdr panes inside herdr, otherwise headless RPC processes */
    mode: "auto" | "herdr" | "headless";
    piCommand: string;
    extraArgs: string[];
  };
  orchestrator: {
    /** Wake the orchestrator automatically when a team member writes to it. */
    autoWake: boolean;
  };
  worktrees: {
    /** Placeholders: {mainRoot} {repo} {team} {task} */
    dir: string;
    branch: string;
  };
  limits: {
    /** Hard cap on members in one team. */
    maxMembersPerTeam: number;
    /** Hard cap on simultaneously active teams. */
    maxActiveTeams: number;
  };
  language: {
    /** Tasks, comments, artifacts and team messages. */
    internal: string;
    /** Conversation with the owner. */
    user: string;
  };
  notify: {
    /** Desktop notification when a task enters one of these statuses. */
    statuses: string[];
  };
  gates: Gates;
  web: { port: number };
  /** Default model per role, used when a member spec has none. */
  roleModels: Record<string, { model?: string; thinking?: string }>;
  teams: Record<string, TeamTemplate>;
}

export interface RoleDef {
  role: string;
  description: string;
  /** Built-in tools removed for this role (e.g. read-only analyst/reviewer). */
  excludeTools: string[];
  /** MCP servers this role may use; ["*"] = all. */
  mcp: string[];
  prompt: string;
  source: string;
}

export function userGenieDir(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "genie");
}

function readJsonIfExists(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge for plain objects; arrays and scalars are replaced. */
export function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

export function configSources(genieDir?: string): string[] {
  const files = [path.join(PACKAGE_ROOT, "config", "default.json"), path.join(userGenieDir(), "config.json")];
  if (genieDir) files.push(path.join(genieDir, "config.json"));
  return files;
}

export function loadConfig(genieDir?: string): GenieConfig {
  let cfg = {} as GenieConfig;
  for (const f of configSources(genieDir)) {
    const data = readJsonIfExists(f);
    if (data) cfg = merge(cfg, data);
  }
  return cfg;
}

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadRole(role: string, genieDir?: string): RoleDef {
  const candidates = [path.join(PACKAGE_ROOT, "agents", `${role}.md`), path.join(userGenieDir(), "agents", `${role}.md`)];
  if (genieDir) candidates.push(path.join(genieDir, "agents", `${role}.md`));
  const file = [...candidates].reverse().find((f) => fs.existsSync(f));
  if (!file) throw new Error(`no role definition for "${role}" (looked in ${candidates.join(", ")})`);
  const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  return {
    role,
    description: data.description ?? "",
    excludeTools: list(data.excludeTools),
    mcp: data.mcp ? list(data.mcp) : ["*"],
    prompt: body.trim(),
    source: file,
  };
}

export function resolveMember(spec: MemberSpec, cfg: GenieConfig): MemberSpec {
  const defaults = cfg.roleModels?.[spec.role] ?? {};
  return { ...spec, model: spec.model ?? defaults.model, thinking: spec.thinking ?? defaults.thinking };
}

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

export function userConfigFile(): string {
  return path.join(userGenieDir(), "config.json");
}

/** Deep-merge `patch` into a config file (user or project scope) and write it back. */
export function saveConfigPatch(file: string, patch: Record<string, unknown>): void {
  const current = readJsonIfExists(file) ?? {};
  const next = merge(current, patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

/** Prompt paragraph with the language policy. */
export function languagePolicy(cfg: GenieConfig): string {
  const l = cfg.language ?? { internal: "English", user: "Russian" };
  return `Language policy: all internal content — task titles, descriptions, acceptance criteria, plans, notes, comments, artifacts and team messages — is written in ${l.internal}. Conversation with the owner (the human user) is in ${l.user}.`;
}

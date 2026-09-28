import { useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "@/shared/api";
import type { Catalogue, ConfigChange, McpCall, McpCheck, McpDetail, Preview, RoleDetail, SkillDetail, TemplateDetail } from "./model.ts";

export const agentKeys = {
  all: ["agent-config"] as const,
  catalogue: ["agent-config", "catalogue"] as const,
  role: (id: string) => ["agent-config", "role", id] as const,
  template: (id: string) => ["agent-config", "template", id] as const,
  skill: (name: string) => ["agent-config", "skill", name] as const,
  mcp: ["agent-config", "mcp"] as const,
  history: (item?: string) => ["agent-config", "history", item ?? ""] as const,
};

/** Roles, templates, skills and MCP connections the current project may use. */
export function useAgentConfig() {
  return useQuery({ queryKey: agentKeys.catalogue, queryFn: () => request<Catalogue>("GET", "/api/agent-config") });
}

export function useRole(id: string | undefined) {
  return useQuery({ queryKey: agentKeys.role(id ?? ""), queryFn: () => request<RoleDetail>("GET", `/api/roles/${id}`), enabled: !!id });
}

export function useTemplate(id: string | undefined) {
  return useQuery({ queryKey: agentKeys.template(id ?? ""), queryFn: () => request<TemplateDetail>("GET", `/api/templates/${id}`), enabled: !!id });
}

export function useSkill(name: string | undefined) {
  return useQuery({ queryKey: agentKeys.skill(name ?? ""), queryFn: () => request<SkillDetail>("GET", `/api/skills/${name}`), enabled: !!name });
}

export function useMcpConfig() {
  return useQuery({ queryKey: agentKeys.mcp, queryFn: () => request<McpDetail>("GET", "/api/mcp") });
}

/** The project's latest tool calls through the MCP gateway, newest first. */
export function useMcpCalls(project: string) {
  return useQuery({
    queryKey: ["mcp-calls", project],
    queryFn: () => request<McpCall[]>("GET", "/api/mcp/calls?limit=100"),
    refetchInterval: 15_000,
  });
}

/** Start a connection as agents would get it and list its tools (administrators). */
export function checkMcp(id: string) {
  return request<McpCheck>("POST", `/api/mcp/${encodeURIComponent(id)}/check`);
}

/** Changes made through the server (administrators only). */
export function useConfigHistory(item: string | undefined, enabled = true) {
  return useQuery({
    queryKey: agentKeys.history(item),
    queryFn: () => request<ConfigChange[]>("GET", `/api/agent-config/history${item ? `?item=${encodeURIComponent(item)}` : ""}`),
    enabled,
  });
}

/** What every member of a template would get as its kickoff, for a task (or an example one). */
export function usePreview(template: string | undefined, task: string | undefined) {
  return useQuery({
    queryKey: ["agent-config", "preview", template ?? "", task ?? ""],
    queryFn: () => request<Preview>("POST", `/api/templates/${template}/preview`, task ? { task } : {}),
    enabled: !!template,
    retry: false,
  });
}

export type ConfigKind = "role" | "template" | "skill" | "mcp";

const itemUrl = (kind: ConfigKind, id: string) =>
  kind === "role" ? `/api/roles/${id}` : kind === "template" ? `/api/templates/${id}` : kind === "skill" ? `/api/skills/${id}` : "/api/mcp";

export interface SaveResult {
  ok: boolean;
  path: string;
  hash: string;
  problems: { level: string; item: string; message: string }[];
}

/**
 * Save a configuration file. `baseHash` is the version the edit started from
 * (`""` for a new file): the server refuses when the file changed since (409)
 * and when the change is invalid or breaks something that works now (422).
 */
export function useSaveConfig() {
  const qc = useQueryClient();
  return async (kind: ConfigKind, id: string, body: { content?: string; template?: unknown }, baseHash: string | undefined) => {
    const out = await request<SaveResult>("PUT", itemUrl(kind, id), { ...body, baseHash });
    await qc.invalidateQueries({ queryKey: agentKeys.all });
    return out;
  };
}

/** Remove a data-directory file: a custom item goes away, a built-in one returns to its defaults. */
export function useDeleteConfig() {
  const qc = useQueryClient();
  return async (kind: Exclude<ConfigKind, "mcp">, id: string, baseHash?: string) => {
    const q = baseHash ? `?baseHash=${encodeURIComponent(baseHash)}` : "";
    const out = await request<{ ok: boolean }>("DELETE", `${itemUrl(kind, id)}${q}`);
    await qc.invalidateQueries({ queryKey: agentKeys.all });
    return out;
  };
}

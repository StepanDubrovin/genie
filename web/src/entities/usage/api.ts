import { useQuery } from "@tanstack/react-query";
import { request } from "@/shared/api";
import type { Spend, SpendItem } from "./model.ts";

/** What the agents spent on a task and the tasks under it (an epic's tasks, subtasks). */
export const useTaskUsage = (id: string | undefined) =>
  useQuery({
    queryKey: ["usage", "task", id ?? ""],
    queryFn: () => request<{ spend: Spend; tasks: SpendItem[] }>("GET", `/api/tasks/${encodeURIComponent(id!)}/usage`),
    enabled: !!id,
    staleTime: 30_000,
  });

/** What one agent's chat spent. */
export const useChatUsage = (team: string, member: string) =>
  useQuery({
    queryKey: ["usage", "chat", team, member],
    queryFn: () => request<{ spend: Spend }>("GET", `/api/agents/${encodeURIComponent(team)}/${encodeURIComponent(member)}/usage`),
    refetchInterval: 30_000,
  });

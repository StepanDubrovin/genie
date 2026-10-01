import { useQuery } from "@tanstack/react-query";
import { keys, request, useInvalidating } from "@/shared/api";
import { fetchArtifact, useTask } from "@/entities/task";
import { type IdeaPlan, PLAN_ARTIFACT, parsePlan } from "./model.ts";

/** File an idea and assemble its planner: where the conversation is. */
export const useStartIdea = () => useInvalidating((v: { text: string; title?: string }) => request<{ task: string; team: string; member: string }>("POST", "/api/ideas", v));

/** File the plan: the idea becomes the epic (or the first task), the rest are created. */
export const useApplyIdea = () =>
  useInvalidating((v: { id: string; plan: Omit<IdeaPlan, "assumptions" | "questions"> }) =>
    request<{ id: string; epic: boolean; created: string[] }>("POST", `/api/ideas/${encodeURIComponent(v.id)}/apply`, { plan: v.plan }),
  );

/** The latest plan the planner saved on the idea, and which version it is. */
export function useIdeaPlan(taskId: string | undefined) {
  const task = useTask(taskId).data;
  const saved = (task?.artifacts ?? []).filter((a) => a.name === PLAN_ARTIFACT);
  const last = saved[saved.length - 1];
  const q = useQuery({
    queryKey: [...keys.task(taskId ?? ""), "artifact", last?.id ?? 0] as const,
    queryFn: () => fetchArtifact(taskId!, last!.id),
    enabled: !!taskId && !!last,
    staleTime: Infinity,
  });
  return { task, plan: parsePlan(q.data?.text), version: saved.length, at: last?.at, loading: q.isPending && !!last, unreadable: !!q.data && !parsePlan(q.data.text) };
}

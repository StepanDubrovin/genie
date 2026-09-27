import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys, request, useInvalidating } from "@/shared/api";
import type { Status, Task, TaskSummary } from "./model.ts";

/** Every task, closed ones included; views and the board filter on the client. */
export const useTasks = () => useQuery({ queryKey: keys.tasks, queryFn: () => request<TaskSummary[]>("GET", "/api/tasks?closed=1") });

export const useTask = (id: string | undefined) =>
  useQuery({ queryKey: keys.task(id ?? ""), queryFn: () => request<Task>("GET", `/api/tasks/${encodeURIComponent(id!)}`), enabled: !!id });

export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: Status; note?: string }) => request<Task>("POST", `/api/tasks/${encodeURIComponent(v.id)}/status`, { status: v.status, note: v.note }),
    // Optimistic: the card jumps to its column immediately.
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: keys.tasks });
      const prev = qc.getQueryData<TaskSummary[]>(keys.tasks);
      qc.setQueryData<TaskSummary[]>(keys.tasks, (old) => old?.map((t) => (t.id === v.id ? { ...t, status: v.status } : t)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(keys.tasks, ctx.prev),
    onSettled: () => qc.invalidateQueries(),
  });
}

export const useComment = () => useInvalidating((v: { id: string; text: string }) => request<Task>("POST", `/api/tasks/${encodeURIComponent(v.id)}/comments`, { text: v.text }));
export const useCheck = () =>
  useInvalidating((v: { id: string; n: number; done: boolean }) => request<Task>("POST", `/api/tasks/${encodeURIComponent(v.id)}/acceptance/${v.n}`, { done: v.done }));
export const usePatchTask = () =>
  useInvalidating((v: { id: string; patch: { title?: string; description?: string; priority?: number; labels?: string[]; mergeStrategy?: string } }) =>
    request<Task>("PATCH", `/api/tasks/${encodeURIComponent(v.id)}`, v.patch),
  );
export const useCreateTask = () =>
  useInvalidating((v: { title: string; description?: string; acceptance?: string[]; priority?: number; labels?: string[]; type?: string }) => request<Task>("POST", "/api/tasks", v));

export async function fetchArtifact(task: string, n: number): Promise<{ name: string; kind: string; size: number; text?: string }> {
  return request("GET", `/api/tasks/${encodeURIComponent(task)}/artifacts/${n}`);
}

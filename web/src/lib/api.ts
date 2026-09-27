import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Meta, Status, Task, TaskSummary, TeamDetail, TeamView } from "./model.ts";

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? { "x-genie": "1" } : { "content-type": "application/json", "x-genie": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export const keys = {
  meta: ["meta"] as const,
  tasks: ["tasks"] as const,
  teams: ["teams"] as const,
  task: (id: string) => ["task", id] as const,
  team: (id: string) => ["team", id] as const,
};

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: () => request<Meta>("GET", "/api/meta") });
/** Every task, closed ones included; views and the board filter on the client. */
export const useTasks = () => useQuery({ queryKey: keys.tasks, queryFn: () => request<TaskSummary[]>("GET", "/api/tasks?closed=1") });
export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => request<TeamView[]>("GET", "/api/teams?all=1") });
export const useTask = (id: string | undefined) =>
  useQuery({ queryKey: keys.task(id ?? ""), queryFn: () => request<Task>("GET", `/api/tasks/${encodeURIComponent(id!)}`), enabled: !!id });
export const useTeam = (id: string | undefined) =>
  useQuery({ queryKey: keys.team(id ?? ""), queryFn: () => request<TeamDetail>("GET", `/api/teams/${encodeURIComponent(id!)}`), enabled: !!id });

function useInvalidating<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() });
}

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
export const useSendMail = () =>
  useInvalidating((v: { team: string; to: string; text: string }) => request<unknown>("POST", `/api/teams/${encodeURIComponent(v.team)}/mail`, { to: v.to, text: v.text }));

export async function fetchArtifact(task: string, n: number): Promise<{ name: string; kind: string; size: number; text?: string }> {
  return request("GET", `/api/tasks/${encodeURIComponent(task)}/artifacts/${n}`);
}

/** Server-sent change events → refetch everything that is on screen. */
export function useLiveUpdates(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const es = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries(), 150);
    });
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, []);
  return online;
}

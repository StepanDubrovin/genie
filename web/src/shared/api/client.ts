import { QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

export class ApiError extends Error {}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
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

export function useInvalidating<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() });
}

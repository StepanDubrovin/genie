import { useQuery } from "@tanstack/react-query";
import { keys, request, useInvalidating } from "@/shared/api";
import type { DoctorCheck, Meta, Membership, Person, ProjectInfo, ProjectRole, VaultSync } from "./model.ts";

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: () => request<Meta>("GET", "/api/meta") });

const at = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;

export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => request<ProjectInfo[]>("GET", "/api/projects") });

export const useMembers = (slug?: string) =>
  useQuery({ queryKey: ["members", slug ?? ""], queryFn: () => request<Membership[]>("GET", `${at(slug!)}/members`), enabled: !!slug, staleTime: 60_000 });

export const useUsers = (enabled = true) => useQuery({ queryKey: ["users"], queryFn: () => request<Person[]>("GET", "/api/users"), enabled });

export const usePatchProject = () =>
  useInvalidating(({ slug, patch }: { slug: string; patch: Partial<Pick<ProjectInfo, "name" | "autonomy" | "integration">> }) =>
    request<ProjectInfo>("PATCH", at(slug), patch),
  );

export const useCreateProject = () =>
  useInvalidating((p: { slug: string; name: string; repo?: string; prefix?: string }) => request<ProjectInfo>("POST", "/api/projects", p));

export const useSetMember = () =>
  useInvalidating(({ slug, user, role }: { slug: string; user: number; role: ProjectRole }) => request("PUT", `${at(slug)}/members/${user}`, { role }));

export const useRemoveMember = () => useInvalidating(({ slug, user }: { slug: string; user: number }) => request("DELETE", `${at(slug)}/members/${user}`));

export const useInvite = () =>
  useInvalidating(({ slug, role, email }: { slug: string; role: ProjectRole; email?: string }) =>
    request<{ token: string; url: string }>("POST", `${at(slug)}/invites`, { role, email: email || undefined }),
  );

export const useCreateUser = () =>
  useInvalidating((u: { login: string; name: string; email?: string; password?: string; isAdmin: boolean }) => request<Person>("POST", "/api/users", u));

export const usePatchUser = () =>
  useInvalidating(({ id, patch }: { id: number; patch: Partial<Pick<Person, "name" | "isAdmin" | "disabled">> & { email?: string | null } }) =>
    request<Person>("PATCH", `/api/users/${id}`, patch),
  );

/** The server's preflight, for its admins (runs pi and git on the server: a second or so). */
export const useDoctor = (enabled: boolean) =>
  useQuery({ queryKey: ["doctor"], queryFn: () => request<{ checks: DoctorCheck[] }>("GET", "/api/doctor"), enabled, staleTime: 60_000 });

export const useVaultSync = (enabled: boolean) =>
  useQuery({ queryKey: ["vault-sync"], queryFn: () => request<VaultSync>("GET", "/api/vault/sync"), enabled, refetchInterval: 30_000 });

export const useSyncVaultNow = () => useInvalidating(() => request<Pick<VaultSync, "last">>("POST", "/api/vault/sync"));

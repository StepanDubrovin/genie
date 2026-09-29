import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { keys, request, useInvalidating } from "@/shared/api";
import type { Mail, MailLevel, Team, TeamDetail, TeamView } from "./model.ts";

export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => request<TeamView[]>("GET", "/api/teams?all=1") });

export const useTeam = (id: string | undefined) =>
  useQuery({
    queryKey: keys.team(id ?? ""),
    queryFn: () => request<TeamDetail>("GET", `/api/teams/${encodeURIComponent(id!)}`),
    enabled: !!id,
    // A session's current step changes without a database write: poll while someone works.
    refetchInterval: (q) => (Object.values(q.state.data?.sessions ?? {}).some((s) => s.state === "working") ? 3000 : false),
  });

export const useSendMail = () =>
  useInvalidating((v: { team: string; to: string; text: string; level: MailLevel; intent?: Mail["intent"] }) =>
    request<unknown>("POST", `/api/teams/${encodeURIComponent(v.team)}/mail`, { to: v.to, text: v.text, level: v.level, intent: v.intent }),
  );

export const useStopTeam = () =>
  useInvalidating((v: { team: string; removeWorktree?: boolean }) => request<{ report: string[] }>("POST", `/api/teams/${encodeURIComponent(v.team)}/stop`, { removeWorktree: v.removeWorktree }));

export const useDeleteTeam = () =>
  useInvalidating((v: { team: string; removeWorktree?: boolean }) =>
    request<{ report: string[] }>("DELETE", `/api/teams/${encodeURIComponent(v.team)}${v.removeWorktree ? "?removeWorktree=1" : ""}`),
  );

export const useAddMember = () =>
  useInvalidating((v: { team: string; role: string; name?: string; model?: string; instructions?: string }) =>
    request<{ name: string; role: string; model?: string }[]>("POST", `/api/teams/${encodeURIComponent(v.team)}/members`, v),
  );

export const useRemoveMember = () =>
  useInvalidating((v: { team: string; member: string }) => request<unknown>("DELETE", `/api/teams/${encodeURIComponent(v.team)}/members/${encodeURIComponent(v.member)}`));

export function useTeamMap(): Map<string, Team> {
  const teams = useTeams().data;
  return useMemo(() => new Map((teams ?? []).map((t) => [t.id, t])), [teams]);
}

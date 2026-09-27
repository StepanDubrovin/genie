import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { keys, request, useInvalidating } from "@/shared/api";
import type { Team, TeamDetail, TeamView } from "./model.ts";

export const useTeams = () => useQuery({ queryKey: keys.teams, queryFn: () => request<TeamView[]>("GET", "/api/teams?all=1") });

export const useTeam = (id: string | undefined) =>
  useQuery({ queryKey: keys.team(id ?? ""), queryFn: () => request<TeamDetail>("GET", `/api/teams/${encodeURIComponent(id!)}`), enabled: !!id });

export const useSendMail = () =>
  useInvalidating((v: { team: string; to: string; text: string }) => request<unknown>("POST", `/api/teams/${encodeURIComponent(v.team)}/mail`, { to: v.to, text: v.text }));

export function useTeamMap(): Map<string, Team> {
  const teams = useTeams().data;
  return useMemo(() => new Map((teams ?? []).map((t) => [t.id, t])), [teams]);
}

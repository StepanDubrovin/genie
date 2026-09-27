import { useQuery } from "@tanstack/react-query";
import { keys, request } from "@/shared/api";
import type { Meta } from "./model.ts";

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: () => request<Meta>("GET", "/api/meta") });

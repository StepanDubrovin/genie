import type { Status } from "@/entities/task";

export interface Meta {
  prefix: string;
  project: string;
  created: string;
  counts: Partial<Record<Status, number>>;
  user: string;
  roles: string[];
  roleModels: Record<string, { model?: string; thinking?: string }>;
  tailnet?: string;
}

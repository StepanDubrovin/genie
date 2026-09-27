// UI-side view of teams. Types come straight from the server code, so the API
// contract is checked by the compiler on both sides.

import type { Mail, Team } from "../../../../src/team/bus.ts";
import type { Status } from "@/entities/task";

export type { Mail, Team };

export interface TeamView extends Team {
  taskInfo?: { id: string; title: string; status: Status };
  pending: Record<string, number>;
}

export interface TeamDetail extends TeamView {
  mail: Mail[];
  log: (Record<string, unknown> & { at: string; event: string })[];
}

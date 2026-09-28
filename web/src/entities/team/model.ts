// UI-side view of teams. Types come straight from the server code, so the API
// contract is checked by the compiler on both sides.

import type { Mail, Team } from "../../../../src/team/bus.ts";
import type { Status } from "@/entities/task";

export type { Mail, Team };

/** Mail levels of the Rust server: `interrupt` stops the agent's current step (people and the orchestrator). */
export type MailLevel = Mail["level"] | "interrupt";

/** A member's live session (pi in RPC mode) as the server sees it. */
export interface LiveSession {
  state: "starting" | "idle" | "working" | "stopping";
  since: string;
  pid: number;
  started: string;
  /** The tool call running now. */
  tool?: { name: string; args: string; since: string };
  lastText?: string;
  lastThinking?: string;
  recent: string[];
  runs: number;
  failures: number;
  lastError?: string;
  contextTokens?: number;
}

export interface TeamView extends Team {
  taskInfo?: { id: string; title: string; status: Status };
  pending: Record<string, number>;
  /** Live sessions by member name (Rust server with live sessions). */
  sessions?: Record<string, LiveSession>;
}

export interface TeamDetail extends TeamView {
  mail: Mail[];
  log: (Record<string, unknown> & { at: string; event: string })[];
}

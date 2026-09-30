// UI-side view of teams. Types come straight from the server code, so the API
// contract is checked by the compiler on both sides.

import type { Mail, Team } from "../../shared/api/types.ts";
import type { TeamSpecView } from "@/entities/agent-config";
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
  /** How the team works: members, relations, mail mode (Rust server). */
  spec?: TeamSpecView;
  /** The template changed since the team took its snapshot (team detail). */
  templateChanged?: boolean;
}

export interface TeamDetail extends TeamView {
  mail: Mail[];
  log: (Record<string, unknown> & { at: string; event: string })[];
}

/** One piece of an assistant message in the agent's conversation. */
export type PeekPart = { type: "text"; text: string } | { type: "thinking"; text: string } | { type: "tool"; id?: string; name: string; args: string };

/** One message of an agent's pi conversation, as `peek?deep=1` returns it. */
export interface PeekMessage {
  /** `user` | `assistant` | `toolResult` | `custom:<type>` (`custom:genie-mail` is delivered mail). */
  role: string;
  /** Short text for agents. */
  text: string;
  parts?: PeekPart[];
  at?: string;
  /** For a tool result: the call it answers. */
  tool?: { id?: string; name?: string; error: boolean };
  /** For delivered mail: the messages of the delivery. */
  mailIds?: number[];
}

export interface Peek {
  agent: string;
  session: LiveSession | null;
  conversation?: PeekMessage[];
}

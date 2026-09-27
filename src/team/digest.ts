// Orchestrator mail digest: the claimed slice arrives as one batch, so it is
// shaped before it is shown. Group by team, collapse to one line per sender
// (its latest message), order by what needs attention first, and keep purely
// informational (FYI) mail out of the way in a single trailing section.
//
// Pure and dependency-free on purpose: unit-testable without loading the
// extension. Intermediate per-sender messages dropped here stay in the mail
// history and in the web chat — nothing is lost, only the prompt is condensed.

import type { Mail, MailIntent } from "./bus.ts";

/** Message intent -> importance rank: standby questions first, FYI last. */
export function rankIntent(intent: MailIntent | undefined): number {
  switch (intent) {
    case "blocker":
    case "question":
      return 0; // a team is standing by and waiting for an answer
    case "verdict":
    case "done":
      return 1; // result worth reading, but no answer owed
    case "fyi":
      return 3; // already visible in the team card via setStatus
    default:
      return 2; // unclassified (legacy rows) blend in the middle
  }
}

const TEXT_LIMIT = 240;
const GLOBAL = "(global)";

function oneLine(text: string, limit = TEXT_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function teamOf(m: Mail): string {
  return m.team ?? GLOBAL;
}

/** One digest line: `- bender (executor) · high · done · <text>`. */
export function digestLine(m: Mail): string {
  const intent = m.intent ? ` · ${m.intent}` : "";
  return `- ${m.from} (${m.fromRole}) · ${m.level}${intent} · ${oneLine(m.text)}`;
}

/**
 * Render the orchestrator's message batch as a digest. `kind !== "message"` rows
 * (kickoff/owner/system) are ignored — the caller renders them verbatim first.
 */
export function renderDigest(mails: Mail[]): string {
  const messages = mails.filter((m) => m.kind === "message");
  if (!messages.length) return "";

  const fyiSenders = new Map<string, Mail>();
  const byTeam = new Map<string, Mail[]>();
  for (const m of messages) {
    if (m.intent === "fyi") {
      // One FYI line per sender, its latest; never a team section of its own.
      const key = `${teamOf(m)}/${m.from}`;
      const prev = fyiSenders.get(key);
      if (!prev || prev.id < m.id) fyiSenders.set(key, m);
      continue;
    }
    const list = byTeam.get(teamOf(m)) ?? [];
    list.push(m);
    byTeam.set(teamOf(m), list);
  }

  // One line per sender: keep only the latest message of each.
  const latestBySender = (rows: Mail[]): Mail[] => {
    const latest = new Map<string, Mail>();
    for (const m of rows) {
      const prev = latest.get(m.from);
      if (!prev || prev.id < m.id) latest.set(m.from, m);
    }
    return [...latest.values()].sort((a, b) => a.id - b.id);
  };

  const sections = [...byTeam.entries()].map(([team, rows]) => {
    const lines = latestBySender(rows);
    const latest = lines.reduce((a, b) => (a.id > b.id ? a : b));
    return { team, count: messages.filter((m) => teamOf(m) === team).length, lines, rank: rankIntent(latest.intent), at: latest.id };
  });
  // Teams standing by (question/blocker) first; ties by the earlier latest message.
  sections.sort((a, b) => a.rank - b.rank || a.at - b.at);

  const teams = new Set(messages.map(teamOf));
  const out: string[] = [`[genie digest · ${messages.length} message${messages.length === 1 ? "" : "s"} from ${teams.size} team${teams.size === 1 ? "" : "s"}]`];
  for (const s of sections) out.push("", `## ${s.team} (${s.count})`, ...s.lines.map(digestLine));
  const fyi = [...fyiSenders.values()].sort((a, b) => a.id - b.id);
  if (fyi.length) out.push("", "## FYI", ...fyi.map(digestLine));
  return out.join("\n");
}

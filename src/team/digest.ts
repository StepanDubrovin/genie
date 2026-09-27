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

  // One line per sender: its latest message decides both the line and the section.
  // Classifying after picking the latest keeps a sender from showing twice — in
  // its team section and again under FYI — when its latest mail is an FYI.
  const latestBySender = new Map<string, Mail>();
  for (const m of messages) {
    const key = `${teamOf(m)}/${m.from}`;
    const prev = latestBySender.get(key);
    if (!prev || prev.id < m.id) latestBySender.set(key, m);
  }

  const fyiSenders: Mail[] = [];
  const byTeam = new Map<string, Mail[]>();
  for (const m of latestBySender.values()) {
    if (m.intent === "fyi") {
      fyiSenders.push(m);
      continue;
    }
    const list = byTeam.get(teamOf(m)) ?? [];
    list.push(m);
    byTeam.set(teamOf(m), list);
  }

  const sections = [...byTeam.entries()].map(([team, lines]) => {
    const latest = lines.reduce((a, b) => (a.id > b.id ? a : b));
    lines.sort((a, b) => a.id - b.id);
    // The count describes the section's own rows, not FYI rows moved to `## FYI`.
    return { team, count: lines.length, lines, rank: rankIntent(latest.intent), at: latest.id };
  });
  // Teams standing by (question/blocker) first; ties by the earlier latest message.
  sections.sort((a, b) => a.rank - b.rank || a.at - b.at);

  // The header describes what is printed: one row per sender, grouped into team
  // sections with the FYI-only rows in their own section. Counting raw messages
  // or FYI-only teams would promise rows and sections the digest does not show.
  const fyi = fyiSenders.sort((a, b) => a.id - b.id);
  const rows = sections.reduce((n, s) => n + s.count, 0) + fyi.length;
  const shape = [
    sections.length ? `${sections.length} team section${sections.length === 1 ? "" : "s"}` : "",
    fyi.length ? "FYI" : "",
  ].filter(Boolean).join(" + ");
  const out: string[] = [`[genie digest · ${rows} message${rows === 1 ? "" : "s"} in ${shape}]`];
  for (const s of sections) out.push("", `## ${s.team} (${s.count})`, ...s.lines.map(digestLine));
  if (fyi.length) out.push("", "## FYI", ...fyi.map(digestLine));
  return out.join("\n");
}

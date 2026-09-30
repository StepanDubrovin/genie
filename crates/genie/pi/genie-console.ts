// genie-console: the orchestrator console in your own pi session.
//
// `genie orchestrate` starts pi with this extension next to genie-bus (which
// brings the orchestrator's mail into the conversation). It keeps a card of the
// project's active teams above the editor — refreshed when the server's live
// stream (/api/events) says something changed — and gives two commands:
// `/genie` shows the task board above the editor (again to hide it), `/genie
// agents` every agent's state and current step. The boards are the text of the
// genie command line, so they read as they do in the terminal. The file is
// written by `genie orchestrate`; edit crates/genie/pi/genie-console.ts in the
// repository instead.

const BASE = (process.env.GENIE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.GENIE_TOKEN ?? "";
const PROJECT = process.env.GENIE_PROJECT ?? "";
const GENIE = process.env.GENIE_BIN || "genie";
const CARD = "genie-teams";
const BOARD = "genie-board";

export default function genieConsole(pi: any) {
  if (process.env.GENIE_CONSOLE !== "1" || !BASE || !TOKEN) return;
  let ctx: any;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let shown: string | undefined;
  const abort = new AbortController();

  async function api(path: string): Promise<any> {
    const res = await fetch(`${BASE}/api${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  /** The card: who holds the console, and one line per active team. */
  async function card(): Promise<void> {
    if (!ctx?.hasUI) return;
    let lines: string[];
    try {
      const [teams, console_] = await Promise.all([api("/teams"), api("/orchestrator/console")]);
      const holder = console_?.console?.user ? ` · console: @${console_.console.user}` : " · the console was given back";
      lines = [`genie · ${PROJECT}${holder}`];
      for (const t of (teams as any[]).slice(0, 8)) {
        const members = (t.members ?? [])
          .map((m: any) => {
            const said = (m.status ?? "").length > 40 ? `${m.status.slice(0, 39)}…` : (m.status ?? "");
            return `${m.name} (${m.role}) ${m.state === "active" ? m.activity : m.state}${said ? ` — ${said}` : ""}`;
          })
          .join(" · ");
        lines.push(`  ${t.task}${t.state === "active" ? "" : ` [${t.state}]`}: ${members || "no members"}`);
      }
      if (!(teams as any[]).length) lines.push("  no teams at work");
    } catch (e) {
      lines = [`genie · ${PROJECT}: ${e instanceof Error ? e.message : String(e)}`];
    }
    ctx.ui.setWidget(CARD, lines);
  }

  const refresh = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => void card(), 300);
  };

  /** Follow the server's live stream; a change refreshes the card. */
  async function follow(): Promise<void> {
    while (!stopped) {
      try {
        const res = await fetch(`${BASE}/api/events`, {
          headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const text = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += text.decode(value, { stream: true });
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (/^event: (change|journal)$/m.test(block)) refresh();
          }
        }
      } catch {
        if (stopped) return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  pi.on("session_start", (_event: any, c: any) => {
    ctx = c;
    void card();
    void follow();
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    abort.abort();
    if (pending) clearTimeout(pending);
  });

  pi.registerCommand("genie", {
    description: "genie: the task board above the editor (again to hide it); `/genie agents` — every agent's state",
    handler: async (args: string, c: any) => {
      ctx = c;
      const which = args.trim() === "agents" ? "agents" : "board";
      if (shown === which) {
        shown = undefined;
        c.ui.setWidget(BOARD, undefined);
        return;
      }
      const r = await pi.exec(GENIE, which === "agents" ? ["team", "board"] : ["task", "board"], { timeout: 15_000 });
      if (r.code !== 0) {
        c.ui.notify((r.stderr || r.stdout || `genie exited with ${r.code}`).trim(), "error");
        return;
      }
      shown = which;
      c.ui.setWidget(BOARD, r.stdout.trimEnd().split("\n"));
    },
  });
}

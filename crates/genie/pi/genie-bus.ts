// genie-bus: delivers genie team mail into a live pi session.
//
// genie serve runs every team member and the orchestrator as a long-lived
// `pi --mode rpc` process with this extension loaded. Mail is pulled from the
// server at the latest possible moment and put into the conversation:
//
// - at every step boundary (`turn_end`, after the step's tool calls and before
//   the next model request) and before the agent would stop
//   (`agent_before_settle`), so mail reaches a busy agent between steps instead
//   of after its whole run;
// - by the `/genie-mail` command, which the server sends to wake an idle
//   session (it does nothing while the agent is working: the next boundary
//   takes the mail).
//
// A delivery is acknowledged when the model is about to see it (`context`).
// Mail ids already in the session are reported as `seen`, so a delivery whose
// acknowledgement was lost (crash, restart) is settled instead of injected
// twice. The extension is written by genie serve into its data directory; edit
// crates/genie/pi/genie-bus.ts in the repository instead.

const BASE = (process.env.GENIE_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.GENIE_TOKEN ?? "";
const MAIL = "genie-mail";
const SEEN_LIMIT = 300;
const DEBUG = process.env.GENIE_BUS_DEBUG === "1";

interface Delivery {
  delivery: number;
  ids: number[];
  text: string;
}

export default function genieBus(pi: any) {
  if (!BASE || !TOKEN) return;
  /** Mail ids this session holds (rebuilt from the session on start). */
  const delivered = new Set<number>();
  /** Deliveries put into the session and not yet acknowledged. */
  const unacked = new Set<number>();

  function report(what: string, e: unknown): void {
    console.error(`[genie-bus] ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const debug = (...args: unknown[]) => DEBUG && console.error("[genie-bus]", ...args);

  async function call(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${BASE}/api${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${data?.error ?? ""}`);
    return data;
  }

  async function lease(): Promise<Delivery | undefined> {
    try {
      const d = (await call("/agent/inbox/lease", { seen: [...delivered].slice(-SEEN_LIMIT) })) as Delivery | { delivery: null };
      if (!d?.delivery) return undefined;
      const got = d as Delivery;
      for (const id of got.ids) delivered.add(id);
      unacked.add(got.delivery);
      return got;
    } catch (e) {
      // The server keeps the mail; the next boundary or wake-up tries again.
      report("lease", e);
      return undefined;
    }
  }

  const asMessage = (d: Delivery) => ({ customType: MAIL, content: d.text, display: true, details: { delivery: d.delivery, mailIds: d.ids } });

  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry?.type === "custom_message" && entry.customType === MAIL) {
          for (const id of entry.details?.mailIds ?? []) delivered.add(id);
        }
      }
    } catch (e) {
      report("session_start", e);
    }
  });

  const boundary = async (event: any, ctx: any) => {
    const aborting = !!ctx?.signal?.aborted;
    debug(event?.type, "outcome", event?.outcome, "aborting", aborting, "canContinue", event?.context?.canContinue);
    // An aborted step is followed by the interrupting mail through /genie-mail;
    // mail put in now would be cut off together with the step.
    if (event?.outcome !== "completed" || aborting || event?.context?.canContinue === false) return undefined;
    const d = await lease();
    if (!d) return undefined;
    return { entries: [{ type: "custom_message", ...asMessage(d) }], continue: true };
  };
  pi.on("turn_end", boundary);
  pi.on("agent_before_settle", boundary);

  // The model is about to see these messages: acknowledge their deliveries.
  pi.on("context", async (event: any) => {
    if (!unacked.size) return undefined;
    for (const m of event?.messages ?? []) {
      const id = m?.customType === MAIL ? m.details?.delivery : undefined;
      if (typeof id !== "number" || !unacked.has(id)) continue;
      try {
        await call("/agent/inbox/ack", { delivery: id });
        unacked.delete(id);
      } catch (e) {
        report("ack", e); // retried at the next request; the server settles it via `seen`
      }
    }
    return undefined;
  });

  pi.registerCommand("genie-mail", {
    description: "Deliver pending genie mail (sent by genie serve to wake the session)",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.isIdle()) return; // working: the next step boundary takes the mail
      const d = await lease();
      if (d) pi.sendMessage(asMessage(d), { triggerTurn: true });
    },
  });
}

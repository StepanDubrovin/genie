// Desktop notifications for owner-relevant task transitions (needs_owner, done…).

import { spawn } from "node:child_process";
import type { GenieConfig } from "./team/config.ts";
import type { Tracker, TrackerEvent } from "./tracker/store.ts";

function send(summary: string, body: string, urgency: "normal" | "critical"): void {
  const run = (cmd: string, args: string[]) => {
    try {
      const p = spawn(cmd, args, { stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
      return true;
    } catch {
      return false;
    }
  };
  // notify-send reaches the desktop (mako on omarchy); herdr also surfaces it in its UI when available.
  run("notify-send", ["--app-name=genie", `--urgency=${urgency}`, summary, body]);
  if (process.env.HERDR_ENV === "1") run("herdr", ["notification", "show", summary, "--body", body, "--sound", urgency === "critical" ? "request" : "done"]);
}

export function notifyOn(tracker: Tracker, cfg: GenieConfig): () => void {
  const statuses = cfg.notify?.statuses ?? ["needs_owner", "done"];
  return tracker.onEvent((e: TrackerEvent) => {
    if (e.type !== "status" || !statuses.includes(e.to)) return;
    // The owner does not need to be told about their own actions.
    if (e.actor.role === "human") return;
    const project = tracker.meta().project;
    if (e.to === "needs_owner") send(`genie · ${e.task.id} needs your decision`, `${e.task.title}\n${e.note ?? ""}`.trim(), "critical");
    else send(`genie · ${e.task.id} → ${e.to}`, `${project}: ${e.task.title}${e.note ? `\n${e.note}` : ""}`, "normal");
  });
}

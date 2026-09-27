// /genie settings — edit genie configuration from inside pi with the built-in dialogs.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { type GenieConfig, loadConfig, saveConfigPatch, userConfigFile } from "../team/config.ts";
import { MEMBER_ROLES, STATUSES } from "../tracker/model.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function pickScope(ctx: ExtensionCommandContext, genieDir: string | undefined): Promise<string | undefined> {
  if (!genieDir) return userConfigFile();
  const user = `user — ${userConfigFile()}`;
  const project = `project — ${path.join(genieDir, "config.json")}`;
  const choice = await ctx.ui.select("Save settings to", [user, project]);
  if (!choice) return undefined;
  return choice === user ? userConfigFile() : path.join(genieDir, "config.json");
}

async function roleModels(ctx: ExtensionCommandContext, cfg: GenieConfig, file: string): Promise<void> {
  for (;;) {
    const rows = MEMBER_ROLES.map((r) => `${r.padEnd(11)} ${cfg.roleModels?.[r]?.model ?? "(pi default)"} · ${cfg.roleModels?.[r]?.thinking ?? "default"}`);
    const pick = await ctx.ui.select("Role models — pick a role", [...rows, "← back"]);
    if (!pick || pick === "← back") return;
    const role = pick.split(/\s+/)[0];
    const available = ctx.modelRegistry
      .getAvailable()
      .map((m) => `${m.provider}/${m.id}`)
      .sort();
    const filter = (await ctx.ui.input(`Filter models for ${role} (empty = all, ${available.length} available)`, "e.g. deepseek")) ?? "";
    const models = available.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
    if (!models.length) {
      ctx.ui.notify(`no available model matches "${filter}"`, "warning");
      continue;
    }
    const model = await ctx.ui.select(`Model for ${role}`, models);
    if (!model) continue;
    const thinking = await ctx.ui.select(`Thinking level for ${role}`, THINKING);
    if (!thinking) continue;
    saveConfigPatch(file, { roleModels: { [role]: { model, thinking } } });
    cfg.roleModels = { ...cfg.roleModels, [role]: { model, thinking } };
    ctx.ui.notify(`${role} → ${model} (${thinking})`, "info");
  }
}

async function numberInput(ctx: ExtensionCommandContext, title: string, current: number): Promise<number | undefined> {
  const v = await ctx.ui.input(`${title} (current ${current})`, String(current));
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    ctx.ui.notify(`"${v}" is not a positive integer`, "warning");
    return undefined;
  }
  return n;
}

export async function settingsMenu(ctx: ExtensionCommandContext, genieDir: string | undefined): Promise<void> {
  const file = await pickScope(ctx, genieDir);
  if (!file) return;
  for (;;) {
    const cfg = loadConfig(genieDir);
    const items = [
      "Role models",
      `Limits — ${cfg.limits.maxMembersPerTeam} members/team, ${cfg.limits.maxActiveTeams} active teams`,
      `Language — internal ${cfg.language.internal}, owner ${cfg.language.user}`,
      `Notifications — ${cfg.notify.statuses.join(", ") || "off"}`,
      `Gates — test-report ${cfg.gates.requireTestReport ? "required" : "optional"}, review artifact ${cfg.gates.requireReviewArtifact ? "required" : "optional"}`,
      `Team launch — ${cfg.spawn.mode}`,
      `Orchestrator auto-wake — ${cfg.orchestrator.autoWake ? "on" : "off"}`,
      `Web UI port — ${cfg.web.port}`,
      "Done",
    ];
    const pick = await ctx.ui.select(`genie settings → ${file}`, items);
    if (!pick || pick === "Done") return;
    if (pick === "Role models") await roleModels(ctx, cfg, file);
    else if (pick.startsWith("Limits")) {
      const members = await numberInput(ctx, "Max members per team", cfg.limits.maxMembersPerTeam);
      const teams = await numberInput(ctx, "Max active teams", cfg.limits.maxActiveTeams);
      saveConfigPatch(file, { limits: { ...(members ? { maxMembersPerTeam: members } : {}), ...(teams ? { maxActiveTeams: teams } : {}) } });
    } else if (pick.startsWith("Language")) {
      const internal = await ctx.ui.input(`Internal language (current ${cfg.language.internal})`, cfg.language.internal);
      const user = await ctx.ui.input(`Language with the owner (current ${cfg.language.user})`, cfg.language.user);
      saveConfigPatch(file, { language: { ...(internal ? { internal } : {}), ...(user ? { user } : {}) } });
    } else if (pick.startsWith("Notifications")) {
      const current = new Set(cfg.notify.statuses);
      for (;;) {
        const rows = STATUSES.map((s) => `${current.has(s) ? "[x]" : "[ ]"} ${s}`);
        const t = await ctx.ui.select("Notify when a task enters… (select to toggle)", [...rows, "Save"]);
        if (!t || t === "Save") break;
        const s = t.slice(4);
        if (current.has(s)) current.delete(s);
        else current.add(s);
      }
      saveConfigPatch(file, { notify: { statuses: [...current] } });
    } else if (pick.startsWith("Gates")) {
      const tr = await ctx.ui.confirm("Gates", "Require a test-report artifact before review?");
      const rv = await ctx.ui.confirm("Gates", "Require a review artifact before approval?");
      saveConfigPatch(file, { gates: { requireTestReport: tr, requireReviewArtifact: rv } });
    } else if (pick.startsWith("Team launch")) {
      const mode = await ctx.ui.select("Where team members run", ["auto — herdr inside herdr, else headless", "herdr", "headless"]);
      if (mode) saveConfigPatch(file, { spawn: { mode: mode.split(" ")[0] } });
    } else if (pick.startsWith("Orchestrator auto-wake")) {
      saveConfigPatch(file, { orchestrator: { autoWake: !cfg.orchestrator.autoWake } });
    } else if (pick.startsWith("Web UI port")) {
      const port = await numberInput(ctx, "Web UI port", cfg.web.port);
      if (port) saveConfigPatch(file, { web: { port } });
    }
  }
}

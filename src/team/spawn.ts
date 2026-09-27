// Launching team members: git worktrees, herdr panes or headless RPC processes.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { repoInfo, runGit } from "../tracker/fsutil.ts";
import type { MemberRuntime, Team } from "./bus.ts";
import { type GenieConfig, fillTemplate, type MemberSpec, PACKAGE_ROOT, type RoleDef } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  base: string;
}

export function createWorktree(cwd: string, teamId: string, taskId: string, cfg: GenieConfig): WorktreeInfo {
  const repo = repoInfo(cwd);
  if (!repo) throw new Error(`${cwd} is not inside a git repository; spawn the team with worktree=false`);
  const vars = { mainRoot: repo.mainRoot, repo: path.basename(repo.mainRoot), team: teamId, task: taskId };
  const dir = path.resolve(fillTemplate(cfg.worktrees.dir, vars));
  const branch = fillTemplate(cfg.worktrees.branch, vars);
  const base = runGit(cwd, ["rev-parse", "HEAD"]);
  if (fs.existsSync(dir)) throw new Error(`worktree directory ${dir} already exists`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let branchExists = true;
  try {
    runGit(repo.mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    branchExists = false;
  }
  runGit(repo.mainRoot, branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base]);
  return { path: dir, branch, base };
}

export function removeWorktree(worktreePath: string, force = false): void {
  const repo = repoInfo(worktreePath);
  if (!repo) return;
  runGit(repo.mainRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
}

/** True when genie is installed as a pi package, so children load it without `-e`. */
export function installedAsPackage(cwd: string): boolean {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const settingsFiles = [path.join(agentDir, "settings.json"), path.join(cwd, ".pi", "settings.json")];
  for (const file of settingsFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(file, "utf8")) as { packages?: unknown[]; extensions?: unknown[] };
      for (const entry of [...(settings.packages ?? []), ...(settings.extensions ?? [])]) {
        const src = typeof entry === "string" ? entry : (entry as { source?: string })?.source;
        if (!src || src.startsWith("npm:") || src.startsWith("git:") || src.startsWith("http")) {
          if (src && /(^|[/:])genie(@|$)/.test(src)) return true;
          continue;
        }
        const resolved = path.resolve(path.dirname(file), src.replace(/^~(?=\/)/, os.homedir()));
        if (resolved === PACKAGE_ROOT || resolved.startsWith(`${PACKAGE_ROOT}${path.sep}`)) return true;
      }
    } catch {
      // unreadable settings: fall through
    }
  }
  return false;
}

export interface LaunchSpec {
  team: Team;
  member: MemberSpec & { name: string };
  role: RoleDef;
  genieDir: string;
  cwd: string;
  cfg: GenieConfig;
}

export function memberEnv(spec: LaunchSpec): Record<string, string> {
  return {
    GENIE_DIR: spec.genieDir,
    GENIE_ROLE: spec.member.role,
    GENIE_TEAM: spec.team.id,
    GENIE_MEMBER: spec.member.name,
    GENIE_TASK: spec.team.task,
  };
}

export function piArgs(spec: LaunchSpec): string[] {
  const args = [...(spec.cfg.spawn.extraArgs ?? [])];
  if (!installedAsPackage(spec.cwd)) args.push("-e", path.join(PACKAGE_ROOT, "src", "extension", "index.ts"));
  if (spec.member.model) args.push("--model", spec.member.model);
  if (spec.member.thinking) args.push("--thinking", spec.member.thinking);
  if (spec.role.excludeTools.length) args.push("--exclude-tools", spec.role.excludeTools.join(","));
  args.push("--name", `${spec.team.id}:${spec.member.name}`);
  return args;
}

/** herdr agent names: [a-z][a-z0-9_-]{0,31}, unique among live agents. */
export function herdrAgentName(teamId: string, member: string): string {
  let name = `${teamId}-${member}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!/^[a-z]/.test(name)) name = `g${name}`;
  return name.slice(0, 32);
}

async function herdrJson(args: string[]): Promise<Record<string, any>> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 120_000 });
  try {
    return JSON.parse(stdout) as Record<string, any>;
  } catch {
    return { raw: stdout };
  }
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

/**
 * Open one herdr tab per team; members are split into panes inside it.
 * With `anchorPane`, new members are split from that pane instead (adding to a running team).
 * Returns the runtime handle for every member, in order.
 */
export async function launchHerdr(specs: LaunchSpec[], anchorPane?: string): Promise<MemberRuntime[]> {
  if (process.env.HERDR_ENV !== "1") throw new Error("herdr mode requires running pi inside herdr (HERDR_ENV=1)");
  const panes: string[] = [];
  let prev = anchorPane;
  for (let i = 0; i < specs.length; i++) {
    if (!prev) {
      const tab = await herdrJson([
        "tab",
        "create",
        ...(process.env.HERDR_WORKSPACE_ID ? ["--workspace", process.env.HERDR_WORKSPACE_ID] : []),
        "--cwd",
        specs[i].cwd,
        "--label",
        `genie ${specs[i].team.id}`,
        "--no-focus",
        ...envFlags(memberEnv(specs[i])),
      ]);
      const root: string | undefined = tab.result?.root_pane?.pane_id;
      if (!root) throw new Error(`herdr tab create returned no pane: ${JSON.stringify(tab).slice(0, 300)}`);
      panes.push(root);
    } else {
      const split = await herdrJson([
        "pane",
        "split",
        prev,
        "--direction",
        panes.length + (anchorPane ? 1 : 0) === 1 ? "right" : "down",
        "--cwd",
        specs[i].cwd,
        "--no-focus",
        ...envFlags(memberEnv(specs[i])),
      ]);
      const pane: string | undefined = split.result?.pane?.pane_id;
      if (!pane) throw new Error(`herdr pane split returned no pane: ${JSON.stringify(split).slice(0, 300)}`);
      panes.push(pane);
    }
    prev = panes[panes.length - 1];
  }
  await Promise.all(
    specs.map((spec, i) =>
      execFileAsync(
        "herdr",
        ["agent", "start", herdrAgentName(spec.team.id, spec.member.name), "--kind", "pi", "--pane", panes[i], "--timeout", "120000", "--", ...piArgs(spec)],
        { encoding: "utf8", timeout: 180_000 },
      ),
    ),
  );
  return panes.map((paneId) => ({ kind: "herdr" as const, paneId }));
}

/** Headless members live as `pi --mode rpc` children of the orchestrator process. */
export const headlessChildren = new Map<string, ChildProcess>();

export function launchHeadless(spec: LaunchSpec, logDir: string): MemberRuntime {
  const log = fs.openSync(path.join(logDir, `${spec.member.name}.stderr.log`), "a");
  const child = spawn(spec.cfg.spawn.piCommand, [...piArgs(spec), "--mode", "rpc"], {
    cwd: spec.cwd,
    env: { ...process.env, ...memberEnv(spec) },
    stdio: ["pipe", "ignore", log],
  });
  fs.closeSync(log);
  child.on("error", () => {});
  headlessChildren.set(`${spec.team.id}/${spec.member.name}`, child);
  child.on("exit", () => headlessChildren.delete(`${spec.team.id}/${spec.member.name}`));
  return { kind: "headless", pid: child.pid };
}

export async function stopMember(teamId: string, member: string, runtime: MemberRuntime | undefined): Promise<void> {
  if (!runtime) return;
  if (runtime.kind === "herdr" && runtime.paneId) {
    await execFileAsync("herdr", ["pane", "close", runtime.paneId], { encoding: "utf8", timeout: 30_000 }).catch(() => undefined);
    return;
  }
  if (runtime.kind === "headless") {
    const child = headlessChildren.get(`${teamId}/${member}`);
    if (child) {
      child.stdin?.end();
      child.kill("SIGTERM");
      headlessChildren.delete(`${teamId}/${member}`);
    } else if (runtime.pid) {
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

export function stopAllHeadless(): void {
  for (const [key, child] of headlessChildren) {
    child.stdin?.end();
    child.kill("SIGTERM");
    headlessChildren.delete(key);
  }
}

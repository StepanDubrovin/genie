// Launching team members: git worktrees, herdr panes or headless RPC processes.

import { execFile, execFileSync, spawn } from "node:child_process";
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
  /** Continue this pi session file instead of starting a fresh one (restarting a lost member). */
  resumeSession?: string;
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
  if (spec.resumeSession && fs.existsSync(spec.resumeSession)) args.push("--session", spec.resumeSession);
  // The --name label also lets `discoverMembers` recognise the process later.
  args.push("--name", processLabel(spec.team.id, spec.member.name));
  return args;
}

export function processLabel(teamId: string, member: string): string {
  return `${teamId}:${member}`;
}

/** herdr agent names: [a-z][a-z0-9_-]{0,31}, unique among live agents. */
export function herdrAgentName(teamId: string, member: string): string {
  let name = `${teamId}-${member}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!/^[a-z]/.test(name)) name = `g${name}`;
  return name.slice(0, 32);
}

async function herdrJson(args: string[]): Promise<Record<string, any>> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 30_000 });
  try {
    return JSON.parse(stdout) as Record<string, any>;
  } catch {
    return { raw: stdout };
  }
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

/** Start a helper that outlives this process and never blocks it; output goes to a log file. */
function fireAndForget(cmd: string, args: string[], logFile: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): number | undefined {
  const fd = fs.openSync(logFile, "a");
  try {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", fd, fd], detached: true });
    child.on("error", (err) => fs.appendFileSync(logFile, `\n[genie] ${cmd} failed: ${err.message}\n`));
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Open one herdr tab per team; members are split into panes inside it.
 * With `anchorPane`, new members are split from that pane instead (adding to a running team).
 *
 * Only pane creation is awaited (fast). Starting pi in each pane is handed to
 * detached `herdr agent start` helpers: the caller never waits for agents to
 * become ready — members check in themselves with heartbeats, and the
 * orchestrator's supervisor reports members that never do.
 */
export async function launchHerdr(specs: LaunchSpec[], logDir: string, anchorPane?: string): Promise<MemberRuntime[]> {
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
  specs.forEach((spec, i) =>
    fireAndForget(
      "herdr",
      ["agent", "start", herdrAgentName(spec.team.id, spec.member.name), "--kind", "pi", "--pane", panes[i], "--timeout", "300000", "--", ...piArgs(spec)],
      path.join(logDir, `${spec.member.name}.launch.log`),
    ),
  );
  return panes.map((paneId) => ({ kind: "herdr" as const, paneId }));
}

/**
 * Headless members run `pi --mode rpc` as independent processes (own process
 * group), so they survive /reload or a restart of the orchestrator. RPC mode
 * exits when stdin closes; stdin is a FIFO the member opens read-write itself,
 * so it never sees EOF. The orchestrator can also write RPC commands into it.
 */
export function launchHeadless(spec: LaunchSpec, logDir: string): MemberRuntime {
  const fifo = path.join(logDir, `${spec.member.name}.stdin`);
  if (!fs.existsSync(fifo)) execFileSync("mkfifo", ["-m", "600", fifo]);
  const pid = fireAndForget("sh", ["-c", 'exec "$@" <>"$GENIE_STDIN_FIFO"', "sh", spec.cfg.spawn.piCommand, ...piArgs(spec), "--mode", "rpc"], path.join(logDir, `${spec.member.name}.stderr.log`), {
    cwd: spec.cwd,
    env: { ...process.env, ...memberEnv(spec), GENIE_STDIN_FIFO: fifo },
  });
  return { kind: "headless", pid };
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function stopMember(runtime: MemberRuntime | undefined): Promise<void> {
  if (!runtime) return;
  if (runtime.kind === "herdr" && runtime.paneId) {
    await execFileAsync("herdr", ["pane", "close", runtime.paneId], { encoding: "utf8", timeout: 30_000 }).catch(() => undefined);
  }
  if (runtime.pid && isAlive(runtime.pid)) {
    // Headless members lead their own process group; fall back to the single pid.
    for (const target of [-runtime.pid, runtime.pid]) {
      try {
        process.kill(target, "SIGTERM");
        break;
      } catch {
        // try the next form
      }
    }
  }
}

export interface FoundMember {
  pid: number;
  team: string;
  member: string;
}

/**
 * Find running member processes of this tracker, whatever launched them
 * (herdr pane, headless, by hand): Linux /proc scan matching the `--name
 * <team>:<member>` label and GENIE_DIR. Other platforms return [].
 */
export function discoverMembers(genieDir: string): FoundMember[] {
  if (process.platform !== "linux" || !fs.existsSync("/proc")) return [];
  const found: FoundMember[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const env = parseEnviron(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
      if (!env.GENIE_TEAM || !env.GENIE_MEMBER || path.resolve(env.GENIE_DIR ?? "") !== path.resolve(genieDir)) continue;
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const label = processLabel(env.GENIE_TEAM, env.GENIE_MEMBER);
      const i = cmdline.indexOf("--name");
      if (i < 0 || cmdline[i + 1] !== label) continue; // shells and helpers carry the env but not the label
      found.push({ pid, team: env.GENIE_TEAM, member: env.GENIE_MEMBER });
    } catch {
      // process exited or is not ours
    }
  }
  // A launcher may exec through wrappers: keep the newest (highest) pid per member.
  const byMember = new Map<string, FoundMember>();
  for (const f of found) {
    const key = `${f.team}/${f.member}`;
    if (!byMember.has(key) || byMember.get(key)!.pid < f.pid) byMember.set(key, f);
  }
  return [...byMember.values()];
}

export function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const kv of raw.split("\0")) {
    const eq = kv.indexOf("=");
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return env;
}

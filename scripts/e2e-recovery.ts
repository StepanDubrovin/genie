// End-to-end recovery check with real models:
//   1. an orchestrator (pi RPC) spawns a headless pair team;
//   2. the orchestrator process is killed (SIGKILL) — members must keep running;
//   3. the reviewer process is killed as well;
//   4. a fresh orchestrator must reconnect, get told the reviewer was lost,
//      restart it with team_recover and still accept the task.
//
//   node scripts/e2e-recovery.ts [--model litellm/deepseek-v4-flash-vision-exp] [--timeout 900]

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { TeamBus } from "../src/team/bus.ts";
import { discoverMembers, installedAsPackage, isAlive } from "../src/team/spawn.ts";
import { Tracker } from "../src/tracker/store.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "litellm/deepseek-v4-flash-vision-exp" },
    thinking: { type: "string", default: "medium" },
    timeout: { type: "string", default: "900" },
  },
});

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "genie-e2e-rec-"));
const repo = path.join(work, "repo");
fs.mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("config", "user.email", "e2e@genie");
git("config", "user.name", "genie e2e");
fs.writeFileSync(path.join(repo, "README.md"), "# e2e\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const tracker = Tracker.init(path.join(repo, ".genie"));
const m = { model: values.model, thinking: values.thinking };
fs.writeFileSync(path.join(tracker.dir, "config.json"), JSON.stringify({ roleModels: { analyst: m, executor: m, reviewer: m } }, null, 2));
const human = { name: "e2e", role: "human" as const };
tracker.create(human, {
  title: "Add greeting file",
  description: "Create `hello.txt` in the repository root containing exactly the line `hello genie` (with a trailing newline) and commit it on the team branch.",
  acceptance: ["hello.txt exists in the team worktree with exactly `hello genie\\n`", "the change is committed on the team branch"],
});
tracker.setStatus(human, "G-1", "ready");
const bus = new TeamBus(tracker);
console.log(`repo: ${repo}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const extArgs = installedAsPackage(repo) ? [] : ["-e", path.join(root, "src/extension/index.ts")];

function orchestrator(label: string, prompt: string): ChildProcess {
  const p = spawn("pi", ["--mode", "rpc", "--no-session", ...extArgs, "--model", values.model!, "--thinking", values.thinking!], {
    cwd: repo,
    env: { ...process.env, HERDR_ENV: "", GENIE_ROLE: "orchestrator" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  p.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        if (ev.type === "tool_execution_start") console.log(`  [${label}] tool ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 140)}`);
      } catch {
        // not JSON
      }
    }
  });
  p.stdin!.write(`${JSON.stringify({ id: "p1", type: "prompt", message: prompt })}\n`);
  return p;
}

async function waitFor(what: string, cond: () => boolean, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(2000);
  }
  console.log(`  ✗ timed out waiting for: ${what}`);
  return false;
}

let lastLog = 0;
function printLog(): void {
  if (!bus.exists("G-1")) return;
  const log = bus.readLog("G-1", 500);
  for (const e of log.slice(lastLog)) console.log(`  [team] ${String(e.at).slice(11, 19)} ${e.event} ${JSON.stringify({ ...e, at: undefined, event: undefined }).slice(0, 160)}`);
  lastLog = log.length;
}

const checks: [string, boolean][] = [];
const deadline = Date.now() + Number(values.timeout) * 1000;

// 1. first orchestrator spawns the team
let orch = orchestrator("orch-1", "Task G-1 is ready. Spawn a team for it with team_spawn using template `pair` and mode `headless`, then end your turn.");
const t0 = Date.now();
const spawned = await waitFor("members check in", () => bus.exists("G-1") && bus.get("G-1").members.every((x) => !!x.heartbeatAt), 180);
checks.push([`team_spawn returned and members checked in (${Math.round((Date.now() - t0) / 1000)}s)`, spawned]);
printLog();

// 2. crash the orchestrator
orch.kill("SIGKILL");
await sleep(5000);
const aliveAfterCrash = discoverMembers(tracker.dir).filter((f) => f.team === "G-1");
checks.push([`members survive an orchestrator crash (${aliveAfterCrash.map((f) => f.member).join(", ")})`, aliveAfterCrash.length === 2]);

// 3. kill the reviewer too
const reviewer = bus.get("G-1").members.find((x) => x.role === "reviewer")!;
const reviewerPid = aliveAfterCrash.find((f) => f.member === reviewer.name)?.pid;
if (reviewerPid) {
  for (const target of [-reviewerPid, reviewerPid]) {
    try {
      process.kill(target, "SIGKILL");
      break;
    } catch {
      // next form
    }
  }
}
await sleep(2000);
checks.push([`reviewer ${reviewer.name} killed`, !!reviewerPid && !isAlive(reviewerPid)]);

// 4. a fresh orchestrator must reconnect, detect the lost reviewer and recover it
orch = orchestrator(
  "orch-2",
  "You restarted. Team G-1 is working on task G-1 — do not spawn a new team. End your turn now; act on team messages as they arrive: if a member is reported lost, run team_recover; when the reviewer approves, verify the evidence, accept the task (status done) and stop the team with team_stop.",
);
const lostSeen = await waitFor("reviewer marked lost", () => bus.readLog("G-1", 500).some((e) => e.event === "member_lost"), 150);
checks.push(["supervisor marked the reviewer lost", lostSeen]);
const restarted = await waitFor("team_recover restarts the reviewer", () => bus.readLog("G-1", 500).some((e) => e.event === "team_restarted"), 240);
checks.push(["orchestrator ran team_recover and restarted the reviewer", restarted]);
const done = await waitFor("task done", () => {
  printLog();
  return tracker.get("G-1").status === "done";
}, Math.max(60, (deadline - Date.now()) / 1000));
checks.push(["task accepted after recovery", done]);
printLog();

await sleep(15000);
orch.stdin!.end();
await sleep(2000);
orch.kill("SIGTERM");
// clean up any member still running
for (const f of discoverMembers(tracker.dir)) {
  try {
    process.kill(-f.pid, "SIGTERM");
  } catch {
    try {
      process.kill(f.pid, "SIGTERM");
    } catch {
      // gone
    }
  }
}

const task = tracker.get("G-1");
console.log(`\nstatus: ${task.status}`);
console.log(task.history.map((h) => `  ${h.at.slice(11, 19)} ${h.actor} (${h.role}) ${h.event}${h.from ? ` ${h.from}→${h.to}` : ""}`).join("\n"));
console.log("\nchecks:");
for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

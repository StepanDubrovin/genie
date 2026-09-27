// End-to-end check: a real orchestrator (pi in RPC mode) dispatches a headless
// pair team for a trivial task in a throwaway repo and accepts the result.
//
//   node scripts/e2e.ts [--model openai-codex/gpt-6-luna] [--thinking low] [--timeout 900]
//
// Costs real tokens (small). Leaves the temp repo in place for inspection.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { Tracker } from "../src/tracker/store.ts";
import { TeamBus } from "../src/team/bus.ts";
import { installedAsPackage } from "../src/team/spawn.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "openai-codex/gpt-6-luna" },
    thinking: { type: "string", default: "low" },
    timeout: { type: "string", default: "900" },
    template: { type: "string", default: "pair" },
    "analyst-model": { type: "string", default: "openai-codex/gpt-6-sol" },
  },
});

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "genie-e2e-"));
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
fs.writeFileSync(
  path.join(tracker.dir, "config.json"),
  JSON.stringify({ roleModels: { analyst: { model: values["analyst-model"], thinking: values.thinking }, executor: { model: values.model, thinking: values.thinking }, reviewer: { model: values.model, thinking: values.thinking } } }, null, 2),
);
const human = { name: "e2e", role: "human" as const };
tracker.create(human, {
  title: "Add greeting file",
  description: "Create `hello.txt` in the repository root containing exactly the line `hello genie` (with a trailing newline) and commit it on the team branch.",
  acceptance: ["hello.txt exists in the team worktree with exactly `hello genie\\n`", "the change is committed on the team branch"],
});
tracker.setStatus(human, "G-1", "ready");

console.log(`repo: ${repo}`);
const extArgs = installedAsPackage(repo) ? [] : ["-e", path.join(root, "src/extension/index.ts")];
const orch = spawn("pi", ["--mode", "rpc", "--no-session", ...extArgs, "--model", values.model!, "--thinking", values.thinking!], {
  cwd: repo,
  env: { ...process.env, HERDR_ENV: "", GENIE_ROLE: "orchestrator" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
orch.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const ev = JSON.parse(line);
      if (ev.type === "tool_execution_start") console.log(`  [orchestrator] tool ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 160)}`);
      if (ev.type === "response" && !ev.success) console.log(`  [orchestrator] command failed: ${ev.error}`);
    } catch {
      // not JSON
    }
  }
});
orch.stderr.on("data", (c: Buffer) => process.stderr.write(`  [orchestrator stderr] ${c}`));

const prompt = [
  `Task G-1 is ready. Spawn a team for it with team_spawn using template \`${values.template}\` and mode \`headless\`.`,
  "Then end your turn and wait: team members message you automatically.",
  "When the reviewer reports approval, verify the evidence (read the task and the review artifact), accept the task (status done) with a short summary, and stop the team with team_stop (keep the worktree).",
].join(" ");
orch.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: prompt })}\n`);

const bus = new TeamBus(tracker);
const deadline = Date.now() + Number(values.timeout) * 1000;
let lastLog = 0;
let result = "timeout";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const task = tracker.get("G-1");
  if (task.team && bus.exists(task.team)) {
    const log = bus.readLog(task.team, 500);
    for (const e of log.slice(lastLog)) console.log(`  [team] ${String(e.at).slice(11, 19)} ${e.event} ${JSON.stringify({ ...e, at: undefined, event: undefined }).slice(0, 200)}`);
    lastLog = log.length;
  }
  if (task.status === "done") {
    result = "done";
    // give the orchestrator a moment to stop the team
    await new Promise((r) => setTimeout(r, 20000));
    break;
  }
  if (orch.exitCode !== null) {
    result = `orchestrator exited ${orch.exitCode}`;
    break;
  }
}
orch.stdin.end();
await new Promise((r) => setTimeout(r, 3000));
orch.kill("SIGTERM");

const task = tracker.get("G-1");
console.log(`\nresult: ${result}; task status: ${task.status}`);
console.log(task.history.map((h) => `  ${h.at.slice(11, 19)} ${h.actor} (${h.role}) ${h.event}${h.from ? ` ${h.from}→${h.to}` : ""}`).join("\n"));
console.log(`comments: ${task.comments.length}, artifacts: ${task.artifacts.map((a) => `${a.name} (${a.kind})`).join(", ") || "none"}`);
const teams = bus.list({ includeStopped: true });
for (const t of teams) {
  console.log(`team ${t.id}: ${t.state}; worktree ${t.worktree?.path ?? "-"}`);
  for (const m of bus.history(t.id, 100)) console.log(`  mail ${m.from} → ${m.to}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}`);
  if (t.worktree && fs.existsSync(path.join(t.worktree.path, "hello.txt"))) {
    console.log(`  hello.txt: ${JSON.stringify(fs.readFileSync(path.join(t.worktree.path, "hello.txt"), "utf8"))}`);
  }
}
process.exit(result === "done" ? 0 : 1);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findGenieDir } from "../src/tracker/fsutil.ts";
import { canTransition } from "../src/tracker/model.ts";
import { Tracker } from "../src/tracker/store.ts";
import { TeamBus } from "../src/team/bus.ts";

const human = { name: "me", role: "human" as const };
const orch = { name: "orchestrator", role: "orchestrator" as const };
const executor = { name: "executor", role: "executor" as const };
const reviewer = { name: "reviewer", role: "reviewer" as const };
const analyst = { name: "analyst", role: "analyst" as const };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-test-"));
}

function fresh(): Tracker {
  return Tracker.init(path.join(tmp(), ".genie"));
}

test("full lifecycle with role permissions and DoR/DoD gates", () => {
  const t = fresh();
  const task = t.create(orch, { title: "Export", description: "CSV export", acceptance: ["downloads", "tests green"] });
  assert.equal(task.id, "G-1");
  assert.equal(task.status, "draft");

  assert.throws(() => t.setStatus(executor, "G-1", "ready"), /not allowed/);
  t.setStatus(orch, "G-1", "ready");
  t.setStatus(executor, "1", "in_progress");
  assert.throws(() => t.setStatus(executor, "G-1", "approved"), /not allowed/);
  t.setStatus(executor, "G-1", "review", { note: "done" });
  t.setStatus(reviewer, "G-1", "changes_requested", { note: "missing header row" });
  t.setStatus(executor, "G-1", "in_progress");
  t.setStatus(executor, "G-1", "review");
  t.check(reviewer, "G-1", 1);
  t.setStatus(reviewer, "G-1", "approved");

  assert.throws(() => t.setStatus(reviewer, "G-1", "done"), /not allowed/);
  assert.throws(() => t.setStatus(orch, "G-1", "done"), /unchecked acceptance criteria: #2/);
  t.check(reviewer, "G-1", 2);
  const done = t.setStatus(orch, "G-1", "done", { note: "accepted" });
  assert.equal(done.status, "done");
  assert.ok(done.history.some((h) => h.to === "changes_requested"));
  assert.ok(done.comments.some((c) => c.kind === "review"));
});

test("definition of ready requires description and criteria", () => {
  const t = fresh();
  t.create(human, { title: "vague" });
  assert.throws(() => t.setStatus(orch, "G-1", "ready"), /description is empty; no acceptance criteria/);
  assert.equal(t.setStatus(orch, "G-1", "ready", { force: true }).status, "ready");
});

test("split makes an epic, deps gate the ready queue", () => {
  const t = fresh();
  t.create(orch, { title: "Feature", description: "x", acceptance: ["y"] });
  const [a, b] = t.split(orch, "G-1", [{ title: "backend", description: "d", acceptance: ["a"] }, { title: "ui", description: "d", acceptance: ["b"] }]);
  t.update(orch, b.id, { addDeps: [a.id] });
  assert.equal(t.get("G-1").type, "epic");
  assert.deepEqual(t.get("G-1").children, [a.id, b.id]);
  t.setStatus(orch, a.id, "ready");
  t.setStatus(orch, b.id, "ready");
  assert.deepEqual(t.readyQueue().map((x) => x.id), [a.id]);
  assert.throws(() => t.setStatus(executor, b.id, "in_progress"), /depends on unfinished/);
  assert.throws(() => t.setStatus(orch, "G-1", "done"), /unfinished child/);
});

test("field permissions: executor cannot rewrite scope, analyst can plan", () => {
  const t = fresh();
  t.create(orch, { title: "x" });
  assert.throws(() => t.update(executor, "G-1", { description: "sneaky" }), /not allowed/);
  t.update(analyst, "G-1", { plan: "1. do it", addAcceptance: ["works"] });
  t.update(executor, "G-1", { appendNotes: "switched to streaming writer" });
  const task = t.get("G-1");
  assert.equal(task.plan, "1. do it");
  assert.match(task.notes, /executor \(executor\)[\s\S]*streaming writer/);
  assert.throws(() => t.check(executor, "G-1", 1), /not allowed/);
});

test("artifacts live in the database, not in files", () => {
  const t = fresh();
  t.create(orch, { title: "x" });
  const task = t.addArtifact(reviewer, "G-1", { kind: "review", content: "# LGTM", name: "review.md" });
  assert.deepEqual(task.artifacts.map((a) => [a.id, a.name, a.kind]), [[1, "review.md", "review"]]);
  assert.equal(t.readArtifact("G-1", 1).text, "# LGTM");
  t.addArtifact(reviewer, "G-1", { kind: "code", content: "CLASS zcl_x DEFINITION.", name: "zcl_x.clas.abap" });
  assert.equal(t.readArtifact("G-1", 2).kind, "code");
  assert.deepEqual(fs.readdirSync(t.dir).filter((f) => !f.startsWith("genie.db")), []);
});

test("owner inbox and comments wake the orchestrator", () => {
  const t = fresh();
  const bus = new TeamBus(t);
  const task = t.create(human, { title: "From the web", status: "inbox" });
  assert.equal(task.status, "inbox");
  t.comment(human, task.id, "please hurry");
  const mails = bus.receive(undefined, "orchestrator");
  assert.equal(mails.length, 2);
  assert.match(mails[0].text, /New task G-1 in the inbox/);
  assert.equal(t.get(task.id).comments[0].kind, "owner");
  assert.deepEqual(bus.receive(undefined, "orchestrator"), []);
  t.comment(orch, task.id, "on it");
  assert.deepEqual(bus.receive(undefined, "orchestrator"), [], "agent activity does not wake the orchestrator");
});

test("needs_owner keeps the question and the status to return to", () => {
  const t = fresh();
  t.create(orch, { title: "x", description: "d", acceptance: ["a"] });
  t.setStatus(orch, "G-1", "ready");
  assert.throws(() => t.setStatus(orch, "G-1", "needs_owner"), /requires a note/);
  assert.throws(() => t.setStatus(executor, "G-1", "needs_owner", { note: "?" }), /not allowed/);
  const events: string[] = [];
  t.onEvent((e) => events.push(`${e.from}->${e.to}`));
  const waiting = t.setStatus(orch, "G-1", "needs_owner", { note: "Keep ZPR1?" });
  assert.deepEqual([waiting.needsOwner?.question, waiting.needsOwner?.previous], ["Keep ZPR1?", "ready"]);
  assert.deepEqual(events, ["ready->needs_owner"]);
  assert.equal(t.list({ status: ["needs_owner"] })[0].needsOwner?.question, "Keep ZPR1?");
  const back = t.setStatus(orch, "G-1", "ready");
  assert.equal(back.needsOwner, undefined);
});

test("optional artifact gates", () => {
  const t = fresh();
  t.create(orch, { title: "x", description: "d", acceptance: ["a"] });
  t.setStatus(orch, "G-1", "ready");
  t.setStatus(executor, "G-1", "in_progress");
  t.setStatus(executor, "G-1", "review");
  t.setStatus(reviewer, "G-1", "changes_requested");
  t.setStatus(executor, "G-1", "in_progress");
  t.gates = { requireTestReport: true, requireReviewArtifact: true };
  assert.throws(() => t.setStatus(executor, "G-1", "review"), /test-report/);
  t.addArtifact(executor, "G-1", { kind: "test-report", content: "ok" });
  t.setStatus(executor, "G-1", "review");
  assert.throws(() => t.setStatus(reviewer, "G-1", "approved"), /review artifact/);
});

test("worktrees resolve the tracker of the main checkout", () => {
  const repo = tmp();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  Tracker.init(path.join(repo, ".genie"));
  const wt = path.join(tmp(), "wt");
  git("worktree", "add", "-q", "-b", "feature", wt);
  const saved = process.env.GENIE_DIR;
  delete process.env.GENIE_DIR;
  try {
    assert.equal(fs.realpathSync(findGenieDir(wt)!), fs.realpathSync(path.join(repo, ".genie")));
  } finally {
    if (saved !== undefined) process.env.GENIE_DIR = saved;
  }
  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.genie\/$/m);
});

test("concurrent writers do not lose updates", async () => {
  const t = fresh();
  t.create(orch, { title: "x" });
  const script = `
    import { Tracker } from ${JSON.stringify(path.resolve("src/tracker/store.ts"))};
    const t = new Tracker(process.argv[1]);
    for (let i = 0; i < 20; i++) t.comment({ name: "w" + process.argv[2], role: "executor" }, "G-1", "c" + i);
  `;
  const { spawn } = await import("node:child_process");
  await Promise.all(
    [1, 2, 3, 4].map(
      (n) =>
        new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, ["--input-type=module", "-e", script, t.dir, String(n)], { stdio: "inherit" });
          p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}`))));
        }),
    ),
  );
  assert.equal(t.get("G-1").comments.length, 80);
});

test("orchestrator needs force to fake the team's verdict", () => {
  const t = fresh();
  t.create(orch, { title: "x", description: "d", acceptance: ["a"] });
  t.setStatus(orch, "G-1", "ready");
  t.setStatus(executor, "G-1", "in_progress");
  assert.throws(() => t.setStatus(orch, "G-1", "review"), /team's verdicts/);
  assert.equal(t.setStatus(orch, "G-1", "review", { force: true }).status, "review");
  assert.throws(() => t.setStatus(executor, "G-1", "approved", { force: true }), /not allowed/);
});

test("transition table sanity", () => {
  assert.ok(canTransition("analyst", "draft", "refining"));
  assert.ok(!canTransition("analyst", "refining", "ready"));
  assert.ok(canTransition("orchestrator", "approved", "done"));
  assert.ok(!canTransition("orchestrator", "in_progress", "review"));
  assert.ok(!canTransition("orchestrator", "review", "approved"));
  assert.ok(canTransition("human", "review", "approved"));
  assert.ok(!canTransition("executor", "review", "approved"));
});

test("mailboxes: direct, broadcast, exactly-once receive", () => {
  const t = fresh();
  const bus = new TeamBus(t);
  const at = new Date().toISOString();
  const member = (name: string, role: "analyst" | "executor" | "reviewer") => ({ name, role, status: "starting", statusAt: at, state: "starting" as const });
  bus.create({ id: "G-1", task: "G-1", cwd: "/tmp", members: [member("analyst", "analyst"), member("executor", "executor"), member("reviewer", "reviewer")] });
  bus.send({ team: "G-1", from: "analyst", fromRole: "analyst", to: "executor", text: "plan is ready" });
  bus.send({ team: "G-1", from: "executor", fromRole: "executor", to: "all", text: "starting" });
  assert.throws(() => bus.send({ team: "G-1", from: "x", fromRole: "x", to: "nobody", text: "?" }), /no member "nobody"/);

  assert.deepEqual(bus.receive("G-1", "executor").map((m) => m.text), ["plan is ready"]);
  assert.deepEqual(bus.receive("G-1", "executor"), []);
  assert.deepEqual(bus.receive("G-1", "reviewer").map((m) => m.text), ["starting"]);
  assert.deepEqual(bus.receive("G-1", "orchestrator").map((m) => m.from), ["executor"]);
  assert.equal(bus.pending("G-1", "analyst"), 1);

  bus.setStatus("G-1", "executor", "implementing");
  assert.equal(bus.get("G-1").members.find((m) => m.name === "executor")!.status, "implementing");
  assert.equal(bus.freeId("G-1"), "G-1b");
  assert.ok(bus.readLog("G-1").some((e) => e.event === "mail"));
});

test("members get unique playful names shown as 'Name — role'", async () => {
  const { assignNames, memberLabel, initial } = await import("../src/team/names.ts");
  const taken = new Set(["sherlock"]);
  const named = assignNames([{ role: "analyst" as const }, { role: "analyst" as const }, { role: "executor" as const, name: "walle" }], taken);
  const names = named.map((m) => m.name);
  assert.equal(new Set(names).size, 3);
  assert.ok(!names.slice(0, 2).includes("sherlock"), "names already used by active teams are skipped");
  assert.equal(names[2], "walle", "explicit names are kept");
  assert.equal(memberLabel("walle", "executor"), "WALL-E — исполнитель");
  assert.equal(memberLabel("gandalf", "reviewer", "en"), "Gandalf — reviewer");
  assert.equal(memberLabel("analyst", "analyst"), "Аналитик", "legacy role-like names show the role only");
  assert.equal(initial("baymax", "executor"), "B");
  const exhausted = assignNames([{ role: "tester" as const }], new Set(["murphy", "gremlin", "loki", "jinx", "chaos", "moriarty"]));
  assert.equal(exhausted[0].name, "murphy2");
});

test("heartbeats revive lost members and accidentally stopped teams; mail keeps flowing", () => {
  const t = fresh();
  const bus = new TeamBus(t);
  const at = new Date().toISOString();
  bus.create({ id: "G-1", task: "G-1", cwd: "/tmp", members: [{ name: "bender", role: "executor", status: "starting", statusAt: at, state: "starting" }] });
  bus.setState("G-1", "stopped", "launch_failed");
  bus.send({ team: "G-1", from: "bender", fromRole: "executor", to: "orchestrator", text: "I am actually running" });
  assert.equal(bus.receive(undefined, "orchestrator").length, 1, "mail from a team that looked dead still reaches the orchestrator");

  const r = bus.heartbeat("G-1", "bender", 4242);
  assert.deepEqual(r, { revived: false, teamRevived: true });
  const team = bus.get("G-1");
  assert.equal(team.state, "active");
  assert.equal(team.members[0].state, "active");
  assert.equal(team.members[0].runtime?.pid, 4242);
  assert.ok(team.members[0].heartbeatAt);

  bus.markLost("G-1", "bender", "no heartbeat");
  assert.equal(bus.get("G-1").members[0].state, "lost");
  assert.equal(bus.heartbeat("G-1", "bender").revived, true);
  assert.ok(bus.readLog("G-1").some((e) => e.event === "member_recovered"));

  bus.setState("G-1", "stopped", "orchestrator");
  bus.send({ team: "G-1", from: "bender", fromRole: "executor", to: "orchestrator", text: "late" });
  assert.equal(bus.receive(undefined, "orchestrator").length, 0, "a team stopped on purpose is silenced");
  assert.equal(bus.heartbeat("G-1", "bender").teamRevived, false, "and is not revived by a straggler");
  assert.deepEqual(bus.recoverable().map((x) => x.id), []);
});

test("discoverMembers finds member processes by label and tracker dir", async () => {
  const { discoverMembers, parseEnviron } = await import("../src/team/spawn.ts");
  assert.deepEqual(parseEnviron("A=1\0B=x=y\0"), { A: "1", B: "x=y" });
  const t = fresh();
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "--", "--name", "G-9:baymax"], {
    env: { ...process.env, GENIE_DIR: t.dir, GENIE_TEAM: "G-9", GENIE_MEMBER: "baymax" },
    stdio: "ignore",
  });
  const decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { env: { ...process.env, GENIE_DIR: t.dir, GENIE_TEAM: "G-9", GENIE_MEMBER: "yoda" }, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const found = discoverMembers(t.dir);
    assert.deepEqual(found.map((f) => [f.team, f.member, f.pid]), [["G-9", "baymax", child.pid]], "only labelled processes of this tracker count");
  } finally {
    child.kill();
    decoy.kill();
  }
});

test("team ops: remove member, reap teams of closed tasks, stop and delete", async () => {
  const { removeMember, reapClosedTeams, deleteTeam, stopTeam } = await import("../src/team/ops.ts");
  const { spawn } = await import("node:child_process");
  const t = fresh();
  const bus = new TeamBus(t);
  const fake = (team: string, member: string) =>
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", "--name", `${team}:${member}`], {
      env: { ...process.env, GENIE_DIR: t.dir, GENIE_TEAM: team, GENIE_MEMBER: member },
      stdio: "ignore",
      detached: true,
    });
  const exited = (p: ReturnType<typeof fake>) => new Promise<boolean>((resolve) => (p.exitCode !== null || p.signalCode !== null ? resolve(true) : p.once("exit", () => resolve(true))));
  const at = new Date().toISOString();
  t.create(orch, { title: "one", description: "d", acceptance: ["a"] });
  t.create(orch, { title: "two", description: "d", acceptance: ["a"] });
  const p1 = fake("G-1", "bender");
  const p2 = fake("G-1", "yoda");
  const p3 = fake("G-2", "sherlock");
  const member = (name: string, role: "executor" | "reviewer" | "analyst", pid?: number) => ({ name, role, status: "working", statusAt: at, state: "active" as const, runtime: { kind: "headless" as const, pid } });
  bus.create({ id: "G-1", task: "G-1", cwd: "/tmp", members: [member("bender", "executor", p1.pid), member("yoda", "reviewer", p2.pid)] });
  bus.create({ id: "G-2", task: "G-2", cwd: "/tmp", members: [member("sherlock", "analyst", p3.pid)] });
  t.assignTeam(orch, "G-1", "G-1");
  t.assignTeam(orch, "G-2", "G-2");

  await removeMember(t, bus, "G-1", "yoda", "owner");
  assert.ok(await exited(p2), "removed member process is stopped");
  assert.deepEqual(bus.get("G-1").members.map((m) => m.name), ["bender"]);
  assert.match(bus.receive("G-1", "bender")[0].text, /Yoda — reviewer left the team/);

  t.setStatus(human, "G-1", "done", { force: true });
  assert.deepEqual(await reapClosedTeams(t, bus), ["G-1"]);
  assert.ok(await exited(p1), "the team of a closed task is stopped");
  assert.equal(bus.get("G-1").stopReason, "task_closed");
  bus.send({ team: "G-1", from: "bender", fromRole: "executor", to: "orchestrator", text: "late" });
  assert.equal(bus.receive(undefined, "orchestrator").filter((m) => m.team === "G-1").length, 0, "a reaped team is silenced");
  assert.deepEqual(await reapClosedTeams(t, bus), [], "open tasks keep their teams");

  const report = await stopTeam(t, bus, "G-2", { reason: "owner", by: "me" });
  assert.ok(await exited(p3));
  assert.ok(report.some((l) => /G-2 released/.test(l)), "an open task is released");
  assert.equal(t.get("G-2").team, undefined);
  assert.ok(bus.receive(undefined, "orchestrator").some((m) => /owner stopped team G-2/.test(m.text)));
  await deleteTeam(t, bus, "G-2", { by: "me" });
  assert.equal(bus.exists("G-2"), false);
  assert.equal(bus.history("G-2").length, 0);
});

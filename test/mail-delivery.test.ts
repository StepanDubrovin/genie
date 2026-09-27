// Mail levels/intents, claim-at-delivery, urgent-only steering and the
// orchestrator digest (G-6). The extension module is never imported here: the
// delivery rule lives on TeamBus (takeMail) and the digest in a pure module.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MAIL_INTENTS, MAIL_LEVELS, type Mail, TeamBus } from "../src/team/bus.ts";
import { rankIntent, renderDigest } from "../src/team/digest.ts";
import { Tracker } from "../src/tracker/store.ts";
import { createWebApp, type WebApp } from "../src/web/server.ts";

const ORCH = "orchestrator";
const at = "2026-09-27T14:00:00.000Z";
const member = (name: string, role: "analyst" | "executor" | "reviewer" | "tester") => ({ name, role, status: "starting", statusAt: at, state: "starting" as const });

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-mail-"));
}

function fresh(): { t: Tracker; bus: TeamBus } {
  const t = Tracker.init(path.join(tmp(), ".genie"));
  return { t, bus: new TeamBus(t) };
}

function setup(): { t: Tracker; bus: TeamBus } {
  const { t, bus } = fresh();
  bus.create({ id: "G-1", task: "G-1", cwd: "/tmp", members: [member("walle", "executor"), member("yoda", "reviewer")] });
  return { t, bus };
}

function mail(p: Partial<Mail> & { id: number; team: string; from: string }): Mail {
  const level = p.level ?? "normal";
  return {
    at,
    fromRole: "executor",
    to: ORCH,
    text: "x",
    kind: "message",
    ...p,
    level,
    urgent: level === "high",
  };
}

test("levels, the urgent alias and the safe defaults", () => {
  const { t, bus } = setup();
  const send = (extra: Record<string, unknown> = {}) => bus.send({ team: "G-1", from: "walle", fromRole: "executor", to: ORCH, text: "hi", ...extra })[0];

  assert.equal(send({ urgent: true }).level, "high", "urgent: true is an alias for high");
  assert.equal(send({ urgent: true }).urgent, true);
  assert.equal(send().level, "normal", "an omitted level keeps today's follow-up behaviour");
  assert.equal(send().urgent, false);
  assert.equal(send({ level: "low", intent: "fyi" }).level, "low");
  assert.equal(send({ level: "low", intent: "fyi" }).intent, "fyi");
  assert.equal(send({ level: "high" }).urgent, true);
  assert.equal(send({ level: "low", urgent: true }).level, "low", "an explicit level wins over the urgent alias");

  assert.throws(() => send({ level: "bogus" }), /invalid mail level/);
  assert.throws(() => send({ intent: "bogus" }), /invalid mail intent/);
  assert.deepEqual([...MAIL_LEVELS], ["low", "normal", "high"]);
  assert.deepEqual([...MAIL_INTENTS], ["question", "blocker", "verdict", "done", "fyi"]);

  // The `urgent` column is kept in sync so older readers (web, older genie) still work.
  const rows = t.db.all<{ id: number; level: string; urgent: number }>("SELECT id, level, urgent FROM mail ORDER BY id");
  assert.ok(rows.every((r) => r.urgent === (r.level === "high" ? 1 : 0)), "urgent and level agree on every row");
});

test("legacy rows without level/intent migrate and still deliver", () => {
  const dir = path.join(tmp(), ".genie");
  const t = Tracker.init(dir);
  const bus = new TeamBus(t);
  bus.create({ id: "G-1", task: "G-1", cwd: "/tmp", members: [member("walle", "executor")] });

  // Simulate a database written before schema v3: the columns do not exist yet and
  // the old writer only knows the boolean `urgent`.
  t.db.exec("ALTER TABLE mail DROP COLUMN level");
  t.db.exec("ALTER TABLE mail DROP COLUMN intent");
  assert.deepEqual(t.db.all<{ name: string }>("PRAGMA table_info(mail)").map((c) => c.name).filter((n) => n === "level" || n === "intent"), []);
  const insert = (urgent: number) =>
    t.db.run("INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, kind, task) VALUES ('G-1', ?, 'walle', 'executor', ?, ?, ?, 'message', 'G-1')", at, ORCH, urgent ? "legacy urgent" : "legacy normal", urgent);
  insert(1);
  insert(0);

  // Re-opening runs the migration: level/intent are added, urgent rows become high.
  const t2 = new Tracker(dir);
  const bus2 = new TeamBus(t2);
  const received = bus2.receive(undefined, ORCH);
  assert.deepEqual(received.map((m) => [m.text, m.level, m.urgent, m.intent]), [
    ["legacy urgent", "high", true, undefined],
    ["legacy normal", "normal", false, undefined],
  ]);
  assert.deepEqual(bus2.receive(undefined, ORCH), [], "still exactly once");
  t2.db.close();
  t.db.close();
});

test("claim at delivery time: nothing while busy, the whole slice once idle", () => {
  const { bus } = setup();
  for (const text of ["one", "two", "three"]) bus.send({ team: "G-1", from: "walle", fromRole: "executor", to: ORCH, text });

  const busy = bus.takeMail(undefined, ORCH, false);
  assert.deepEqual([busy.batch, busy.steers], [[], []], "no mail is claimed while the session is busy");
  assert.equal(bus.pending("G-1", ORCH), 3, "unread rows stay unread");

  const idle = bus.takeMail(undefined, ORCH, true);
  assert.deepEqual(idle.batch.map((m) => m.text), ["one", "two", "three"], "one receive takes the whole slice in order");
  assert.deepEqual(idle.steers, []);
  assert.equal(bus.pending("G-1", ORCH), 0);
  assert.deepEqual(bus.takeMail(undefined, ORCH, true), { batch: [], steers: [] }, "exactly once");
});

test("unclaimed mail survives a restart and is delivered later", () => {
  const { t, bus } = setup();
  bus.send({ team: "G-1", from: "walle", fromRole: "executor", to: ORCH, text: "persisted" });
  assert.deepEqual(bus.takeMail(undefined, ORCH, false).batch, []);

  // A fresh process on the same database still sees the unclaimed row.
  const reopened = new TeamBus(new Tracker(t.dir));
  assert.deepEqual(reopened.takeMail(undefined, ORCH, true).batch.map((m) => m.text), ["persisted"]);
});

test("urgent is the only mail claimed while busy and it steers on its own", () => {
  const { bus } = setup();
  bus.send({ team: "G-1", from: "walle", fromRole: "executor", to: ORCH, text: "slow" });
  bus.send({ team: "G-1", from: "yoda", fromRole: "reviewer", to: ORCH, text: "urgent one", urgent: true });
  bus.send({ team: "G-1", from: "walle", fromRole: "executor", to: ORCH, text: "slow two" });

  const busy = bus.takeMail(undefined, ORCH, false);
  assert.deepEqual(busy.batch, [], "normal mail is not merged into the busy path");
  assert.deepEqual(busy.steers.map((m) => m.text), ["urgent one"]);
  assert.equal(bus.pending("G-1", ORCH), 2, "the two normal rows are still unclaimed");

  const idle = bus.takeMail(undefined, ORCH, true);
  assert.deepEqual(idle.batch.map((m) => m.text), ["slow", "slow two"], "the urgent row is not delivered twice");
  assert.deepEqual(idle.steers, []);
});

test("hasUrgent peeks without claiming", () => {
  const { bus } = setup();
  bus.send({ team: "G-1", from: "walle", fromRole: "executor", to: ORCH, text: "normal" });
  assert.equal(bus.hasUrgent(undefined, ORCH), false);
  assert.equal(bus.pending("G-1", ORCH), 1, "peeking does not claim");

  bus.send({ team: "G-1", from: "yoda", fromRole: "reviewer", to: ORCH, text: "urgent", level: "high" });
  assert.equal(bus.hasUrgent(undefined, ORCH), true);
  assert.equal(bus.pending("G-1", ORCH), 2);
  assert.deepEqual(bus.receiveUrgent(undefined, ORCH).map((m) => m.text), ["urgent"]);
  assert.equal(bus.pending("G-1", ORCH), 1, "receiveUrgent leaves normal mail alone");
});

test("members obey the same claim-at-delivery rule", () => {
  const { bus } = setup();
  bus.send({ team: "G-1", from: "yoda", fromRole: "reviewer", to: "walle", text: "review notes" });
  assert.deepEqual(bus.takeMail("G-1", "walle", false).batch, []);
  assert.equal(bus.pending("G-1", "walle"), 1);
  assert.deepEqual(bus.takeMail("G-1", "walle", true).batch.map((m) => m.text), ["review notes"]);
});

test("a row written by an older process (urgent only) reads as high", () => {
  const { t, bus } = setup();
  // `urgent = 1` with a stale/default level must win on read.
  t.db.run("INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, level, kind, task) VALUES ('G-1', ?, 'walle', 'executor', ?, 'old writer', 1, 'normal', 'message', 'G-1')", at, ORCH);
  const [m] = bus.receive(undefined, ORCH);
  assert.equal(m.level, "high");
  assert.equal(m.urgent, true);
});

test("digest: grouped by team, one line per sender, ordered by importance", () => {
  const mails: Mail[] = [
    mail({ id: 1, team: "G-7", from: "ada", fromRole: "analyst", intent: "question", text: "Need ZPR1?" }),
    mail({ id: 2, team: "G-7", from: "bender", text: "working on it" }),
    mail({ id: 3, team: "G-7", from: "bender", intent: "done", text: "done, tests green" }),
    mail({ id: 4, team: "G-7", from: "cindy", fromRole: "reviewer", level: "low", intent: "fyi", text: "note: docs updated" }),
    mail({ id: 5, team: "G-9", from: "dave", fromRole: "reviewer", level: "high", intent: "verdict", text: "LGTM" }),
    mail({ id: 6, team: "G-12", from: "erin", fromRole: "tester", level: "low", intent: "fyi", text: "FYI only" }),
  ];
  assert.equal(
    renderDigest(mails),
    [
      "[genie digest · 6 messages from 3 teams]",
      "",
      "## G-7 (2)",
      "- ada (analyst) · normal · question · Need ZPR1?",
      "- bender (executor) · normal · done · done, tests green",
      "",
      "## G-9 (1)",
      "- dave (reviewer) · high · verdict · LGTM",
      "",
      "## FYI",
      "- cindy (reviewer) · low · fyi · note: docs updated",
      "- erin (tester) · low · fyi · FYI only",
    ].join("\n"),
  );
});

test("digest: a standing-by team outranks a later verdict; unclassified sits in between", () => {
  const mails: Mail[] = [
    mail({ id: 10, team: "A", from: "a", intent: "done", text: "done" }),
    mail({ id: 11, team: "B", from: "b", intent: "blocker", text: "stuck" }),
    mail({ id: 12, team: "C", from: "c", text: "no intent" }),
    mail({ id: 13, team: "D", from: "d", intent: "fyi", text: "just so you know" }),
  ];
  const out = renderDigest(mails);
  const order = ["## B", "## A", "## C", "## FYI"].map((h) => out.indexOf(h));
  assert.ok(order.every((i) => i >= 0), `all sections present: ${out}`);
  assert.deepEqual([...order].sort((x, y) => x - y), order, "blocker → done → unclassified → FYI");
  assert.equal(rankIntent("question"), 0);
  assert.equal(rankIntent("blocker"), 0);
  assert.equal(rankIntent("verdict"), 1);
  assert.equal(rankIntent("done"), 1);
  assert.equal(rankIntent(undefined), 2);
  assert.equal(rankIntent("fyi"), 3);
});

test("digest: a sender whose latest mail is an FYI appears only in the FYI line", () => {
  const mails: Mail[] = [
    // walle sent a real update first, then only an FYI: the latest mail decides.
    mail({ id: 1, team: "G-7", from: "walle", intent: "done", text: "shipped" }),
    mail({ id: 2, team: "G-7", from: "walle", intent: "fyi", level: "low", text: "just a note" }),
    mail({ id: 3, team: "G-7", from: "yoda", intent: "verdict", text: "LGTM" }),
  ];
  const out = renderDigest(mails);
  assert.equal(out.match(/walle/g)?.length, 1, `walle appears exactly once:\n${out}`);
  assert.equal((out.match(/## G-7/g) ?? []).length, 1);
  assert.equal((out.match(/## FYI/g) ?? []).length, 1, "the FYI section holds the sender");
  assert.ok(out.indexOf("## G-7 (1)") >= 0, `the team section counts only its own row:\n${out}`);
  assert.ok(out.indexOf("- walle (executor) · low · fyi · just a note") > out.indexOf("## FYI"), "walle is printed under FYI");
  assert.ok(!out.includes("shipped"), "the earlier, superseded mail does not resurface");
});

test("the web send route accepts, validates and forwards level and intent", async () => {
  // A real open task keeps the reaper from stopping the team of a missing task.
  const { t, bus } = fresh();
  const task = t.create({ name: "owner", role: "human" }, { title: "web mail" });
  bus.create({ id: "G-1", task: task.id, cwd: "/tmp", members: [member("walle", "executor"), member("yoda", "reviewer")] });
  bus.receive(undefined, ORCH); // drain the task's owner-inbox notification
  let app: WebApp | undefined;
  const server = http.createServer((req, res) => void app!.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  app = createWebApp(t, { port });
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/teams/G-1/mail`, { method: "POST", headers: { "content-type": "application/json", "x-genie": "1" }, body: JSON.stringify(body) });
  try {
    // Both values travel from the browser through the route into the mail row.
    assert.equal((await post({ to: "orchestrator", text: "from the browser", level: "high", intent: "fyi" })).status, 201);
    const [carried] = bus.receive(undefined, ORCH);
    assert.equal(carried.level, "high");
    assert.equal(carried.intent, "fyi");
    assert.equal(carried.fromRole, "human");
    assert.match(carried.from, /^owner \(/);

    // A missing level is backwards compatible: normal, no intent.
    assert.equal((await post({ to: "orchestrator", text: "default" })).status, 201);
    const [fallback] = bus.receive(undefined, ORCH);
    assert.equal(fallback.level, "normal");
    assert.equal(fallback.intent, undefined);

    // The documented legacy alias survives: `urgent: true` without a level is high.
    assert.equal((await post({ to: "orchestrator", text: "legacy urgent", urgent: true })).status, 201);
    const [legacy] = bus.receive(undefined, ORCH);
    assert.equal(legacy.level, "high");
    assert.equal(legacy.urgent, true);

    // Bad values are rejected at the route (400), not stored.
    assert.equal((await post({ to: "orchestrator", text: "nope", level: "bogus" })).status, 400);
    assert.equal((await post({ to: "orchestrator", text: "nope", intent: "bogus" })).status, 400);
    assert.equal(bus.pending("G-1", ORCH), 0, "nothing invalid was written");
  } finally {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.db.close();
  }
});

test("digest ignores non-message kinds and is empty without messages", () => {
  const kickoff = { ...mail({ id: 1, team: "G-1", from: ORCH }), kind: "kickoff" as const };
  assert.equal(renderDigest([kickoff]), "");
});

// People in the web: who can be responsible for a task, and the "my tasks" view.

import assert from "node:assert/strict";
import { test } from "node:test";
import { doctorSummary, hoursText, initials, type Membership, responsibleChoices } from "../web/src/entities/project/model.ts";
import { inViewOf, type TaskSummary } from "../web/src/entities/task/model.ts";

const person = (login: string, name = "", disabled = false) => ({ id: login.length, login, name, isAdmin: false, disabled, created: "" });

test("people who can be responsible: members who write, the current one kept", () => {
  const members: Membership[] = [
    { user: person("anna", "Анна"), role: "admin" },
    { user: person("vic"), role: "viewer" },
    { user: person("gone", "", true), role: "member" },
    { user: person("boris"), role: "member" },
  ];
  assert.deepEqual(
    responsibleChoices(members).map((c) => c.label),
    ["Анна (@anna)", "@boris"],
    "viewers and disabled people are not offered",
  );
  assert.deepEqual(
    responsibleChoices(members, "gone").map((c) => c.login),
    ["gone", "anna", "boris"],
    "the person responsible stays visible after they left",
  );
  assert.equal(initials("Анна Петрова"), "АП");
  assert.equal(initials("boris"), "BO");
});

test("my tasks: the ones I am responsible for, finished ones for a week", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const task = (status: TaskSummary["status"], assignee?: string, updated = "2026-09-28T12:00:00Z") => ({ status, assignee, updated }) as TaskSummary;
  assert.equal(inViewOf(task("in_progress", "anna"), "mine", "anna", now), true);
  assert.equal(inViewOf(task("needs_owner", "anna"), "mine", "anna", now), true);
  assert.equal(inViewOf(task("in_progress", "boris"), "mine", "anna", now), false);
  assert.equal(inViewOf(task("in_progress", "anna"), "mine", undefined, now), false, "nobody is responsible in the local mode");
  assert.equal(inViewOf(task("done", "anna"), "mine", "anna", now), true);
  assert.equal(inViewOf(task("done", "anna", "2026-09-01T00:00:00Z"), "mine", "anna", now), false);
  assert.equal(inViewOf(task("cancelled", "anna"), "mine", "anna", now), false);
  assert.equal(inViewOf(task("review"), "active", undefined, now), true, "other views go by status only");
});

test("the server page speaks in words: hours and readiness", () => {
  assert.equal(hoursText(null), "—");
  assert.equal(hoursText(0.25), "15 мин");
  assert.equal(hoursText(5.5), "5,5 ч");
  assert.equal(hoursText(72), "3,0 дн");
  assert.deepEqual(doctorSummary([{ area: "web", level: "ok", text: "" }]), { level: "ok", text: "Всё готово" });
  assert.deepEqual(
    doctorSummary([
      { area: "pi", level: "fail", text: "" },
      { area: "channels", level: "warn", text: "" },
    ]),
    { level: "fail", text: "Нужно исправить: 1, предупреждений: 1" },
  );
});

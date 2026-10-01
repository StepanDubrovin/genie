// The plan of an idea: how the planner's plan.json is read and what the person files from it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLabel, parsePlan, planToApply } from "../web/src/features/shape-idea/model.ts";

const plan = {
  summary: "Остатки с телефона",
  epic: { title: "Пополнение с телефона", goal: "Кладовщик заказывает сам", criteria: ["заявка не теряется", " "] },
  tasks: [
    { key: "t1", title: "Экран ячейки", criteria: ["видно остатки"] },
    { key: "t2", title: "Заявка", deps: ["t1"], type: "bug" },
    { title: "Утверждение", deps: ["t2"], type: "epic" },
  ],
  questions: ["Этикетки?"],
};

test("a plan reads leniently: fences, missing keys, unknown types", () => {
  const p = parsePlan("```json\n" + JSON.stringify(plan) + "\n```");
  assert.ok(p);
  assert.equal(p.epic?.title, "Пополнение с телефона");
  assert.deepEqual(p.epic?.criteria, ["заявка не теряется"], "empty criteria dropped");
  assert.equal(p.tasks[2].key, "t3", "a task without a key gets its place");
  assert.equal(p.tasks[1].type, "bug");
  assert.equal(p.tasks[2].type, "task", "an epic is never a task of the plan");
  assert.deepEqual(p.assumptions, []);
  assert.deepEqual(p.questions, ["Этикетки?"]);
});

test("no usable plan: not JSON or no task with a title", () => {
  assert.equal(parsePlan(undefined), undefined);
  assert.equal(parsePlan("План: сделать всё"), undefined);
  assert.equal(parsePlan(JSON.stringify({ tasks: [{ title: " " }] })), undefined);
  assert.equal(parsePlan(JSON.stringify({ epic: null, tasks: [{ title: "a" }] }))?.epic, undefined);
});

test("unticked tasks stay out, and so do dependencies on them", () => {
  const p = parsePlan(JSON.stringify(plan))!;
  const out = planToApply(p, new Set(["t2"]));
  assert.deepEqual(
    out.tasks.map((t) => [t.key, t.deps]),
    [
      ["t1", []],
      ["t3", []],
    ],
  );
  assert.equal(out.epic?.title, "Пополнение с телефона");
});

test("the button says what will be filed", () => {
  assert.equal(applyLabel(true, 4), "Завести эпик и 4 задачи");
  assert.equal(applyLabel(true, 5), "Завести эпик и 5 задач");
  assert.equal(applyLabel(true, 1), "Завести эпик и 1 задачу");
  assert.equal(applyLabel(false, 1), "Завести задачу");
  assert.equal(applyLabel(false, 2), "Завести 2 задачи");
});

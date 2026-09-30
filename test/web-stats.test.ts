// Server statistics in the web: several projects' days and counts added up for the charts and tiles.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type ProjectStats, statsTotals, sumDays } from "../web/src/entities/project/model.ts";

const day = (d: string, created: number, done: number, runs = 0, runsFailed = 0) => ({ day: d, created, done, runs, runsFailed });

test("the days of several projects add up day by day, oldest first", () => {
  const shop = { daily: [day("2026-09-29", 2, 1, 10, 1), day("2026-09-30", 1, 0, 4)] };
  const wms = { daily: [day("2026-09-30", 3, 2, 6, 2), day("2026-09-29", 0, 1)] };
  assert.deepEqual(sumDays([shop, wms]), [day("2026-09-29", 2, 2, 10, 1), day("2026-09-30", 4, 2, 10, 2)]);
  assert.deepEqual(sumDays([]), []);
  assert.deepEqual(sumDays([{ daily: undefined as unknown as [] }]), [], "an older server sends no days");
});

test("the counts add up, and projects with open tasks are counted", () => {
  const p = (open: number, done: number) => ({ created: 3, createdByPeople: 2, done, open, decisions: 1, returns: 0, runs: 5, runsFailed: 1 }) as ProjectStats;
  const t = statsTotals([p(4, 2), p(0, 1)]);
  assert.deepEqual(t, { created: 6, createdByPeople: 4, done: 3, open: 4, decisions: 2, returns: 0, runs: 10, runsFailed: 2, openProjects: 1 });
});

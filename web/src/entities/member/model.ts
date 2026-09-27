// UI-side view of team members. Types come straight from the server code, so the
// API contract is checked by the compiler on both sides.

import type { Activity, Member } from "../../../../src/team/bus.ts";
import type { MemberRole } from "../../../../src/tracker/model.ts";

export type { Activity, Member, MemberRole };

export { displayName, initial, memberLabel, ROLE_TITLE_RU } from "../../../../src/team/names.ts";

export const ROLE_LETTER: Record<string, string> = { analyst: "A", executor: "E", reviewer: "R", tester: "T", documenter: "D", orchestrator: "O", human: "Я" };

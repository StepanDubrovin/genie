// The decision box of a task waiting for the owner: what the buttons send and when the merge waits.

import assert from "node:assert/strict";
import { test } from "node:test";
import { answerText, cardKind, mergeHeld } from "../web/src/features/owner-decision/model.ts";

test("a picked option goes first, the words after it", () => {
  assert.equal(answerText("Сохранять", ""), "Выбран вариант: «Сохранять»");
  assert.equal(answerText("Сохранять", "  до 30 дней "), "Выбран вариант: «Сохранять»\n\nдо 30 дней");
  assert.equal(answerText(undefined, " CSV "), "CSV");
  assert.equal(answerText(undefined, "  "), "", "nothing to send");
});

test("an action this web does not know shows as a plain question", () => {
  assert.equal(cardKind({ kind: "ask-owner-question" }), "ask-owner-question");
  assert.equal(cardKind({ kind: "ask-for-merge-pr" }), "ask-for-merge-pr");
  assert.equal(cardKind({ kind: "ask-free-form" }), undefined);
  assert.equal(cardKind({ kind: "ask-doc-change" }), undefined, "a kind from a newer server");
  assert.equal(cardKind(undefined), undefined);
});

test("the merge button waits for what the policy asks and says why", () => {
  assert.equal(mergeHeld("api", "open", "passed", true), undefined);
  assert.equal(mergeHeld("api", "open", "none", true), undefined, "no checks on the host: the server decides");
  assert.match(mergeHeld("api", "open", "pending", true) ?? "", /политика api ждёт зелёных проверок, а они ещё идут/);
  assert.match(mergeHeld("api", "open", "failed", true) ?? "", /упали/);
  assert.equal(mergeHeld("api", "open", "failed", false), undefined, "checks are not required here");
  assert.equal(mergeHeld("api", "merged", "passed", true), "Запрос уже слит.");
  assert.equal(mergeHeld("api", "closed", "passed", true), "Запрос закрыт на хостинге.");
});

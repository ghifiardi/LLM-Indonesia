import test from "node:test";
import assert from "node:assert/strict";
import { createHistory } from "../src/chat/history.js";

test("keeps turns in order", () => {
  const h = createHistory({ maxChars: 1000 });
  h.add("user", "halo");
  h.add("assistant", "hai");
  assert.deepEqual(h.toMessages(), [
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai" }
  ]);
});

test("drops oldest turns beyond cap, never splits a turn", () => {
  const h = createHistory({ maxChars: 10 });
  h.add("user", "aaaaaa");   // 6
  h.add("assistant", "bbbb"); // 4 → total 10, both fit
  h.add("user", "cc");        // pushes total to 12 → drop oldest
  const msgs = h.toMessages();
  assert.deepEqual(msgs.map((m) => m.content), ["bbbb", "cc"]);
});

test("most recent turn survives even if oversized (truncated)", () => {
  const h = createHistory({ maxChars: 5 });
  h.add("user", "abcdefghij");
  assert.deepEqual(h.toMessages(), [{ role: "user", content: "abcde" }]);
});

test("clear empties history", () => {
  const h = createHistory({ maxChars: 100 });
  h.add("user", "x");
  h.clear();
  assert.deepEqual(h.toMessages(), []);
});

test("a changed source scope removes stale turns, but an unchanged scope preserves them", () => {
  const h = createHistory();
  h.setScope("document:v1");
  h.add("assistant", "Anggaran lama: 100");
  assert.equal(h.setScope("document:v1"), false);
  assert.equal(h.toMessages().length, 1);
  assert.equal(h.setScope("document:v2"), true);
  assert.deepEqual(h.toMessages(), []);
  h.add("user", "Berapa anggaran sekarang?");
  assert.deepEqual(h.toMessages(), [{ role: "user", content: "Berapa anggaran sekarang?" }]);
});

test("changing from document context to no context does not carry document claims", () => {
  const h = createHistory();
  h.setScope("document:v1");
  h.add("assistant", "Klaim dari dokumen");
  h.setScope("none");
  assert.deepEqual(h.toMessages(), []);
});

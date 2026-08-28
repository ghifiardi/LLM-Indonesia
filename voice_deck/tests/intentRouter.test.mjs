import test from "node:test";
import assert from "node:assert/strict";
import { parseDeterministic, routeIntent } from "../intentRouter.js";

test("parses English navigation keywords", () => {
  assert.equal(parseDeterministic("next slide").action, "next");
  assert.equal(parseDeterministic("go back").action, "previous");
});

test("parses Indonesian navigation keywords", () => {
  assert.equal(parseDeterministic("lanjutkan").action, "next");
  assert.equal(parseDeterministic("mundur").action, "previous");
});

test("parses goto_slide with a digit", () => {
  const command = parseDeterministic("go to slide 5");
  assert.equal(command.action, "goto_slide");
  assert.equal(command.slide, 5);
});

test("parses goto_slide with an Indonesian number word", () => {
  const command = parseDeterministic("ke slide tiga");
  assert.equal(command.action, "goto_slide");
  assert.equal(command.slide, 3);
});

test("parses show_notes / hide_notes bilingually", () => {
  assert.equal(parseDeterministic("show notes").action, "show_notes");
  assert.equal(parseDeterministic("tampilkan catatan").action, "show_notes");
  assert.equal(parseDeterministic("hide notes").action, "hide_notes");
  assert.equal(parseDeterministic("sembunyikan catatan").action, "hide_notes");
});

test("parses blank / resume bilingually", () => {
  assert.equal(parseDeterministic("blank screen").action, "blank");
  assert.equal(parseDeterministic("layar kosong").action, "blank");
  assert.equal(parseDeterministic("resume").action, "resume");
  assert.equal(parseDeterministic("lanjutkan tampilan").action, "resume");
});

test("parses start / end bilingually", () => {
  assert.equal(parseDeterministic("start presentation").action, "start");
  assert.equal(parseDeterministic("mulai presentasi").action, "start");
  assert.equal(parseDeterministic("end presentation").action, "end");
  assert.equal(parseDeterministic("akhiri presentasi").action, "end");
});

test("parses goto_topic from free text", () => {
  const command = parseDeterministic("go to pricing");
  assert.equal(command.action, "goto_topic");
  assert.equal(command.query, "pricing");
});

test("parses goto_topic from Indonesian free text", () => {
  const command = parseDeterministic("tentang harga");
  assert.equal(command.action, "goto_topic");
  assert.equal(command.query, "harga");
});

test("returns null for gibberish with no keyword match", () => {
  assert.equal(parseDeterministic("xyzzy plugh"), null);
});

test("routeIntent falls back to noop when Ollama is disabled and nothing matches", async () => {
  const command = await routeIntent("xyzzy plugh", {
    source: "text",
    confidence: 1,
    config: { ollama: { enabled: false } },
  });
  assert.equal(command.action, "noop");
  assert.equal(command.source, "text");
});

test("routeIntent prefers the deterministic parse over Ollama", async () => {
  let ollamaCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    ollamaCalled = true;
    throw new Error("should not be called");
  };
  try {
    const command = await routeIntent("next slide", {
      source: "voice",
      confidence: 1,
      config: { ollama: { enabled: true, endpoint: "http://localhost:11434/api/chat", model: "test", timeoutMs: 100 } },
    });
    assert.equal(command.action, "next");
    assert.equal(ollamaCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

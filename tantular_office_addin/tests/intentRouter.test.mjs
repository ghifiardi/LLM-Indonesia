import test from "node:test";
import assert from "node:assert/strict";
import { INTENTS, parseIntent, defaultContextFor } from "../src/chat/intentRouter.js";

test("parses exact and messy router output", () => {
  assert.equal(parseIntent("EDIT_TEKS"), "EDIT_TEKS");
  assert.equal(parseIntent("  jawaban: RINGKAS."), "RINGKAS");
  assert.equal(parseIntent("TERJEMAHKAN"), "TERJEMAH"); // substring-tolerant
});

test("unparseable output falls to UMUM", () => {
  assert.equal(parseIntent(""), "UMUM");
  assert.equal(parseIntent("saya tidak yakin"), "UMUM");
  assert.equal(parseIntent(null), "UMUM");
});

test("longest intent wins when outputs overlap", () => {
  // TANYA_DOKUMEN contains no other intent, but guard ordering anyway
  assert.equal(parseIntent("TANYA_DOKUMEN"), "TANYA_DOKUMEN");
});

test("default context table", () => {
  assert.equal(defaultContextFor("TANYA_DOKUMEN", false), "document");
  assert.equal(defaultContextFor("EDIT_TEKS", true), "selection");
  assert.equal(defaultContextFor("EDIT_TEKS", false), "document");
  assert.equal(defaultContextFor("RINGKAS", false), "document");
  assert.equal(defaultContextFor("DRAFT_TEKS", true), "none");
  assert.equal(defaultContextFor("TERJEMAH", true), "selection");
  assert.equal(defaultContextFor("UMUM", true), "selection");
  assert.equal(defaultContextFor("UMUM", false), "none"); // never "document"
});

test("INTENTS is the frozen taxonomy", () => {
  assert.ok(Object.isFrozen(INTENTS));
  assert.equal(INTENTS.length, 8);
});

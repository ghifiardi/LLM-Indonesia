import test from "node:test";
import { prefersSelectionContext } from "../src/chat/intentRouter.js";

test("selection-referencing questions prefer the selection context", () => {
  assert.equal(prefersSelectionContext("apakah paragraph yang saya pilih bisa ditampilkan dalam bentuk tabel?"), true);
  assert.equal(prefersSelectionContext("ubah teks terpilih jadi bullet"), true);
  assert.equal(prefersSelectionContext("jelaskan dokumen ini"), false);
});
import assert from "node:assert/strict";
import {
  INTENTS,
  parseIntent,
  defaultContextFor,
  routeIntentHeuristic
} from "../src/chat/intentRouter.js";

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

test("routes a conversational subsection elaboration as document QA", () => {
  assert.equal(
    routeIntentHeuristic("Apakah bisa dielaborasi lebih lanjut di sub-section 'Closed Model vs. Open-Weight'?"),
    "TANYA_DOKUMEN"
  );
});

test("routes a question about a document section as document QA", () => {
  assert.equal(
    routeIntentHeuristic("Jelaskan apa perbedaan pada bagian Closed Model vs Open-Weight"),
    "TANYA_DOKUMEN"
  );
});

test("routes explicit insertion into the document as an edit", () => {
  assert.equal(
    routeIntentHeuristic("Tambahkan elaborasi tentang closed model ke bagian tersebut di dokumen."),
    "EDIT_TEKS"
  );
});

test("format-transform requests route to TANYA_DOKUMEN deterministically", async () => {
  const { routeIntentHeuristic } = await import("../src/chat/intentRouter.js");
  assert.equal(
    routeIntentHeuristic("Can you create the highlighted paragraph and transform it into a structured table"),
    "TANYA_DOKUMEN"
  );
  assert.equal(routeIntentHeuristic("ubah teks yang saya pilih menjadi tabel"), "TANYA_DOKUMEN");
  assert.equal(routeIntentHeuristic("apa kabar"), null);
});

test("English selection references prefer the selection context", () => {
  assert.equal(prefersSelectionContext("transform the highlighted paragraph into a table"), true);
  assert.equal(prefersSelectionContext("ringkas bagian yang disorot"), true);
});

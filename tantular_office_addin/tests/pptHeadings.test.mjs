// Grounded group headings for the re-layout (2026-09-05): one small model
// call names each group in two to four words using only words on the slide;
// anything else falls back to the group's own first item. Never a placeholder.
import test from "node:test";
import assert from "node:assert/strict";
import { validateGroupHeadings, requestGroupHeadings } from "../src/chat/pptHeadings.js";

const GROUPS = [
  { heading: "", items: ["Nama Pelarut", "Jumlah dan Satuan", "Sumber (Hewan/Manusia)", "Produsen", "Negara Produsen"] },
  { heading: "", items: ["Pemerian obat", "Spesifikasi dan Metode Analisis", "Indikasi", "Posologi", "Rute Pemberian"] }
];
const SLIDE_TEXT = "Detail Spesifikasi dan Sumber Pelarut\n" + GROUPS.flatMap((g) => g.items).join("\n");

test("validateGroupHeadings keeps grounded 2–4 word labels and falls back to the first item otherwise", () => {
  const out = validateGroupHeadings(["Sumber Pelarut", "Spesifikasi Obat"], GROUPS, SLIDE_TEXT);
  assert.deepEqual(out.map((h) => h.text), ["Sumber Pelarut", "Spesifikasi Obat"]);
  assert.deepEqual(out.map((h) => h.source), ["model", "model"]);
  const bad = validateGroupHeadings(["Ringkasan Eksekutif Strategis", "Kolom 2"], GROUPS, SLIDE_TEXT);
  assert.deepEqual(bad.map((h) => h.text), ["Nama Pelarut", "Pemerian obat"]);
  assert.deepEqual(bad.map((h) => h.source), ["fallback", "fallback"]);
  // an existing inline heading always wins
  const inline = validateGroupHeadings(["X Y"], [{ heading: "Sumber pelarut", items: ["a"] }], "Sumber pelarut a");
  assert.equal(inline[0].text, "Sumber pelarut");
  // too long is not a label
  assert.equal(validateGroupHeadings(["Nama Pelarut Jumlah Satuan Sumber Produsen"], GROUPS, SLIDE_TEXT)[0].source, "fallback");
});

test("requestGroupHeadings asks for JSON, in the slide's language, and parses defensively", async () => {
  const seen = [];
  const out = await requestGroupHeadings({ groups: GROUPS, slideText: SLIDE_TEXT, run: async (args) => { seen.push(args); return '{"headings":["Sumber Pelarut","Spesifikasi Obat"]}'; } });
  assert.deepEqual(out.map((h) => h.text), ["Sumber Pelarut", "Spesifikasi Obat"]);
  assert.match(seen[0].user, /BAHASA OUTPUT: Bahasa Indonesia/);
  assert.match(seen[0].user, /Kelompok 1/);
  const garbage = await requestGroupHeadings({ groups: GROUPS, slideText: SLIDE_TEXT, run: async () => "not json" });
  assert.deepEqual(garbage.map((h) => h.source), ["fallback", "fallback"]);
  const thrown = await requestGroupHeadings({ groups: GROUPS, slideText: SLIDE_TEXT, run: async () => { throw new Error("x"); } });
  assert.deepEqual(thrown.map((h) => h.text), ["Nama Pelarut", "Pemerian obat"]);
});

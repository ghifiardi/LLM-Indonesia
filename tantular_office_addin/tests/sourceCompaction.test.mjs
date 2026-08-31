import test from "node:test";
import assert from "node:assert/strict";
import { compactSource } from "../src/document/sourceCompaction.js";

test("removes a header/footer line repeated across many pages/slides", () => {
  const doc = [
    "Laporan Tahunan 2026",
    "Halaman 1",
    "Isi pertama.",
    "Halaman 1",
    "Isi kedua.",
    "Halaman 1",
    "Isi ketiga.",
    "Halaman 1"
  ].join("\n");
  const r = compactSource(doc);
  assert.doesNotMatch(r.text, /Halaman 1/, "a line repeated >=3 times must be removed as boilerplate");
  assert.match(r.text, /Isi pertama\./);
  assert.match(r.text, /Isi kedua\./);
  assert.match(r.text, /Isi ketiga\./);
  assert.ok(r.removedChars > 0);
});

test("removes header/footer boilerplate case- and whitespace-insensitively", () => {
  const doc = ["HALAMAN 1", "A", "halaman  1", "B", "Halaman 1", "C"].join("\n");
  const r = compactSource(doc);
  assert.doesNotMatch(r.text, /halaman/i);
});

test("collapses exact adjacent duplicate lines (an extraction artifact), keeps one copy", () => {
  const doc = ["Judul.", "Kalimat sama persis.", "Kalimat sama persis.", "Kalimat berikutnya."].join("\n");
  const r = compactSource(doc);
  const occurrences = (r.text.match(/Kalimat sama persis\./g) || []).length;
  assert.equal(occurrences, 1, "an exact adjacent duplicate must be collapsed to one copy");
  assert.match(r.text, /Kalimat berikutnya\./);
});

test("collapses runs of blank lines to a single paragraph separator", () => {
  const doc = "Paragraf satu.\n\n\n\n\nParagraf dua.";
  const r = compactSource(doc);
  assert.equal(r.text, "Paragraf satu.\n\nParagraf dua.");
});

test("preserves source order", () => {
  const doc = "Alfa.\nBeta.\nGamma.\nDelta.";
  const r = compactSource(doc);
  const idx = ["Alfa.", "Beta.", "Gamma.", "Delta."].map((s) => r.text.indexOf(s));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "line order must be unchanged");
});

test("ADVERSARIAL: two similarly-worded but factually different paragraphs both survive", () => {
  // Same sentence shape, different numbers — must NOT be treated as
  // duplicates, and must NOT be merged/paraphrased into one.
  const doc = [
    "Anggaran mencapai Rp 4.500.000.000 pada Q1 2026.",
    "Anggaran mencapai Rp 5.100.000.000 pada Q2 2026."
  ].join("\n");
  const r = compactSource(doc);
  assert.match(r.text, /4\.500\.000\.000/);
  assert.match(r.text, /5\.100\.000\.000/);
  assert.equal(r.text.split("\n").filter(Boolean).length, 2, "both distinct facts must remain as separate lines");
});

test("ADVERSARIAL: unique names, numbers, dates, and URLs all survive even when short", () => {
  const doc = [
    "Kontak: Budi Santoso",
    "Tanggal: 10 Januari 2026",
    "Anggaran: Rp 4.5 miliar",
    "Referensi: https://contoh-instansi.go.id/laporan"
  ].join("\n");
  const r = compactSource(doc);
  for (const line of doc.split("\n")) {
    assert.ok(r.text.includes(line), `unique fact line must survive verbatim: "${line}"`);
  }
  assert.equal(r.removedChars, 0, "nothing here repeats >=3 times or is an adjacent duplicate — nothing should be removed");
});

test("ADVERSARIAL: a short line that appears fewer than the boilerplate threshold is kept even if it repeats twice", () => {
  const doc = ["Catatan.", "Isi satu.", "Catatan.", "Isi dua."].join("\n");
  const r = compactSource(doc);
  const occurrences = (r.text.match(/Catatan\./g) || []).length;
  assert.equal(occurrences, 2, "two non-adjacent repeats must NOT be treated as boilerplate (threshold is 3+)");
});

test("ADVERSARIAL: a long line is never treated as header/footer boilerplate even if it repeats often", () => {
  const longSentence = "Ini adalah kalimat yang cukup panjang untuk melebihi ambang batas panjang baris header atau footer yang wajar dalam dokumen resmi pemerintah.";
  const doc = [longSentence, "Sela.", longSentence, "Sela lain.", longSentence].join("\n");
  const r = compactSource(doc);
  const occurrences = (r.text.match(new RegExp(longSentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  assert.equal(occurrences, 3, "a long, substantive line must never be stripped as boilerplate regardless of repeat count");
});

test("leaves short, clean input completely unchanged", () => {
  const doc = "Satu paragraf pendek tanpa pengulangan atau baris kosong berlebih.";
  const r = compactSource(doc);
  assert.equal(r.text, doc);
  assert.equal(r.removedChars, 0);
  assert.equal(r.originalChars, r.compactedChars);
});

test("reports originalChars, compactedChars, and removedChars consistently", () => {
  const doc = ["Halaman 1", "A", "Halaman 1", "B", "Halaman 1", "C"].join("\n");
  const r = compactSource(doc);
  assert.equal(r.originalChars, doc.length);
  assert.equal(r.compactedChars, r.text.length);
  assert.equal(r.originalChars - r.compactedChars, r.removedChars);
});

test("handles empty and whitespace-only input without throwing", () => {
  assert.doesNotThrow(() => compactSource(""));
  assert.doesNotThrow(() => compactSource("   \n\n  "));
  assert.doesNotThrow(() => compactSource(null));
  assert.doesNotThrow(() => compactSource(undefined));
  const r = compactSource("");
  assert.equal(r.text, "");
  assert.equal(r.removedChars, 0);
});

test("never paraphrases or rewrites survivng content — surviving lines are byte-identical to the source", () => {
  const doc = ["Fakta unik satu.", "Halaman 1", "Fakta unik dua.", "Halaman 1", "Fakta unik tiga.", "Halaman 1"].join("\n");
  const r = compactSource(doc);
  for (const line of ["Fakta unik satu.", "Fakta unik dua.", "Fakta unik tiga."]) {
    assert.ok(r.text.includes(line), `surviving content must be byte-identical to source: "${line}"`);
  }
});

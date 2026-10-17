// 2026-08-31: extractedStructure.js is the shared, neutral home for
// title/heading/section detection over flattened extractor text — moved out
// of src/deck/documentDeck.js so Document Studio's deterministic fallback
// (documentPlanner.js) can reuse the exact same, already-proven logic
// instead of maintaining a second, weaker copy.

import test from "node:test";
import assert from "node:assert/strict";
import {
  detectTitle,
  detectSections,
  detectSectionsLoose,
  isHeading,
  isStatementHeading,
  statementHeadingKind,
  cleanHeading,
  respaceHeading,
  normalize,
  truncate,
  stripRepeatedPageLines
} from "../src/document/extractedStructure.js";

test("statementHeadingKind maps Indonesian and English headings for the SAME statement to the same canonical category", () => {
  assert.equal(statementHeadingKind("LAPORAN POSISI KEUANGAN"), "financial_position");
  assert.equal(statementHeadingKind("STATEMENT OF FINANCIAL POSITION"), "financial_position");
  assert.equal(statementHeadingKind("LAPORAN LABA RUGI"), "profit_or_loss");
  assert.equal(statementHeadingKind("PROFIT OR LOSS"), "profit_or_loss");
  assert.notEqual(statementHeadingKind("LAPORAN POSISI KEUANGAN"), statementHeadingKind("LAPORAN LABA RUGI"));
  assert.equal(statementHeadingKind("This is not a statement heading at all."), null);
});

// 2026-08-31 verification follow-up: consecutive-heading suppression (fixing
// the bilingual-mirror empty-body bug) must not ALSO suppress two genuinely
// different consecutive headings — only a matching canonical statement
// category proves a mirror pair.

test("consecutive Indonesian/English headings for the SAME statement collapse to one visible heading", () => {
  const text = [
    "LAPORAN POSISI KEUANGAN",
    "STATEMENT OF FINANCIAL POSITION",
    "Kas dan setara kas adalah bagian penting dari laporan ini secara keseluruhan sepanjang periode berjalan."
  ].join("\n");
  const sections = detectSections(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, "LAPORAN POSISI KEUANGAN");
});

test("two genuinely different consecutive statement headings are both preserved, not merged", () => {
  const text = [
    "LAPORAN POSISI KEUANGAN",
    "LAPORAN LABA RUGI",
    "Pendapatan bersih meningkat signifikan dibandingkan periode yang sama tahun sebelumnya secara keseluruhan."
  ].join("\n");
  const sections = detectSections(text);
  // The first (empty-body) heading is dropped by the length filter — same
  // as it always has been for ANY heading immediately followed by another —
  // but critically the SECOND heading (a genuinely different statement) must
  // survive as its own section, not be silently merged into/discarded by
  // the first.
  assert.ok(sections.some((s) => s.title === "LAPORAN LABA RUGI"),
    "a genuinely different second heading must not be discarded as if it were a mirror of the first");
});

test("a generic parent heading followed by a distinct child heading: the child is not silently lost", () => {
  const text = [
    "1. PENDAHULUAN",
    "1.1 Latar Belakang",
    "Ini adalah paragraf latar belakang yang cukup panjang untuk lolos ambang batas isi bagian.",
    "2. METODOLOGI",
    "Metodologi yang digunakan dijelaskan secara rinci dan cukup panjang untuk lolos ambang batas juga.",
    "3. HASIL",
    "Hasil penelitian ditampilkan di sini dengan penjelasan yang cukup panjang untuk lolos ambang batas."
  ].join("\n");
  const sections = detectSectionsLoose(text);
  assert.ok(sections.some((s) => /latar belakang/i.test(s.title)),
    "the distinct child heading ('1.1 Latar Belakang') must survive as its own section");
});

test("stripRepeatedPageLines drops a line that recurs across 3+ distinct pages", () => {
  const text = [
    "[Page 1]",
    "Judul Halaman Satu",
    "PT Example — Running Header",
    "[Page 2]",
    "Judul Halaman Dua",
    "PT Example — Running Header",
    "[Page 3]",
    "Judul Halaman Tiga",
    "PT Example — Running Header"
  ].join("\n");
  const result = stripRepeatedPageLines(text);
  assert.doesNotMatch(result, /PT Example — Running Header/);
  assert.match(result, /Judul Halaman Satu/);
  assert.match(result, /Judul Halaman Dua/);
  assert.match(result, /Judul Halaman Tiga/);
});

test("stripRepeatedPageLines is provenance-aware — a line repeated only WITHIN one page is kept (unlike global-frequency sourceCompaction.js)", () => {
  const text = [
    "[Page 1]",
    "Catatan penting.",
    "Catatan penting.",
    "Catatan penting.",
    "[Page 2]",
    "Isi halaman dua yang berbeda sepenuhnya dari sebelumnya."
  ].join("\n");
  const result = stripRepeatedPageLines(text);
  // Repeats 3x, but only within ONE page — must survive, since this is
  // exactly the false-positive class sourceCompaction.js's global-frequency
  // rule is unsafe for (no page-boundary provenance).
  assert.equal((result.match(/Catatan penting\./g) || []).length, 3);
});

test("stripRepeatedPageLines never strips a page/slide/sheet marker itself", () => {
  const text = [
    "[Page 1]", "Header berulang", "[Page 2]", "Header berulang", "[Page 3]", "Header berulang"
  ].join("\n");
  const result = stripRepeatedPageLines(text);
  assert.match(result, /\[Page 1\]/);
  assert.match(result, /\[Page 2\]/);
  assert.match(result, /\[Page 3\]/);
});

test("stripRepeatedPageLines leaves text with no page markers unchanged (no false 3x match across an undifferentiated document)", () => {
  const text = "Baris berulang.\nBaris berulang.\nBaris berulang.\nBaris lain.";
  const result = stripRepeatedPageLines(text);
  assert.equal((result.match(/Baris berulang\./g) || []).length, 3);
});

test("detectTitle finds a title-like early line and skips boilerplate", () => {
  const text = [
    "Conference Paper — Preprint",
    "Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents",
    "Abstract",
    "This paper introduces a system..."
  ].join("\n");
  assert.equal(detectTitle(text), "Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents");
});

test("detectTitle never picks a financial statement row as the title", () => {
  const text = [
    "[Page 1]",
    "hasil investasi lain-lain 91,003 18,478 from other investments",
    "PT Merdeka Copper Gold Tbk",
    "Laporan Keuangan Konsolidasian Interim"
  ].join("\n");
  assert.equal(detectTitle(text), "PT Merdeka Copper Gold Tbk");
});

test("detectTitle strips a bilingual mirror from the chosen title", () => {
  const text = "Laporan Tahunan 2026 Laporan Tahunan 2026";
  assert.equal(detectTitle(text), "Laporan Tahunan 2026");
});

test("isStatementHeading recognizes Indonesian/English/bilingual statement titles", () => {
  assert.ok(isStatementHeading("LAPORAN POSISI KEUANGAN"));
  assert.ok(isStatementHeading("STATEMENT OF FINANCIAL POSITION"));
  assert.ok(isStatementHeading("LAPORAN LABA RUGI/PROFIT OR LOSS"));
  assert.ok(isStatementHeading("LAPORAN AUDITOR INDEPENDEN/INDEPENDENT AUDITOR'S REPORT"));
  assert.ok(!isStatementHeading("This is an ordinary sentence about the weather."));
});

test("isHeading treats a recognized statement heading as a heading even though it is long/allcaps-mixed", () => {
  assert.ok(isHeading("LAPORAN POSISI KEUANGAN KONSOLIDASIAN/CONSOLIDATED STATEMENT OF FINANCIAL POSITION"));
});

test("detectSections splits flattened text at detected headings, in order", () => {
  const text = [
    "1. PENDAHULUAN",
    "Ini adalah paragraf pembuka yang cukup panjang untuk dianggap sebagai isi bagian pertama dokumen ini.",
    "2. METODOLOGI",
    "Bagian ini menjelaskan metodologi yang digunakan secara rinci dan cukup panjang untuk lolos ambang batas."
  ].join("\n");
  const sections = detectSections(text);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "1. PENDAHULUAN");
  assert.equal(sections[1].title, "2. METODOLOGI");
});

test("detectSections attaches page provenance from [Page N] markers and never turns the marker itself into body text", () => {
  const text = [
    "[Page 1]",
    "LAPORAN POSISI KEUANGAN",
    "Kas dan setara kas adalah bagian penting dari laporan posisi keuangan perusahaan ini secara keseluruhan.",
    "[Page 2]",
    "LAPORAN LABA RUGI",
    "Pendapatan bersih meningkat signifikan dibandingkan periode yang sama tahun sebelumnya secara keseluruhan."
  ].join("\n");
  const sections = detectSections(text);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].page, 1);
  assert.equal(sections[1].page, 2);
  assert.doesNotMatch(sections[0].body, /^\[Page/);
  assert.doesNotMatch(sections[1].body, /^\[Page/);
});

test("detectSectionsLoose requires at least 3 sections or returns empty", () => {
  const text = "Just one short paragraph with no headings at all in it whatsoever.";
  assert.deepEqual(detectSectionsLoose(text), []);
});

test("cleanHeading strips markdown markers and trailing colons", () => {
  assert.equal(cleanHeading("### Ringkasan:"), "Ringkasan");
});

test("respaceHeading re-inserts spaces into a spaceless ALLCAPS run using the dictionary", () => {
  assert.equal(respaceHeading("INTRODUCTIONANDBACKGROUND"), "INTRODUCTION AND BACKGROUND");
});

test("normalize/truncate behave as before the move (regression pin against the extraction move)", () => {
  assert.equal(normalize("a\r\nb\r\n\r\n\r\n\r\nc"), "a\nb\n\nc");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
  assert.equal(truncate("short", 50), "short");
});

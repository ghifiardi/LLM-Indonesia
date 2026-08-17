import test from "node:test";
import assert from "node:assert/strict";
import {
  parseStatementRow,
  isStatementRow,
  formatStatementRow,
  detectPeriods,
  statementBullets,
  looksLikeStatement,
  stripBilingualMirror,
} from "../src/deck/statementRows.js";

test("a mirrored bilingual heading keeps only the Indonesian half", () => {
  assert.equal(stripBilingualMirror(BILINGUAL_HEADING), "31 DESEMBER 2025 DAN 2024");
  assert.equal(stripBilingualMirror("1. UMUM 1. GENERAL"), "1. UMUM");
});

test("mirror stripping leaves ordinary headings alone", () => {
  const heading = "LAPORAN POSISI KEUANGAN KONSOLIDASIAN";
  assert.equal(stripBilingualMirror(heading), heading);
  // A repeated word partway through is not a mirror.
  const repeated = "Aset dan liabilitas Aset lancar dan aset tidak lancar perusahaan";
  assert.equal(stripBilingualMirror(repeated), repeated);
});

// Verbatim from the deck that exposed this: a four-column bilingual row
// flattened by layout-mode PDF extraction, promoted to a slide headline.
const ROW = "hasil investasi lain-lain 91,003 18,478 from other investments";
const NEGATIVE_ROW =
  "Penempatan deposito berjangka yang dibatasi penggunaannya (27,344) (1,133) Placement of restricted time deposits";
const BILINGUAL_HEADING = "31 DESEMBER 2025 DAN 2024 31 DECEMBER 2025 AND 2024";

test("splits a bilingual row into label, figures, and translated label", () => {
  const row = parseStatementRow(ROW);
  assert.equal(row.label, "hasil investasi lain-lain");
  assert.deepEqual(row.values, ["91,003", "18,478"]);
  assert.equal(row.labelEn, "from other investments");
});

test("parenthesised negatives are figures, not prose", () => {
  const row = parseStatementRow(NEGATIVE_ROW);
  assert.deepEqual(row.values, ["(27,344)", "(1,133)"]);
  assert.match(row.label, /^Penempatan deposito berjangka/);
});

test("a bilingual heading is not a statement row", () => {
  // This produced two identical slides (28 and 29). Its digits are prose:
  // years inside a title, not a column of figures.
  assert.equal(parseStatementRow(BILINGUAL_HEADING), null);
  assert.equal(isStatementRow(BILINGUAL_HEADING), false);
});

test("an unlabelled run of figures is rejected", () => {
  // A bare column fragment has no meaning to present; inventing one would be
  // worse than dropping it.
  assert.equal(parseStatementRow("91,003 18,478 12,004"), null);
});

test("prose is not mistaken for a row", () => {
  assert.equal(parseStatementRow("Kami tetap optimistis terhadap prospek jangka panjang."), null);
  // A single figure in a sentence is not a column block.
  assert.equal(parseStatementRow("Perusahaan didirikan pada tahun 2004 di Jakarta."), null);
});

test("dotted thousands, percentages and nil dashes are figures", () => {
  assert.deepEqual(parseStatementRow("Jumlah aset lancar 2.691.356 3.058.023").values,
    ["2.691.356", "3.058.023"]);
  assert.deepEqual(parseStatementRow("Marjin laba 12,5% 11,8%").values, ["12,5%", "11,8%"]);
  assert.deepEqual(parseStatementRow("Beban pajak - 4,120").values, ["-", "4,120"]);
});

test("periods come from the heading, deduped across the English mirror", () => {
  // Without dedup the mirrored heading yields 2025, 2024, 2025, 2024 and every
  // row appears to have four columns.
  assert.deepEqual(detectPeriods(BILINGUAL_HEADING), ["2025", "2024"]);
});

test("formatting labels each figure with its year and drops the English mirror", () => {
  const formatted = formatStatementRow(parseStatementRow(ROW), ["2025", "2024"]);
  assert.equal(formatted, "hasil investasi lain-lain — 2025: 91,003 · 2024: 18,478");
  assert.ok(!formatted.includes("from other investments"),
    "the mirror doubles bullet length and adds nothing");
});

test("without a heading, figures are still shown rather than dropped", () => {
  assert.equal(formatStatementRow(parseStatementRow(ROW)),
    "hasil investasi lain-lain — 91,003 · 18,478");
});

test("statement bullets keep prose lines that carry the unit", () => {
  const body = [
    "(Dinyatakan dalam ribuan Dolar AS)",
    "Kas dan setara kas 1.234.567 2.345.678",
    "Piutang usaha 456.789 512.345",
  ].join("\n");
  const bullets = statementBullets(body, BILINGUAL_HEADING);
  // Dropping the currency basis would strip the figures of their meaning.
  assert.equal(bullets[0], "(Dinyatakan dalam ribuan Dolar AS)");
  assert.equal(bullets[1], "Kas dan setara kas — 2025: 1.234.567 · 2024: 2.345.678");
});

test("looksLikeStatement separates a balance sheet from a narrative page", () => {
  const sheet = [
    "Kas dan setara kas 1.234.567 2.345.678",
    "Piutang usaha 456.789 512.345",
    "Jumlah aset lancar 2.691.356 3.058.023",
    "(Dinyatakan dalam ribuan Dolar AS)",
  ].join("\n");
  const prose = [
    "Perusahaan didirikan pada tahun 2004.",
    "Kantor pusat berlokasi di Jakarta Selatan.",
    "Kegiatan komersial dimulai pada tahun 2007.",
  ].join("\n");
  assert.equal(looksLikeStatement(sheet), true);
  assert.equal(looksLikeStatement(prose), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ANALYSIS_ROWS,
  detectHeaderRow,
  safeSheetValue,
  sourceFingerprint,
  tableFromGrid
} from "../src/chat/analysisTable.js";

// Synthetic sheet, shaped like Excel's range.values / range.numberFormat:
// native numbers, date serials with a date format, a title row, a blank row,
// a leading-zero code stored as text, and a TOTAL row at the bottom.
const DATE = "yyyy-mm-dd";
const GEN = "General";
function salesSheet() {
  const values = [
    ["Laporan Penjualan Q4", "", "", "", ""],
    ["", "", "", "", ""],
    ["Tanggal", "Region", "Pendapatan", "Pesanan", "Kode"],
    [46296, "Jakarta", 100, 10, "001"],
    [46297, "Jakarta", 120, 12, "002"],
    [46298, "Bandung", "", 11, "003"],
    ["", "", "", "", ""],
    [46299, "Bandung", 90, "#N/A", "004"],
    ["TOTAL", "", 310, 33, ""]
  ];
  const numberFormats = values.map((row) => row.map((_, c) => (c === 0 ? DATE : GEN)));
  return { values, numberFormats };
}

test("an Excel range becomes the upstream { columns, types, rows } table", () => {
  const { values, numberFormats } = salesSheet();
  const t = tableFromGrid(values, { numberFormats, name: "Sheet1!A1:E9" });
  assert.equal(t.headerRow, 2, "title and blank rows above the header are skipped");
  assert.deepEqual(t.data.columns, ["Tanggal", "Region", "Pendapatan", "Pesanan", "Kode"]);
  assert.deepEqual(t.data.types, ["text", "text", "number", "number", "text"]);
  assert.deepEqual(t.kinds, ["date", "text", "number", "number", "text"]);
  assert.deepEqual(t.data.rows, [
    ["2026-10-01", "Jakarta", 100, 10, "001"],
    ["2026-10-02", "Jakarta", 120, 12, "002"],
    ["2026-10-03", "Bandung", null, 11, "003"],
    ["2026-10-04", "Bandung", 90, null, "004"]
  ]);
  assert.equal(t.data.name, "Sheet1!A1:E9");
  assert.match(t.notes.join("\n"), /TOTAL/, "the excluded total row is reported");
  assert.match(t.notes.join("\n"), /1 cell error/, "Excel errors become empty and are counted");
});

test("typing follows upstream parseCSV: numeric text is a number, leading zeros stay text", () => {
  const t = tableFromGrid([["a", "b", "c"], ["1", "007", "1e3"], ["2.5", "010", "-4"]]);
  assert.deepEqual(t.data.types, ["number", "text", "number"]);
  assert.deepEqual(t.data.rows, [[1, "007", 1000], [2.5, "010", -4]]);
});

test("a column mixing numbers and text is text, booleans read as true/false", () => {
  const t = tableFromGrid([["v", "flag"], [1, true], ["n/a", false], [3, true]]);
  assert.deepEqual(t.data.types, ["text", "text"]);
  assert.deepEqual(t.data.rows.map((r) => r[0]), ["1", "n/a", "3"]);
  assert.deepEqual(t.data.rows.map((r) => r[1]), ["true", "false", "true"]);
});

test("ISO date text is a date kind; numbers without a date format stay numbers", () => {
  const t = tableFromGrid([["d", "serial"], ["2026-01-05", 46000], ["2026-01-06", 46001]]);
  assert.deepEqual(t.kinds, ["date", "number"]);
});

test("blank headers get the column letter, duplicates a suffix, empty columns are dropped", () => {
  const t = tableFromGrid([["x", "", "", "x"], [1, 2, "", 4], [5, 6, "", 8]], { colIndex: 2 });
  assert.deepEqual(t.data.columns, ["x", "Kolom D", "x (2)"]);
  assert.deepEqual(t.data.rows, [[1, 2, 4], [5, 6, 8]]);
  assert.match(t.notes.join("\n"), /Kolom D/);
});

test("header detection prefers the first full text row over a title", () => {
  assert.equal(detectHeaderRow([["Judul"], ["a", "b", "c"], [1, 2, 3]]), 1);
  assert.equal(detectHeaderRow([["a", "b"], [1, 2]]), 0);
  assert.equal(detectHeaderRow([[1, 2], [3, 4]]), 0, "no text row: fall back to the first row");
});

test("empty, header-only and oversize ranges are refused with Indonesian messages", () => {
  assert.throws(() => tableFromGrid([]), /kosong/);
  assert.throws(() => tableFromGrid([["a", "b"]]), /baris data/);
  const big = [["v"], ...Array.from({ length: MAX_ANALYSIS_ROWS + 1 }, (_, i) => [i])];
  assert.throws(() => tableFromGrid(big), /10\.000 baris/);
  const wide = [Array.from({ length: 51 }, (_, i) => `c${i}`), Array.from({ length: 51 }, () => 1)];
  assert.throws(() => tableFromGrid(wide), /50 kolom/);
});

test("the source fingerprint changes when a value or a date format changes", () => {
  const { values, numberFormats } = salesSheet();
  const base = sourceFingerprint({ values, numberFormats });
  const edited = values.map((r) => [...r]);
  edited[3][2] = 101;
  assert.notEqual(sourceFingerprint({ values: edited, numberFormats }), base);
  const reformatted = numberFormats.map((r) => r.map(() => GEN));
  assert.notEqual(sourceFingerprint({ values, numberFormats: reformatted }), base);
  assert.equal(sourceFingerprint({ values, numberFormats }), base);
});

test("text written to a result sheet can never become a formula", () => {
  assert.equal(safeSheetValue("=HYPERLINK(\"http://x\")"), "'=HYPERLINK(\"http://x\")");
  assert.equal(safeSheetValue("+1"), "'+1");
  assert.equal(safeSheetValue("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(safeSheetValue("-"), "'-");
  assert.equal(safeSheetValue("Jakarta"), "Jakarta");
  assert.equal(safeSheetValue(-4.5), -4.5, "numbers are written as numbers");
  assert.equal(safeSheetValue(null), "");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  buildSeriesPreview,
  colName,
  columnMapReadShape,
  columnMapToPromptText,
  createSeriesChart,
  excelSerialToIso,
  looksLikeDateFormat,
  parseRangeRef,
  profileColumns,
  readLiveSeriesPreview,
  sanitizeSeriesChart,
  seriesPreviewText
} from "../src/chat/excelSeriesChart.js";
import { contextToPromptText, gridToAddressedCells, isChartAction, sanitizeExcelActions } from "../src/chat/excelTools.js";

// Synthetic sheet with the SHAPE of a real maturity tracker (no real data):
// A = dates, B..AA = target sub-scores + "Overall" at AA, AG..BF = actual
// sub-scores + "Overall" at BF, rows 1–2 two-level headers, row 3 baseline,
// rows 4–62 monthly. 65 columns × 62 rows.
function trackerGrid() {
  const cols = 65;
  const blank = () => Array.from({ length: cols }, () => "");
  const row1 = blank();
  row1[0] = "Date";
  row1[1] = "Target Maturity";
  row1[32] = "Actual Maturity";
  const row2 = blank();
  const labels = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "P1", "P2", "P3", "P4", "P5", "D1", "D2", "D3", "D4", "D5", "R1", "R2", "E1", "E2", "E3", "E4", "E5", "E6", "Overall", "G", "P", "D", "R", "E"];
  labels.forEach((label, i) => { row2[1 + i] = label; row2[32 + i] = label; });
  const row3 = blank().map((_, c) => (c === 0 ? "Initial" : c <= 62 ? 2 : ""));
  const rows = [row1, row2, row3];
  for (let i = 0; i < 59; i += 1) {
    const row = blank();
    row[0] = 45352 + i * 30; // ~monthly serials from 2024-03-01
    for (let c = 1; c <= 62; c += 1) row[c] = 2 + i / 100 + (c >= 32 ? 0.01 : 0);
    rows.push(row);
  }
  const formats = rows.map((row, r) => row.map((_, c) => (c === 0 && r >= 3 ? "d-mmm-yy" : "General")));
  return { rows, formats };
}

test("range refs: absolute, sheet-qualified, and single areas only", () => {
  assert.deepEqual(parseRangeRef("$AA$4:$AA$62"), { sheet: "", address: "AA4:AA62", c1: 27, r1: 4, c2: 27, r2: 62 });
  assert.equal(parseRangeRef("'Plot Data'!A4:A62").sheet, "Plot Data");
  assert.equal(parseRangeRef("Plot Data!BF4:BF62").address, "BF4:BF62");
  assert.equal(parseRangeRef("B4:B13,G4:T13"), null);
  assert.equal(parseRangeRef("T13:G4"), null);
  assert.equal(colName(58), "BF");
});

test("the target-vs-actual request is representable as one bounded action", () => {
  const { action, error } = sanitizeSeriesChart({
    type: "Line",
    title: "Target vs Actual Overall Maturity",
    categories: "'Plot Data'!A4:A62",
    series: [{ name: "Target", values: "AA4:AA62" }, { name: "Actual", values: "'Plot Data'!BF4:BF62" }]
  });
  assert.equal(error, undefined);
  assert.deepEqual(action, {
    op: "add_series_chart",
    sheet: "Plot Data",
    type: "Line",
    title: "Target vs Actual Overall Maturity",
    categories: "A4:A62",
    orientation: "column",
    points: 59,
    series: [{ name: "Target", values: "AA4:AA62" }, { name: "Actual", values: "BF4:BF62" }]
  });
});

test("series must align with categories, stay on one sheet, and respect caps", () => {
  const base = { categories: "A4:A62" };
  assert.match(sanitizeSeriesChart({ ...base, series: [{ name: "T", values: "AA3:AA62" }] }).error, /59 titik/);
  assert.match(sanitizeSeriesChart({ ...base, series: [{ name: "T", values: "G4:T13" }] }).error, /satu kolom/);
  assert.match(sanitizeSeriesChart({ ...base, series: [{ name: "T", values: "AA3:AA61" }] }).error, /mulai di baris 4/);
  assert.match(sanitizeSeriesChart({ categories: "A4:B62", series: [{ values: "AA4:AA62" }] }).error, /satu kolom atau satu baris/);
  assert.match(sanitizeSeriesChart({ ...base, series: [] }).error, /kosong/);
  assert.match(sanitizeSeriesChart({ categories: "A4:A62", series: [{ values: "Other!AA4:AA62" }], sheet: "Plot Data" }).error, /sheet yang sama/);
  const many = Array.from({ length: MAX_CHART_SERIES + 1 }, (_, i) => ({ values: `${colName(2 + i)}4:${colName(2 + i)}62` }));
  assert.match(sanitizeSeriesChart({ ...base, series: many }).error, /batas/);
  assert.match(sanitizeSeriesChart({ categories: `A1:A${MAX_CHART_POINTS + 1}`, series: [{ values: `B1:B${MAX_CHART_POINTS + 1}` }] }).error, /batas 500/);
  assert.equal(sanitizeSeriesChart({ categories: "B1:Z1", series: [{ values: "B2:Z2" }] }).action.orientation, "row");
  assert.equal(sanitizeSeriesChart({ ...base, type: "Pie3D", series: [{ values: "AA4:AA62" }] }).action.type, "Line");
});

test("the observed multi-area add_chart is rejected with guidance, series chart accepted", () => {
  const { actions, rejected } = sanitizeExcelActions([
    { op: "add_chart", type: "Line", dataAddress: "B4:B13,G4:T13" },
    { op: "add_series_chart", categories: "A4:A62", series: [{ name: "Target", values: "AA4:AA62" }] }
  ]);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /add_series_chart/);
  assert.equal(actions.length, 1);
  assert.equal(isChartAction(actions[0]), true);
  assert.equal(isChartAction({ op: "write_cells" }), false);
});

test("column map exposes far columns with carried group headers and date extents", () => {
  const { rows, formats } = trackerGrid();
  const map = profileColumns(rows, { numberFormats: formats });
  assert.deepEqual(map.headerRows, [1, 2]);
  const byCol = Object.fromEntries(map.columns.map((c) => [c.column, c]));
  assert.equal(byCol.A.header, "Date");
  assert.equal(byCol.A.date, true);
  assert.deepEqual([byCol.A.firstRow, byCol.A.lastRow, byCol.A.numeric], [4, 62, 59]);
  assert.equal(byCol.AA.header, "Target Maturity › Overall");
  assert.equal(byCol.BF.header, "Actual Maturity › Overall");
  assert.deepEqual([byCol.BF.firstRow, byCol.BF.lastRow], [3, 62]);
  assert.equal(byCol.BF.date, false);
});

test("the prompt now names AA and BF even though the cell sample stops at T", () => {
  const { rows, formats } = trackerGrid();
  const sample = rows.slice(0, 120).map((row) => row.slice(0, 20));
  const { cells } = gridToAddressedCells(sample, 0, 0);
  assert.ok(!cells.some((cell) => /^(AA|BF)\d/.test(cell.address)), "precondition: old sample cannot see AA/BF");
  const prompt = contextToPromptText({
    activeSheet: "Plot Data",
    sheetNames: ["Plot Data"],
    usedAddress: "'Plot Data'!A1:BM62",
    cells,
    truncated: true,
    columnMap: { ...profileColumns(rows, { numberFormats: formats }), rowsTruncated: false, rowsRead: 62 },
    selectionAddress: "A1",
    selectionValues: [["Date"]]
  });
  assert.match(prompt, /AA: "Target Maturity › Overall" — angka baris 3–62/);
  assert.match(prompt, /BF: "Actual Maturity › Overall" — angka baris 3–62/);
  assert.match(prompt, /A: "Date" — tanggal baris 4–62 \(59 nilai; awal 2024-03-01/);
  assert.ok(prompt.length < 20_000, `prompt stays bounded (${prompt.length} chars)`);
});

test("column map reads are bounded for huge sheets", () => {
  assert.deepEqual(columnMapReadShape(62, 65), { rows: 62, cols: 65 });
  assert.deepEqual(columnMapReadShape(1_000_000, 300), { rows: 200, cols: 100 });
  const text = columnMapToPromptText({ columns: [{ column: "A", header: "x", numeric: 0 }], headerRows: [1], columnsTruncated: true, rowsTruncated: true, rowsRead: 200 });
  assert.match(text, /dibatasi 100 kolom/);
  assert.match(text, /200 baris pertama/);
});

test("dates: serials and formats", () => {
  assert.equal(excelSerialToIso(45352), "2024-03-01");
  assert.equal(excelSerialToIso(47119), "2029-01-01");
  assert.equal(looksLikeDateFormat("d-mmm-yy"), true);
  assert.equal(looksLikeDateFormat("mmm yyyy"), true);
  assert.equal(looksLikeDateFormat("0.00"), false);
  assert.equal(looksLikeDateFormat("General"), false);
  assert.equal(looksLikeDateFormat("[h]:mm:ss"), false);
});

const ACTION = sanitizeSeriesChart({
  sheet: "Plot Data",
  title: "Target vs Actual",
  categories: "A4:A6",
  series: [{ name: "Target", values: "AA4:AA6" }, { name: "Actual", values: "BF4:BF6" }]
}).action;

test("preview shows dates, ranges, extremes, and warns on non-numeric series", () => {
  const preview = buildSeriesPreview(ACTION, {
    categoryValues: [[45352], [45383], [45413]],
    seriesValues: [[[1.97], [2.1], [2.3]], [["n/a"], [""], [""]]],
    categoryFormat: "d-mmm-yy"
  });
  assert.equal(preview.categories.first, "2024-03-01");
  assert.equal(preview.categories.dated, true);
  assert.equal(preview.series[0].max, "2.3");
  assert.equal(preview.series[0].first, "1.97", "series values are never formatted as dates");
  assert.match(preview.warnings[0], /Actual.*tidak berisi angka/);
  const text = seriesPreviewText(preview);
  assert.match(text, /Sumbu X: A4:A6 \(3 titik, 2024-03-01 → 2024-05-01, tanggal\)/);
  assert.match(text, /Workbook belum diubah/);
  const changed = buildSeriesPreview(ACTION, {
    categoryValues: [[45352], [45383], [45413]],
    seriesValues: [[[1.97], [2.1], [2.4]], [["n/a"], [""], [""]]],
    categoryFormat: "d-mmm-yy"
  });
  assert.notEqual(changed.fingerprint, preview.fingerprint);
});

// Minimal fake of the Excel object model: ranges read from a grid; every
// mutation is recorded so tests can prove reads never write.
function fakeExcel(grid) {
  const writes = [];
  const charts = [];
  const cellValue = (address) => {
    const ref = parseRangeRef(address);
    const out = [];
    for (let r = ref.r1; r <= ref.r2; r += 1) {
      const row = [];
      for (let c = ref.c1; c <= ref.c2; c += 1) row.push(grid[`${colName(c)}${r}`] ?? "");
      out.push(row);
    }
    return out;
  };
  const makeRange = (address) => ({
    address,
    load() {},
    get values() { return cellValue(address); },
    get numberFormat() { return cellValue(address).map((row) => row.map(() => (address.startsWith("A") ? "d-mmm-yy" : "General"))); },
    getOffsetRange: () => makeRange("BO21"),
    getRow: () => ({ load() {}, rowHidden: false }),
    select: () => writes.push(["select", address])
  });
  const sheet = {
    name: "Plot Data",
    load() {},
    getRange: makeRange,
    getUsedRange: () => ({ load() {}, columnIndex: 0, columnCount: 65 }),
    getRangeByIndexes: (r, c) => makeRange(`'Plot Data'!${colName(c + 1)}${r + 1}`),
    charts: {
      load() {},
      get items() { return charts.map((c) => ({ name: c.name })); },
      add(type, range, seriesBy) {
        const series = [{ name: "", source: range.address, x: null }];
        const chart = {
          name: `Chart ${charts.length + 1}`, load() {},
          type, seriesBy, series,
          title: {}, legend: {},
          setPosition: (from) => writes.push(["position", from.address])
        };
        series[0].setXAxisValues = (x) => { series[0].x = x.address; };
        chart.series = {
          getItemAt: (i) => series[i],
          add(name) {
            const item = { name, source: null, x: null };
            item.setValues = (v) => { item.source = v.address; };
            item.setXAxisValues = (x) => { item.x = x.address; };
            series.push(item);
            return item;
          }
        };
        chart.items = series;
        charts.push(chart);
        writes.push(["chart", type]);
        return chart;
      }
    }
  };
  const context = {
    workbook: { worksheets: { getItem: (name) => { assert.equal(name, "Plot Data"); return sheet; }, getActiveWorksheet: () => sheet } },
    sync: async () => {}
  };
  return { Excel: { run: async (fn) => fn(context) }, writes, charts };
}

function installOffice(fake, supported = true) {
  globalThis.Excel = fake.Excel;
  globalThis.Office = { context: { requirements: { isSetSupported: () => supported } } };
  return () => { delete globalThis.Excel; delete globalThis.Office; };
}

const GRID = { A4: 45352, A5: 45383, A6: 45413, AA4: 1.97, AA5: 2.1, AA6: 2.3, BF4: 1.97, BF5: 1.98, BF6: 2.0 };

test("reading the preview never writes to the workbook", async () => {
  const fake = fakeExcel({ ...GRID });
  const restore = installOffice(fake);
  try {
    const preview = await readLiveSeriesPreview(ACTION);
    assert.equal(preview.categories.last, "2024-05-01");
    assert.deepEqual(fake.writes, []);
  } finally {
    restore();
  }
});

test("confirm builds one chart with every series bound to the date axis", async () => {
  const fake = fakeExcel({ ...GRID });
  const restore = installOffice(fake);
  try {
    const preview = await readLiveSeriesPreview(ACTION);
    const message = await createSeriesChart(preview);
    assert.equal(fake.charts.length, 1);
    const chart = fake.charts[0];
    assert.equal(chart.type, "Line");
    assert.equal(chart.seriesBy, "Columns");
    assert.deepEqual(chart.items.map((s) => [s.name, s.source, s.x]), [
      ["Target", "AA4:AA6", "A4:A6"],
      ["Actual", "BF4:BF6", "A4:A6"]
    ]);
    assert.equal(chart.title.text, "Target vs Actual");
    assert.match(message, /A4:A6 \+ AA4:AA6 \(Target\), BF4:BF6 \(Actual\)/);
  } finally {
    restore();
  }
});

test("confirm refuses when the data changed after the preview, or the API is too old", async () => {
  const grid = { ...GRID };
  const fake = fakeExcel(grid);
  let restore = installOffice(fake);
  try {
    const preview = await readLiveSeriesPreview(ACTION);
    grid.BF6 = 9;
    await assert.rejects(createSeriesChart(preview), /berubah sejak pratinjau/);
    assert.equal(fake.charts.length, 0);
  } finally {
    restore();
  }
  const old = fakeExcel({ ...GRID });
  restore = installOffice(old, false);
  try {
    const preview = await readLiveSeriesPreview(ACTION);
    await assert.rejects(createSeriesChart(preview), /ExcelApi 1\.7/);
    assert.equal(old.charts.length, 0);
  } finally {
    restore();
  }
});

test("Excel chat holds chart actions for a click and teaches the planner the new op", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chat = fs.readFileSync(path.join(root, "src/chat/excelChat.js"), "utf8");
  assert.match(chat, /renderEditPreview\(answer, otherActions, chartActions\)/);
  assert.match(chat, /"op":"add_series_chart"/);
  assert.match(chat, /Peta kolom/);
  // The only chart write sits inside the confirm click handler.
  const clickIndex = chat.indexOf('confirm.addEventListener("click"');
  const createIndex = chat.indexOf("await createSeriesChart(preview)");
  assert.ok(clickIndex > 0 && createIndex > clickIndex, "createSeriesChart only runs from the confirm click");
  assert.equal(chat.split("createSeriesChart(").length - 1, 1);
});

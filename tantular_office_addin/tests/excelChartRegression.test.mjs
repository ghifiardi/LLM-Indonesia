// Regressions from a real test on sheet "Plot Data" (distribution of Bear D1,
// N3:N62): "Parameter out of range" after charts.add left an empty Chart 7;
// hidden row 3 ("Initial") was plotted; a distribution became a Line chart;
// the reply described series the plan did not have; the preview card was cut
// off in a narrow pane. The workbook is a batching fake of Office.js
// (tests/fixtures/fakeExcelCharts.mjs): failures surface at sync, earlier
// calls have already happened — so an orphaned chart is observable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { excelError, installFakeExcel, plotDataSheet } from "./fixtures/fakeExcelCharts.mjs";
import { chartAnchorColumn, createSeriesChart, edgeRowsToSkip, readLiveSeriesPreview, sanitizeSeriesChart, seriesRowFlags } from "../src/chat/excelSeriesChart.js";
import { binTable, createHistogramChart, histogramBins, readLiveHistogramPreview } from "../src/chat/excelHistogram.js";
import { describeChartPlan, interpretPlan } from "../src/chat/excelPlan.js";
import { revealScrollTop } from "../src/chat/chatScroll.js";

const quiet = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
test.after(() => { console.warn = quiet; });

const SHEET = "Plot Data";
const install = (options = {}, patch = {}) => installFakeExcel({ [SHEET]: { ...plotDataSheet(), ...patch } }, { active: SHEET, ...options });
// The plan the planner produced in the user's test.
const userPlan = () => sanitizeSeriesChart({ type: "Line", sheet: SHEET, title: "Distribusi Bear D1", categories: "A3:A62", series: [{ name: "Bear D1", values: "N3:N62" }] }).action;

// --- 1. A failure after charts.add names the call and deletes the chart -------

test("1: a failing call after charts.add is named with its arguments and the chart is deleted", async () => {
  const fake = install({ failOn: (call) => (call === "ChartSeries.setXAxisValues" ? excelError("Parameter out of range") : null) });
  const preview = await readLiveSeriesPreview(userPlan());
  warnings.length = 0;
  await assert.rejects(createSeriesChart(preview), (error) => {
    assert.match(error.message, /^Chart gagal dibuat: Parameter out of range\./);
    assert.match(error.message, /Panggilan Office\.js yang gagal: ChartSeries\.setXAxisValues\('Plot Data'!A4:A62\)\./);
    assert.match(error.message, /Chart "Chart 7" yang sempat dibuat sudah dihapus lagi\./);
    return true;
  });
  assert.deepEqual(fake.liveCharts(), [], "no half-built chart stays on the sheet");
  assert.ok(warnings.some((w) => w.includes("gagal di ChartSeries.setXAxisValues('Plot Data'!A4:A62)")), "the exact call is logged");
  assert.ok(fake.log.calls.includes('Chart.delete("Chart 7")'));
});

test("1: every Office.js call is its own sync, so the failing call is never ambiguous", async () => {
  const fake = install();
  await createSeriesChart(await readLiveSeriesPreview(userPlan()));
  const creation = fake.log.calls.slice(fake.log.calls.indexOf('ChartCollection.add("Line", Plot Data!N4:N62, "Columns")'));
  assert.deepEqual(creation.slice(0, 5), [
    'ChartCollection.add("Line", Plot Data!N4:N62, "Columns")',
    "ChartSeriesCollection.getItemAt(0)",
    'ChartSeries.name("Bear D1")',
    "ChartSeries.setXAxisValues(Plot Data!A4:A62)",
    'ChartTitle.text("Distribusi Bear D1")'
  ]);
});

test("1: a used range formatted out to column XFD no longer throws 'Parameter out of range' after charts.add", async () => {
  const fake = install({}, { usedRange: "A1:XFD62" });
  const message = await createSeriesChart(await readLiveSeriesPreview(userPlan()));
  assert.match(message, /^✅ Chart Line dibuat dari A4:A62 \+ N4:N62 \(Bear D1\), ditempatkan di T3\./);
  assert.equal(fake.liveCharts().length, 1);
  assert.equal(chartAnchorColumn(0, 16384), 16384 - 10, "the anchor is clamped inside the sheet");
});

test("1: when charts.add itself fails nothing is left and the message names that call", async () => {
  const fake = install({ failOn: (call) => (call === "ChartCollection.add" ? excelError("Parameter out of range") : null) });
  await assert.rejects(createSeriesChart(await readLiveSeriesPreview(userPlan())), /ChartCollection\.add\("Line", 'Plot Data'!N4:N62, "Columns"\)/);
  assert.deepEqual(fake.liveCharts(), []);
});

// --- 2. Hidden and header rows are skipped ----------------------------------------

test("2: the hidden 'Initial' row 3 is skipped; the chart starts at row 4", async () => {
  install();
  const preview = await readLiveSeriesPreview(userPlan());
  assert.equal(preview.action.categories, "A4:A62");
  assert.deepEqual(preview.action.series.map((s) => s.values), ["N4:N62"]);
  assert.equal(preview.categories.points, 59);
  assert.equal(preview.categories.first, "2026-01-01", "the first X value is a date, not 'Initial'");
  assert.match(preview.notes[0], /Baris 3 \(tersembunyi; "Initial" bukan tanggal\/angka\) dilewati; data mulai baris 4\./);
});

test("2: a visible text row in the date column is skipped too, and hidden rows inside are reported", async () => {
  install({}, { hiddenRows: new Set([20]) });
  const preview = await readLiveSeriesPreview(userPlan());
  assert.equal(preview.action.categories, "A4:A62");
  assert.match(preview.notes.join(" "), /Baris 3 \("Initial" bukan tanggal\/angka\) dilewati/);
  assert.match(preview.notes.join(" "), /1 baris tersembunyi di tengah range/);
});

test("2: edge trimming is pure and never drops rows in the middle", () => {
  const flags = seriesRowFlags({
    categoryValues: [["Tanggal"], [46023], [""], [46030], ["Catatan"]],
    seriesValues: [[["Bear D1"], [1.2], [""], [1.5], [""]]],
    hiddenRows: [false, false, false, false, false]
  });
  assert.deepEqual(flags.map((f) => Boolean(f.reason)), [true, false, true, false, true]);
  assert.deepEqual(edgeRowsToSkip(flags), { start: 1, end: 4 }, "the empty row 3 in the middle stays");
});

// --- 3. Distribution → histogram, with an honest fallback ---------------------------

test("3: a distribution request turns the planner's Line chart into a histogram of N", () => {
  const out = interpretPlan({ reply: "Saya membuat chart Line dengan D1–D5 sebagai seri.", actions: [userPlan()] }, { activeSheet: SHEET }, "buat chart distribusi Bear D1");
  assert.equal(out.kind, "act");
  assert.deepEqual(out.actions, [{ op: "add_histogram", sheet: SHEET, title: "Distribusi Bear D1", name: "Bear D1", values: "N3:N62" }]);
  assert.match(out.text, /histogram "Bear D1", bukan chart Line dari waktu ke waktu/);
});

test("3: several planned columns: the one named in the request is used, otherwise the chat asks", () => {
  const five = sanitizeSeriesChart({
    type: "Line", sheet: SHEET, categories: "A4:A62",
    series: ["N", "O", "P", "Q", "R"].map((c, i) => ({ name: `Bear D${i + 1}`, values: `${c}4:${c}62` }))
  }).action;
  const named = interpretPlan({ reply: "", actions: [five] }, { activeSheet: SHEET }, "sebaran Bear D2 dong");
  assert.deepEqual(named.actions.map((a) => [a.op, a.name, a.values]), [["add_histogram", "Bear D2", "O4:O62"]]);
  const vague = interpretPlan({ reply: "", actions: [five] }, { activeSheet: SHEET }, "buat histogram");
  assert.equal(vague.kind, "clarify");
  assert.deepEqual(vague.options, ["Bear D1", "Bear D2", "Bear D3", "Bear D4", "Bear D5"]);
});

test("3: the histogram preview skips the hidden row and bins 59 values by Scott's rule", async () => {
  install();
  const preview = await readLiveHistogramPreview({ op: "add_histogram", sheet: SHEET, name: "Bear D1", values: "N3:N62" });
  assert.equal(preview.action.values, "N4:N62");
  assert.equal(preview.bins.n, 59);
  assert.equal(preview.bins.bins.reduce((a, b) => a + b.count, 0), 59);
  assert.equal(preview.notes[0], "Baris 3 (tersembunyi) dilewati; data mulai baris 4.");
  assert.match(binTable(preview.bins, "Bear D1")[1][0], /^\d+(,\d+)?–\d+(,\d+)?$/, "bin labels use comma decimals, like the sheet");
});

test("3: Scott's rule matches the textbook bin count", () => {
  const bins = histogramBins(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(bins.bins.length, 5, "h = 3.49·29.01·100^(-1/3) ≈ 21.8 → ceil(99 / 21.8) = 5");
  assert.equal(bins.bins.reduce((a, b) => a + b.count, 0), 100);
  assert.throws(() => histogramBins([4]), /minimal 2 angka/);
  assert.equal(histogramBins([3, 3, 3]).bins.length, 1, "constant data is one bin");
});

test("3: Excel's native Histogram type is used when this Excel accepts it", async () => {
  const fake = install();
  const preview = await readLiveHistogramPreview({ op: "add_histogram", sheet: SHEET, name: "Bear D1", values: "N3:N62" });
  const message = await createHistogramChart(preview);
  assert.match(message, /^✅ Histogram "Bear D1" dibuat dengan tipe chart Histogram bawaan Excel dari N4:N62/);
  assert.deepEqual(fake.liveCharts().map((c) => [c.type, c.source]), [["Histogram", "Plot Data!N4:N62"]]);
});

test("3: when Histogram is refused: no leftover chart, binned column chart, and the message says so", async () => {
  const fake = install({ unsupportedTypes: ["Histogram"] });
  const preview = await readLiveHistogramPreview({ op: "add_histogram", sheet: SHEET, name: "Bear D1", values: "N3:N62" });
  const message = await createHistogramChart(preview);
  assert.equal(fake.liveCharts(SHEET).length, 0, "nothing is added to Plot Data");
  const binSheet = fake.sheets["Histogram Bear D1"];
  assert.ok(binSheet, "the bin table goes to a new sheet");
  assert.deepEqual(binSheet.values[0], ["Kelas", "Jumlah (Bear D1)"]);
  assert.equal(binSheet.values.slice(1).reduce((a, row) => a + row[1], 0), 59);
  assert.deepEqual(fake.liveCharts("Histogram Bear D1").map((c) => c.type), ["ColumnClustered"]);
  assert.match(message, /Histogram bawaan Excel tidak bisa dibuat di sini\. Chart gagal dibuat: The argument is invalid.*ChartCollection\.add\("Histogram", 'Plot Data'!N4:N62, "Columns"\)/);
  assert.match(message, /column chart jumlah per kelas: \d+ kelas dari 59 angka di N4:N62/);
  assert.doesNotMatch(message, /Line/);
});

// --- 4. The explanation comes from the plan ------------------------------------------

test("4: the chat describes the actual plan, not the model's 'D1–D5 as series'", () => {
  const out = interpretPlan({ reply: "Chart ini memakai D1–D5 sebagai seri.", actions: [userPlan()] }, { activeSheet: SHEET }, "buat chart Bear D1 dari waktu ke waktu");
  assert.match(out.text, /Rencana: chart Line di sheet "Plot Data" — sumbu X A3:A62; 1 seri: Bear D1 \(N3:N62\)\./);
  assert.doesNotMatch(out.text, /D5|D1–D5/);
  assert.match(out.text, /workbook belum diubah/);
  assert.equal(describeChartPlan([{ op: "write_cells", address: "A1", values: [["x"]] }]), "", "non-chart plans keep the model's reply");
});

// --- 5. Layout: the preview card stays in view ------------------------------------------

test("5: a card that grew below the visible list is scrolled into view; a too-tall card shows its top", () => {
  const view = { top: 100, bottom: 420, height: 320 };
  assert.equal(revealScrollTop(view, { top: 300, bottom: 600, height: 300 }, 50), 230, "bottom aligned when it fits");
  assert.equal(revealScrollTop(view, { top: 300, bottom: 800, height: 500 }, 50), 250, "too tall: its top at the top");
  assert.equal(revealScrollTop(view, { top: 150, bottom: 300, height: 150 }, 50), 50, "already visible: unchanged");
});

test("5: the message list is no longer a fixed 320px window, and every chart-card update reveals the card", () => {
  const css = fs.readFileSync(new URL("../src/taskpane.css", import.meta.url), "utf8");
  assert.match(css, /\.chat-messages \{[^}]*max-height: max\(320px, min\(70vh, 640px\)\)/);
  const chat = fs.readFileSync(new URL("../src/chat/excelChat.js", import.meta.url), "utf8");
  const preview = chat.slice(chat.indexOf("async function renderChartPreview"), chat.indexOf("async function renderEditPreview"));
  assert.equal((preview.match(/reveal\(box\)/g) || []).length, 3, "after a read error, after the result, and after the buttons");
});

// --- 1b. add_chart (one continuous range) gets the same contract ---------------

test("1b: add_chart — a failure at sync after charts.add deletes the chart and names the call", async () => {
  const { executeExcelActions } = await import("../src/chat/excelTools.js");
  const fake = install({ failOn: (call) => (call === "ChartTitle.text" ? excelError("Parameter out of range") : null) });
  const [line] = await executeExcelActions([{ op: "add_chart", sheet: SHEET, type: "Line", dataAddress: "N4:N62", title: "Bear D1" }]);
  assert.match(line, /^❌ add_chart: Chart gagal dibuat: Parameter out of range\./);
  assert.match(line, /Panggilan Office\.js yang gagal: ChartTitle\.text\("Bear D1"\)\./);
  assert.match(line, /Chart "Chart 7" yang sempat dibuat sudah dihapus lagi\./);
  assert.deepEqual(fake.liveCharts(), [], "no half-built chart stays on the sheet");
});

test("1b: add_chart — data at the sheet's right edge (formatted out to XFD): placement fails, the chart stays whole at Excel's default position", async () => {
  const { executeExcelActions } = await import("../src/chat/excelTools.js");
  const values = plotDataSheet().values.map((row) => { const r = [...row]; r[16380] = row[13]; return r; });
  const fake = install({}, { values, usedRange: "A1:XFD62" });
  const [line] = await executeExcelActions([{ op: "add_chart", sheet: SHEET, type: "Line", dataAddress: "XFA4:XFA62", title: "Bear D1" }]);
  assert.match(line, /^✅ Chart Line dibuat dari XFA4:XFA62 di posisi bawaan Excel \(penempatan otomatis gagal\)\./);
  assert.equal(fake.liveCharts().length, 1);
  assert.equal(fake.liveCharts()[0].title, "Bear D1", "the title is set before placement, so a placement failure cannot skip it");
});

test("1b: add_chart — when charts.add itself fails nothing is left", async () => {
  const { executeExcelActions } = await import("../src/chat/excelTools.js");
  const fake = install({ failOn: (call) => (call === "ChartCollection.add" ? excelError("The argument is invalid or missing or has an incorrect format.") : null) });
  const [line] = await executeExcelActions([{ op: "add_chart", sheet: SHEET, type: "Line", dataAddress: "N4:N62" }]);
  assert.match(line, /ChartCollection\.add\("Line", 'Plot Data'!N4:N62, "Auto"\)/);
  assert.deepEqual(fake.liveCharts(), []);
});

// --- 3b. A fallback that fails part-way leaves no bin-table sheet ----------------

test("3b: histogram fallback fails after its sheet was created: the bin-table sheet is removed and the message says so", async () => {
  const fake = install({
    unsupportedTypes: ["Histogram"],
    failOn: (call, args) => (call === "ChartCollection.add" && args[0] === '"ColumnClustered"' ? excelError("Parameter out of range") : null)
  });
  const preview = await readLiveHistogramPreview({ op: "add_histogram", sheet: SHEET, name: "Bear D1", values: "N3:N62" });
  await assert.rejects(createHistogramChart(preview), (error) => {
    assert.match(error.message, /Chart gagal dibuat: Parameter out of range\./);
    assert.match(error.message, /ChartCollection\.add\("ColumnClustered", 'Histogram Bear D1'!A1:B\d+, "Columns"\)/);
    assert.match(error.message, /Sheet "Histogram Bear D1" yang sempat dibuat untuk tabel kelas sudah dihapus lagi\./);
    return true;
  });
  assert.equal(fake.sheets["Histogram Bear D1"], undefined, "the bin-table sheet is gone");
  assert.deepEqual(Object.keys(fake.sheets), [SHEET], "only the user's sheet remains");
  assert.deepEqual(fake.liveCharts(SHEET), [], "and nothing was added to Plot Data");
});

// --- 3c. "Distribusi Bear D1" reaches the planner (histogram), not local stats ----

test("3c: bare distribution requests go to the planner; statistics wording stays local", async () => {
  const { isAnalysisRequest, analysisFollowUp } = await import("../src/chat/analysisIntent.js");
  for (const m of ["distribusi Bear D1", "sebaran Bear D2 dong", "tampilkan distribusi Bear D1", "lihat distribusinya kolom N", "histogram Bear D1"]) {
    assert.equal(isAnalysisRequest(m), false, `planner: ${m}`);
  }
  for (const m of ["statistik deskriptif Bear D1", "median dan sebaran Bear D1", "statistik distribusi Bear D1", "frekuensi transaksi per bulan", "/analisis distribusi Bear D1"]) {
    assert.equal(isAnalysisRequest(m), true, `local analytics: ${m}`);
  }
  assert.equal(analysisFollowUp({ request: "analisis data ini", options: ["Bear D1"] }, "distribusi Bear D2").type, "leave");
});

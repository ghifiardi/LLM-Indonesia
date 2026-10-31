import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisReport, fmt, fmtP } from "../src/chat/analysisReport.js";
import { tableFromGrid } from "../src/chat/analysisTable.js";
import { resolveAnalysis } from "../src/chat/analysisIntent.js";
import { sanitizeExcelActions } from "../src/chat/excelTools.js";

const SOURCE = "Data!A1:F25 (seleksi)";
const report = (request, table) => {
  const plan = resolveAnalysis(request, table);
  assert.equal(plan.kind, "run", JSON.stringify(plan));
  return buildAnalysisReport(plan.spec, table, { source: SOURCE });
};

// Upstream SciPy reference groups (tests/dashboard-stats.test.mjs).
const A = [19.8, 20.4, 19.6, 17.8, 18.5, 18.9, 18.3, 18.9, 19.5, 22.0];
const B = [28.2, 26.6, 20.1, 23.3, 25.2, 22.1, 17.7, 27.6, 20.6, 13.7, 23.2, 17.5, 20.6, 18.0, 23.9, 21.6, 24.3, 20.4, 23.9, 13.3];
const C = [22.1, 23.4, 21.0, 24.5, 22.8, 23.9, 21.7, 22.6];
const groupsTable = (labels = { A: "A", B: "B", C: "C" }, use = ["A", "B", "C"]) => tableFromGrid([
  ["Lini", "Waktu Proses"],
  ...[["A", A], ["B", B], ["C", C]].filter(([k]) => use.includes(k)).flatMap(([k, list]) => list.map((v) => [labels[k], v]))
]);

test("numbers are shown the Indonesian way; p-values never read as 0", () => {
  assert.equal(fmt(125.7142857), "125,71");
  assert.equal(fmt(12345.678), "12.346");
  assert.equal(fmt(0.012345), "0,0123");
  assert.equal(fmt(null), "–");
  assert.equal(fmtP(0.0354845), "p = 0,0355");
  assert.equal(fmtP(0), "p < 0,0001");
  assert.equal(fmtP(null), "p tidak tersedia");
});

test("describe: the engine's values are reported and the sheet holds raw numbers", () => {
  const table = tableFromGrid([["Region", "Pendapatan"], ["J", 100], ["J", 120], ["J", 140], ["B", 90], ["B", 110], ["B", ""], ["S", 150], ["S", 170]]);
  const r = report("statistik deskriptif Pendapatan", table);
  assert.match(r.text, /Statistik deskriptif/);
  assert.match(r.text, /Pendapatan — n 7 \(kosong 1\): rata-rata 125,71 · median 120/);
  assert.match(r.text, /tidak ada data yang dikirim/i);
  assert.match(r.text, /Workbook belum diubah/);
  assert.equal(r.sheet.name, "Analisis Deskriptif");
  assert.deepEqual(r.sheet.columns, ["Statistik", "Pendapatan"]);
  const row = (label) => r.sheet.rows.find((x) => x[0] === label);
  assert.equal(row("n")[1], 7);
  assert.equal(row("Jumlah")[1], 880);
  assert.equal(row("Median")[1], 120);
  assert.ok(Math.abs(row("Rata-rata")[1] - 880 / 7) < 1e-6);
});

test("describe: skewed data says the median is the typical value; groups get their own lines", () => {
  const skewed = tableFromGrid([["Nilai"], [1], [2], [3], [2], [1], [3], [2], [100]]);
  assert.match(report("statistik deskriptif", skewed).text, /median lebih mewakili/);
  const grouped = tableFromGrid([["Region", "Pendapatan"], ["J", 100], ["J", 120], ["B", 90], ["B", 110]]);
  const r = report("rata-rata Pendapatan per Region", grouped);
  assert.match(r.text, /▸ B \(2 baris\)/);
  assert.deepEqual(r.sheet.columns.slice(0, 3), ["Kelompok", "Kolom", "n"]);
  assert.deepEqual(r.sheet.rows.map((x) => [x[0], x[4]]), [["B", 100], ["J", 110]]);
});

test("correlate: strongest pair first, strength in Indonesian, causation caveat", () => {
  const rows = Array.from({ length: 12 }, (_, i) => [i, 3 * i + 2, 50 - 2 * i + (i % 3)]);
  const table = tableFromGrid([["Iklan", "Penjualan", "Retur"], ...rows]);
  const r = report("korelasi antar kolom", table);
  assert.match(r.text, /Iklan ↔ Penjualan: r = 1 \(sangat kuat, positif\)/);
  assert.match(r.text, /negatif/);
  assert.match(r.text, /bukan sebab-akibat/);
  assert.equal(r.sheet.name, "Analisis Korelasi");
  assert.equal(r.sheet.rows[0][3], 1, "the sheet keeps the engine's r");
  assert.match(r.spoken, /Iklan dan Penjualan/);
});

test("compare, two groups: Welch and Mann–Whitney from the engine, with a verdict", () => {
  const r = report("bandingkan Waktu Proses per Lini", groupsTable(undefined, ["A", "B"]));
  assert.match(r.text, /Uji Welch t: t = -2,23, df 24,52, p = 0,0355 → signifikan/);
  assert.match(r.text, /Mann–Whitney: U = 55,5, p = 0,0528 → tidak signifikan/);
  assert.match(r.text, /tidak sepakat/, "a mean test and a rank test that disagree are flagged");
  assert.match(r.text, /Kesimpulan: ada perbedaan yang signifikan/);
  assert.match(r.text, /IK 95%: -4,28 s\.d\. -0,164/);
  assert.equal(r.sheet.rows.find((x) => x[0] === "Uji Welch t")[3], 0.03548453083);
});

test("compare, three groups: ANOVA and Kruskal–Wallis", () => {
  const r = report("bandingkan Waktu Proses per Lini", groupsTable());
  assert.match(r.text, /ANOVA: F = 2,82 \(df 2; 35\), p = 0,0733 → tidak signifikan/);
  assert.match(r.text, /Kruskal–Wallis: H = 8,67, p = 0,0131 → signifikan/);
  assert.match(r.text, /Kesimpulan: tidak ada perbedaan rata-rata yang signifikan/);
});

test("compare, yes/no outcome: rates per group and a chi-squared test", () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push(["Pusat", i < 30 ? "ya" : "tidak"]);
  for (let i = 0; i < 40; i += 1) rows.push(["Cabang", i < 12 ? "ya" : "tidak"]);
  const r = report("bandingkan Tepat Waktu per Kantor", tableFromGrid([["Kantor", "Tepat Waktu"], ...rows]));
  assert.match(r.text, /Pusat — 30 dari 40 \(75%\)/);
  assert.match(r.text, /Cabang — 12 dari 40 \(30%\)/);
  assert.match(r.text, /chi-kuadrat/);
  assert.match(r.text, /signifikan/);
  assert.match(r.text, /poin persentase/);
});

test("time series: monthly totals, rising linear trend and an anomaly", () => {
  const rows = [];
  for (let m = 1; m <= 12; m += 1) {
    for (let d = 1; d <= 3; d += 1) rows.push([`2026-${String(m).padStart(2, "0")}-${String(d * 7).padStart(2, "0")}`, m === 9 ? 900 : 100 + m * 10]);
  }
  const r = report("tren Pendapatan bulanan", tableFromGrid([["Tanggal", "Pendapatan"], ...rows]));
  assert.match(r.text, /Tren "Pendapatan" \(jumlah per bulan\)/);
  assert.match(r.text, /12 periode \(2026-01 s\.d\. 2026-12\)/);
  assert.match(r.text, /Perubahan keseluruhan: 330 → 660/);
  assert.match(r.text, /Tren linear: naik/);
  assert.match(r.text, /Anomali.*2026-09/);
  assert.match(r.text, /bukan ramalan/);
  assert.deepEqual(r.sheet.columns, ["Periode", "Nilai", "Rata-rata bergerak", "Perubahan", "Perubahan (%)"]);
  assert.equal(r.sheet.rows.length, 12);
  assert.deepEqual(r.sheet.rows[0].slice(0, 2), ["2026-01", 330]);
});

test("time series: a long daily series writes only the last 60 periods and says so", () => {
  const rows = Array.from({ length: 100 }, (_, i) => [new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), 50 + (i % 5)]);
  const r = report("tren Jumlah harian", tableFromGrid([["Tanggal", "Jumlah"], ...rows]));
  assert.equal(r.sheet.rows.length, 60);
  assert.match(r.text, /60 periode terakhir/);
});

test("the result sheet passes the planner's own action validator unchanged", () => {
  const r = report("bandingkan Waktu Proses per Lini", groupsTable());
  const { actions, rejected } = sanitizeExcelActions([{ op: "add_sheet", ...r.sheet }]);
  assert.deepEqual(rejected, []);
  assert.equal(actions[0].rows.length, r.sheet.rows.length);
});

test("workbook text in the result sheet cannot become a formula", () => {
  const r = report("bandingkan Waktu Proses per Lini", groupsTable({ A: "=HYPERLINK(\"x\")", B: "B", C: "C" }));
  assert.ok(r.sheet.rows.some((x) => x[0] === "'=HYPERLINK(\"x\")"));
});

test("an engine refusal comes back as one Indonesian-prefixed error", () => {
  const table = tableFromGrid([["Lini", "Waktu"], ["A", 1], ["A", 2], ["B", 3], ["C", 4], ["C", 5]]);
  assert.throws(
    () => buildAnalysisReport({ tool: "compare_groups", args: { column: "Waktu", groupBy: "Lini" }, auto: [] }, table, { source: SOURCE }),
    /^Error: Analisis tidak bisa dijalankan: Every group needs at least 2 values/
  );
});

test("time series: a partly covered first or last month is flagged, full months are not", () => {
  const partial = tableFromGrid([["Tanggal", "Nilai"], ["2026-01-01", 1], ["2026-02-10", 2], ["2026-03-12", 3], ["2026-04-24", 4]]);
  const r = report("tren Nilai bulanan", partial);
  assert.match(r.text, /Bulan terakhir mungkin tidak lengkap \(data berhenti 2026-04-24\)/);
  assert.doesNotMatch(r.text, /Bulan pertama/);
  const full = tableFromGrid([["Tanggal", "Nilai"], ["2026-01-01", 1], ["2026-02-10", 2], ["2026-03-31", 3]]);
  assert.doesNotMatch(report("tren Nilai bulanan", full).text, /tidak lengkap/);
});

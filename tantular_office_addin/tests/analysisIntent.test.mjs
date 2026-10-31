import test from "node:test";
import assert from "node:assert/strict";
import { analysisFollowUp, findColumnMentions, isAnalysisRequest, resolveAnalysis } from "../src/chat/analysisIntent.js";
import { tableFromGrid } from "../src/chat/analysisTable.js";

// Synthetic sales table: a date, two categories, three measures, a yes/no flag.
const REGIONS = ["Jakarta", "Bandung", "Surabaya"];
function salesTable({ extraDate = false } = {}) {
  const header = ["Tanggal", "Region", "Kanal", "Pendapatan", "Pesanan", "Diskon", "Promo", ...(extraDate ? ["Tanggal Kirim"] : [])];
  const rows = Array.from({ length: 24 }, (_, i) => [
    `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`,
    REGIONS[i % 3],
    i % 2 ? "Online" : "Toko",
    100 + i * 5,
    10 + i,
    i % 7,
    i % 4 === 0 ? "ya" : "tidak",
    ...(extraDate ? ["2026-12-01"] : [])
  ]);
  return tableFromGrid([header, ...rows]);
}
const manyNumbers = () => tableFromGrid([
  Array.from({ length: 12 }, (_, i) => `m${i}`),
  ...Array.from({ length: 5 }, (_, r) => Array.from({ length: 12 }, (_, c) => r * c + c))
]);

// --- Routing: which messages take the local analytics path -----------------

test("statistics requests are recognised in Indonesian and English", () => {
  for (const message of [
    "Statistik deskriptif kolom Pendapatan",
    "berapa rata-rata dan median Pendapatan?",
    "Apakah ada korelasi antara Diskon dan Pendapatan?",
    "Bandingkan Pendapatan per Region",
    "uji t pendapatan berdasarkan kanal",
    "Tren pendapatan bulanan",
    "analisis data ini",
    "correlation between orders and revenue",
    "/analisis apa saja"
  ]) assert.equal(isAnalysisRequest(message), true, message);
});

test("chart, formula and editing requests stay on the existing planner", () => {
  for (const message of [
    "Buat chart dari data di sheet ini",
    "Tambahkan kolom Total dengan formula",
    "Jelaskan struktur sheet ini",
    "Buat sheet ringkasan dari data ini",
    "Bandingkan target dan aktual maturity dari waktu ke waktu dalam grafik",
    // The planner's own clarification example (excelChat.js system prompt).
    "Bandingkan target dan aktual maturity dari waktu ke waktu",
    "Tambahkan kolom rata-rata dengan formula",
    "terjemahkan header ke bahasa Inggris",
    "analisis sheet ini"
  ]) assert.equal(isAnalysisRequest(message), false, message);
});

test("column mentions are whole-word, case- and accent-insensitive, longest name first", () => {
  const table = salesTable({ extraDate: true });
  const mentions = findColumnMentions("Tren pendapatan per tanggal kirim, bukan tanggal", table.data.columns);
  assert.deepEqual(mentions.map((m) => m.name), ["Pendapatan", "Tanggal Kirim", "Tanggal"]);
  assert.equal(mentions[1].grouped, true, "a column right after 'per' is marked as a grouping");
  assert.deepEqual(findColumnMentions("promosi besar", ["Promo"]), [], "no partial-word matches");
});

// --- Descriptive statistics -------------------------------------------------

test("describe: named columns, or every numeric column when none is named", () => {
  const table = salesTable();
  const named = resolveAnalysis("statistik deskriptif Pendapatan dan Diskon", table);
  assert.equal(named.kind, "run");
  assert.deepEqual(named.spec, { tool: "statistics", args: { columns: ["Pendapatan", "Diskon"] }, auto: [] });
  const all = resolveAnalysis("statistik deskriptif", table);
  assert.deepEqual(all.spec.args.columns, ["Pendapatan", "Pesanan", "Diskon"]);
  assert.match(all.spec.auto[0], /Semua 3 kolom angka/);
  const grouped = resolveAnalysis("rata-rata Pendapatan per Region", table);
  assert.deepEqual(grouped.spec.args, { columns: ["Pendapatan"], groupBy: "Region" });
});

test("describe: a table with more than 10 numeric columns asks which ones", () => {
  const plan = resolveAnalysis("statistik deskriptif", manyNumbers());
  assert.equal(plan.kind, "clarify");
  assert.match(plan.question, /kolom angka mana/i);
  assert.equal(plan.options.length, 6);
  assert.match(plan.question, /ketik nama kolom/);
});

test("describe: a text-only column is refused with the numeric choices", () => {
  const plan = resolveAnalysis("statistik deskriptif", tableFromGrid([["a", "b"], ["x", "y"], ["z", "w"]]));
  assert.equal(plan.kind, "refuse");
  assert.match(plan.text, /tidak ada kolom angka/i);
});

// --- Correlation ------------------------------------------------------------

test("correlate: two named columns, all numeric columns, or a question for the partner", () => {
  const table = salesTable();
  assert.deepEqual(resolveAnalysis("korelasi Diskon dan Pendapatan", table).spec.args, { columns: ["Diskon", "Pendapatan"] });
  assert.deepEqual(resolveAnalysis("korelasi antar kolom", table).spec.args, { columns: ["Pendapatan", "Pesanan", "Diskon"] });
  const one = resolveAnalysis("korelasi Pendapatan", table);
  assert.equal(one.kind, "clarify");
  assert.match(one.question, /Pendapatan/);
  assert.deepEqual(one.options, ["Pesanan", "Diskon", "Semua kolom angka"]);
  // The chip label answers the question.
  const answered = resolveAnalysis(analysisFollowUp({ request: "korelasi Pendapatan" }, "Diskon").request, table);
  assert.deepEqual(answered.spec.args, { columns: ["Pendapatan", "Diskon"] });
  const all = resolveAnalysis(analysisFollowUp({ request: "korelasi Pendapatan" }, "Semua kolom angka").request, table);
  assert.deepEqual(all.spec.args.columns, ["Pendapatan", "Pesanan", "Diskon"]);
});

test("correlate: a yes/no column is passed through (the engine reads it as 1/0)", () => {
  assert.deepEqual(resolveAnalysis("hubungan Promo dan Pendapatan", salesTable()).spec.args, { columns: ["Promo", "Pendapatan"] });
});

test("correlate: a measure against a category becomes a group comparison", () => {
  const plan = resolveAnalysis("apakah ada hubungan antara Region dan Pendapatan?", salesTable());
  assert.equal(plan.spec.tool, "compare_groups");
  assert.deepEqual(plan.spec.args, { column: "Pendapatan", groupBy: "Region" });
  assert.match(plan.spec.auto.join(" "), /kategori/);
});

// --- Group comparison -------------------------------------------------------

test("compare: value and group from the request", () => {
  const plan = resolveAnalysis("Bandingkan Pendapatan berdasarkan Kanal", salesTable());
  assert.deepEqual(plan.spec, { tool: "compare_groups", args: { column: "Pendapatan", groupBy: "Kanal" }, auto: [] });
});

test("compare: asks for the measure, then for the grouping, then runs", () => {
  const table = salesTable();
  const first = resolveAnalysis("bandingkan antar kelompok", table);
  assert.equal(first.kind, "clarify");
  assert.match(first.question, /ukuran.*dibandingkan/i);
  assert.deepEqual(first.options, ["Pendapatan", "Pesanan", "Diskon"]);
  const step2 = analysisFollowUp({ request: "bandingkan antar kelompok" }, "Pesanan");
  const second = resolveAnalysis(step2.request, table);
  assert.equal(second.kind, "clarify");
  assert.match(second.question, /kelompok/);
  assert.deepEqual(second.options, ["Region", "Kanal", "Promo"]);
  const third = resolveAnalysis(analysisFollowUp({ request: step2.request }, "Region").request, table);
  assert.deepEqual(third.spec.args, { column: "Pesanan", groupBy: "Region" });
});

test("compare: a yes/no outcome by group is passed to the engine's proportion test", () => {
  assert.deepEqual(resolveAnalysis("bandingkan Promo per Region", salesTable()).spec.args, { column: "Promo", groupBy: "Region" });
});

test("compare: a grouping with more than 10 values is refused before the engine runs", () => {
  const table = tableFromGrid([["Toko", "Omzet"], ...Array.from({ length: 30 }, (_, i) => [`T${i % 15}`, i])]);
  const plan = resolveAnalysis("bandingkan Omzet per Toko", table);
  assert.equal(plan.kind, "refuse");
  assert.match(plan.text, /15 nilai/);
});

// --- Time series ------------------------------------------------------------

test("time series: date column found, value named, period from the request", () => {
  const plan = resolveAnalysis("tren Pendapatan bulanan", salesTable());
  assert.deepEqual(plan.spec, { tool: "time_series", args: { date: "Tanggal", value: "Pendapatan", metric: "sum", period: "month" }, auto: [] });
  const avg = resolveAnalysis("rata-rata Pendapatan per minggu dari waktu ke waktu", salesTable());
  assert.deepEqual(avg.spec.args, { date: "Tanggal", value: "Pendapatan", metric: "avg", period: "week" });
});

test("time series: counting rows, automatic period, and the question for the measure", () => {
  const table = salesTable();
  const count = resolveAnalysis("tren jumlah transaksi", table);
  assert.equal(count.spec.args.metric, "count");
  assert.equal(count.spec.args.value, undefined);
  assert.equal(count.spec.args.period, "month", "24 rows over a year: monthly is the automatic choice");
  assert.match(count.spec.auto.join(" "), /otomatis/);
  const ask = resolveAnalysis("tren dari waktu ke waktu", table);
  assert.equal(ask.kind, "clarify");
  assert.deepEqual(ask.options, ["Pendapatan", "Pesanan", "Diskon", "Jumlah baris"]);
});

test("time series: two date columns ask which one; none refuses", () => {
  const ask = resolveAnalysis("tren Pendapatan bulanan", salesTable({ extraDate: true }));
  assert.equal(ask.kind, "clarify");
  assert.deepEqual(ask.options, ["Tanggal", "Tanggal Kirim"]);
  const none = resolveAnalysis("tren Omzet", tableFromGrid([["Toko", "Omzet"], ["A", 1], ["B", 2]]));
  assert.equal(none.kind, "refuse");
  assert.match(none.text, /kolom tanggal/);
});

// --- Intent and follow-ups --------------------------------------------------

test("a generic request asks which analysis, and the chip answers it", () => {
  const table = salesTable();
  const plan = resolveAnalysis("analisis data ini", table);
  assert.equal(plan.kind, "clarify");
  assert.deepEqual(plan.options, ["Statistik deskriptif", "Korelasi antar kolom", "Bandingkan kelompok", "Tren dari waktu ke waktu"]);
  const next = resolveAnalysis(analysisFollowUp({ request: "analisis data ini" }, "Statistik deskriptif").request, table);
  assert.equal(next.spec.tool, "statistics");
});

test("follow-ups: cancel, a fresh analysis request, or leaving for the planner", () => {
  const pending = { request: "korelasi Pendapatan" };
  assert.deepEqual(analysisFollowUp(pending, "batal"), { type: "cancel" });
  assert.deepEqual(analysisFollowUp(pending, "Tren pendapatan bulanan"), { type: "new", request: "Tren pendapatan bulanan" });
  assert.deepEqual(analysisFollowUp(pending, "buat chart dari data ini"), { type: "leave" });
  assert.deepEqual(analysisFollowUp(pending, "Diskon"), { type: "answer", request: "korelasi Pendapatan\nDiskon" });
});

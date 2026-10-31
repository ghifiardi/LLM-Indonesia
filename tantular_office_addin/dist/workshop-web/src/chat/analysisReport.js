// Runs one resolved analysis on the vendored statistics engine and turns its
// result into what the Excel chat shows: an Indonesian report, a short spoken
// line, and an optional result sheet (written only through the chat's normal
// preview → "Terapkan" path). The numbers are the engine's own; this module
// only formats them. Pure and Office-free for unit tests.

import {
  compareGroupsTool,
  correlateTool,
  linearTrendTool,
  statisticsTool,
  timeSeriesTool
} from "../vendor/tantular-dashboard/stats.mjs";
import { safeSheetValue } from "./analysisTable.js";

// Same caps the planner's add_sheet validator applies (excelTools.js).
const SHEET_MAX_ROWS = 60;
const SHEET_MAX_COLS = 20;
const RECENT_PERIODS = 6;
const MAX_ANOMALIES = 5;
const LOCAL_FOOTER = "Dihitung lokal di panel ini dari data workbook; tidak ada data yang dikirim ke model atau layanan luar. Workbook belum diubah.";

const decimals = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const small = new Intl.NumberFormat("id-ID", { maximumSignificantDigits: 3 });
const pFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });

export function fmt(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a >= 10_000) return whole.format(x);
  if (a !== 0 && a < 1) return small.format(x);
  return decimals.format(x);
}

const signed = (x) => (Number.isFinite(x) && x > 0 ? `+${fmt(x)}` : fmt(x));

export function fmtP(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return "p tidak tersedia";
  return p < 0.0001 ? "p < 0,0001" : `p = ${pFormat.format(p)}`;
}

const significance = (p) => (p === null || p === undefined ? "" : p < 0.05 ? " → signifikan (p < 0,05)" : " → tidak signifikan");
const isSignificant = (p) => Number.isFinite(p) && p < 0.05;

const STRENGTH = { negligible: "dapat diabaikan", weak: "lemah", moderate: "sedang", strong: "kuat", "very strong": "sangat kuat" };
function strengthText(label) {
  if (!label) return "";
  if (label === "negligible") return STRENGTH.negligible;
  const direction = label.endsWith("positive") ? "positif" : "negatif";
  return `${STRENGTH[label.replace(/ (positive|negative)$/, "")] ?? label}, ${direction}`;
}
const REASONS = {
  "Fewer than 3 rows have both values.": "kurang dari 3 baris berisi kedua nilai",
  "One of the columns is constant over these rows.": "salah satu kolom bernilai sama di semua baris"
};
const reasonText = (reason) => REASONS[reason] ?? reason;

function sheetOf(name, columns, rows, notes) {
  const width = Math.min(columns.length, SHEET_MAX_COLS);
  let kept = rows;
  if (rows.length > SHEET_MAX_ROWS) {
    kept = rows.slice(0, SHEET_MAX_ROWS);
    notes.push(`Sheet hasil memuat ${SHEET_MAX_ROWS} dari ${rows.length} baris hasil.`);
  }
  return {
    name,
    columns: columns.slice(0, width).map((c) => String(safeSheetValue(c))),
    rows: kept.map((row) => Array.from({ length: width }, (_, i) => safeSheetValue(row[i])))
  };
}

// --- Descriptive statistics -------------------------------------------------

const DESCRIBE_ROWS = [
  ["n", (d) => d.n], ["Kosong", (d) => d.nulls], ["Jumlah", (d) => d.sum], ["Rata-rata", (d) => d.mean],
  ["Median", (d) => d.median], ["Simpangan baku", (d) => d.std], ["Varians", (d) => d.variance], ["Min", (d) => d.min],
  ["Q1", (d) => d.q1], ["Q3", (d) => d.q3], ["Maks", (d) => d.max], ["Rentang", (d) => d.range], ["IQR", (d) => d.iqr],
  ["Koefisien variasi", (d) => d.cv], ["Skewness", (d) => d.skewness], ["Outlier (1,5×IQR)", (d) => d.outliers?.count]
];

function describeLine(d) {
  if (!d.n) return `• ${d.column} — tidak ada nilai angka.`;
  const lines = [`• ${d.column} — n ${d.n}${d.nulls ? ` (kosong ${d.nulls})` : ""}: rata-rata ${fmt(d.mean)} · median ${fmt(d.median)} · simpangan baku ${fmt(d.std)} · min ${fmt(d.min)} · Q1 ${fmt(d.q1)} · Q3 ${fmt(d.q3)} · maks ${fmt(d.max)}`];
  if (d.outliers?.count) lines.push(`  Outlier (aturan 1,5×IQR): ${d.outliers.count} nilai di luar ${fmt(d.outliers.below)} s.d. ${fmt(d.outliers.above)} — periksa, jangan langsung dihapus.`);
  if (Number.isFinite(d.skewness) && Math.abs(d.skewness) >= 1) lines.push(`  Data menceng (skewness ${fmt(d.skewness)}): median lebih mewakili nilai tipikal daripada rata-rata.`);
  return lines.join("\n");
}

function describeReport(result, args, notes) {
  const lines = [];
  let sheet;
  if (args.groupBy) {
    lines.push(`Statistik deskriptif per "${args.groupBy}" (${result.results.length} kelompok)`);
    const rows = [];
    for (const g of result.results) {
      lines.push(`▸ ${g.group} (${g.rows} baris)`);
      for (const d of g.columns) {
        lines.push(d.n ? `  ${d.column}: n ${d.n} · rata-rata ${fmt(d.mean)} · median ${fmt(d.median)} · simpangan baku ${fmt(d.std)} · min ${fmt(d.min)} · maks ${fmt(d.max)}` : `  ${d.column}: tidak ada nilai angka.`);
        rows.push([g.group, d.column, d.n, d.nulls, d.mean, d.median, d.std, d.min, d.q1, d.q3, d.max]);
      }
    }
    sheet = sheetOf("Analisis Deskriptif", ["Kelompok", "Kolom", "n", "Kosong", "Rata-rata", "Median", "Simpangan baku", "Min", "Q1", "Q3", "Maks"], rows, notes);
  } else {
    const columns = result.results[0].columns;
    lines.push(`Statistik deskriptif (${columns.length} kolom, ${result.matchedRows} baris data)`);
    lines.push(...columns.map(describeLine));
    sheet = sheetOf("Analisis Deskriptif", ["Statistik", ...columns.map((d) => d.column)], DESCRIBE_ROWS.map(([label, get]) => [label, ...columns.map((d) => (d.n ? get(d) : null))]), notes);
  }
  lines.push("Simpangan baku dan varians adalah statistik sampel (n − 1); kuartil memakai interpolasi linear seperti PERCENTILE.INC di Excel.");
  return { lines, sheet, spoken: `Statistik deskriptif untuk ${args.columns.length} kolom sudah dihitung lokal. Hasilnya ada di panel.` };
}

// --- Correlation ------------------------------------------------------------

function correlateReport(result, notes) {
  const lines = [`Korelasi (${result.pairs.length} pasangan kolom, terkuat lebih dulu)`];
  const rows = [];
  for (const p of result.pairs) {
    const method = p.method ? ` [${p.method}]` : "";
    if (!p.pearson) {
      lines.push(`• ${p.x} ↔ ${p.y}: tidak bisa dihitung — ${reasonText(p.reason)} (n ${p.n}).`);
      rows.push([p.x, p.y, p.n, null, null, null, null, null, "", reasonText(p.reason)]);
      continue;
    }
    const sp = p.spearman ? ` · Spearman ρ = ${fmt(p.spearman.rho)}` : "";
    lines.push(`• ${p.x} ↔ ${p.y}: r = ${fmt(p.pearson.r)} (${strengthText(p.pearson.strength)})${sp} · ${fmtP(p.pearson.p_value)}${significance(p.pearson.p_value)} · n ${p.n}${method}`);
    rows.push([p.x, p.y, p.n, p.pearson.r, p.pearson.r2, p.pearson.p_value, p.spearman?.rho ?? null, p.spearman?.p_value ?? null, strengthText(p.pearson.strength), p.method ?? ""]);
  }
  for (const [column, coded] of Object.entries(result.coded ?? {})) {
    lines.push(`Kolom ya/tidak "${column}" dibaca sebagai 1 (${coded.one.join(", ")}) dan 0 (${coded.zero.join(", ")}).`);
  }
  lines.push("Korelasi menunjukkan dua kolom bergerak bersama, bukan sebab-akibat. Pearson mengukur hubungan garis lurus; Spearman hubungan naik/turun yang konsisten dan lebih tahan outlier.");
  const best = result.pairs.find((p) => p.pearson);
  const spoken = best
    ? `Korelasi terkuat: ${best.x} dan ${best.y}, r ${fmt(best.pearson.r)}, ${strengthText(best.pearson.strength)}.`
    : "Korelasi tidak bisa dihitung untuk kolom ini.";
  return {
    lines,
    sheet: sheetOf("Analisis Korelasi", ["Kolom X", "Kolom Y", "n", "Pearson r", "r²", "p (Pearson)", "Spearman ρ", "p (Spearman)", "Kekuatan", "Catatan"], rows, notes),
    spoken
  };
}

// --- Group comparison -------------------------------------------------------

function proportionReport(result, notes) {
  const lines = [`Perbandingan proporsi "${result.column}" (nilai ya) berdasarkan "${result.groupBy}" (${result.groups.length} kelompok)`];
  for (const g of result.groups) lines.push(`• ${g.group} — ${g.events} dari ${g.n} (${fmt(g.rate_pct)}%)`);
  const chi = result.chi_squared;
  const rows = result.groups.map((g) => [g.group, g.n, g.events, g.rate_pct]);
  if (chi.p_value === null) {
    lines.push("Semua baris punya hasil yang sama, jadi tidak ada yang bisa diuji.");
  } else {
    lines.push(`Uji chi-kuadrat: χ² = ${fmt(chi.statistic)} (df ${chi.df}), ${fmtP(chi.p_value)}${significance(chi.p_value)} · Cramér's V ${fmt(chi.cramers_v)}`);
    rows.push([], ["Uji chi-kuadrat", chi.statistic, chi.df, chi.p_value, "Cramér's V", chi.cramers_v]);
  }
  if (result.difference) {
    const d = result.difference;
    lines.push(`Selisih (${d.of}): ${signed(d.percentage_points)} poin persentase (IK 95%: ${fmt(d.ci95_percentage_points[0])} s.d. ${fmt(d.ci95_percentage_points[1])})${d.rate_ratio ? ` · rasio ${fmt(d.rate_ratio)}×` : ""}`);
  }
  if (result.warning) lines.push("⚠️ Beberapa sel punya frekuensi harapan di bawah 5, jadi p-value chi-kuadrat bisa tidak andal. Gabungkan kelompok kecil.");
  const verdict = chi.p_value === null ? "Tidak ada variasi untuk diuji."
    : isSignificant(chi.p_value) ? `Kesimpulan: proporsi berbeda signifikan antar kelompok (${fmtP(chi.p_value)}).`
      : `Kesimpulan: tidak ada perbedaan proporsi yang signifikan (${fmtP(chi.p_value)}).`;
  lines.push(verdict);
  return { lines, sheet: sheetOf("Analisis Perbandingan", ["Kelompok", "n", "Ya", "Persentase ya (%)", "", ""], rows, notes), spoken: verdict };
}

function compareReport(result, notes) {
  if (result.outcome === "yes/no") return proportionReport(result, notes);
  const lines = [`Perbandingan "${result.column}" berdasarkan "${result.groupBy}" (${result.groups.length} kelompok)`];
  for (const g of result.groups) lines.push(`• ${g.group} — n ${g.n} · rata-rata ${fmt(g.mean)} · median ${fmt(g.median)} · simpangan baku ${fmt(g.std)} · min ${fmt(g.min)} · maks ${fmt(g.max)}`);
  const rows = result.groups.map((g) => [g.group, g.n, g.mean, g.median, g.std, g.min, g.max]);
  rows.push([], ["Uji", "Statistik", "df", "p-value", "Ukuran efek", "Nilai efek", ""]);
  let primaryP = null;
  let rankP = null;
  if (result.groups.length === 2) {
    const { difference: d, welch_t_test: w, mann_whitney: m } = result;
    lines.push(`Selisih rata-rata (${d.of}): ${fmt(d.mean_difference)}${d.ci95 ? ` (IK 95%: ${fmt(d.ci95[0])} s.d. ${fmt(d.ci95[1])})` : ""}${d.cohens_d === null ? "" : ` · Cohen's d ${fmt(d.cohens_d)}`}`);
    if (w) {
      lines.push(`Uji Welch t: t = ${fmt(w.t)}, df ${fmt(w.df)}, ${fmtP(w.p_value)}${significance(w.p_value)}`);
      rows.push(["Uji Welch t", w.t, w.df, w.p_value, "Cohen's d", d.cohens_d, ""]);
      primaryP = w.p_value;
    }
    if (m) {
      lines.push(`Mann–Whitney: U = ${fmt(m.u)}, ${fmtP(m.p_value)}${significance(m.p_value)}`);
      rows.push(["Mann–Whitney U", m.u, "", m.p_value, "", "", ""]);
      rankP = m.p_value;
    }
  } else {
    const { anova: a, kruskal_wallis: k } = result;
    if (a) {
      lines.push(`ANOVA: F = ${fmt(a.f)} (df ${a.df_between}; ${a.df_within}), ${fmtP(a.p_value)}${significance(a.p_value)} · η² = ${fmt(a.eta_squared)}`);
      rows.push(["ANOVA", a.f, `${a.df_between}; ${a.df_within}`, a.p_value, "η²", a.eta_squared, ""]);
      primaryP = a.p_value;
    }
    if (k) {
      lines.push(`Kruskal–Wallis: H = ${fmt(k.h)}, ${fmtP(k.p_value)}${significance(k.p_value)}`);
      rows.push(["Kruskal–Wallis", k.h, k.df, k.p_value, "", "", ""]);
      rankP = k.p_value;
    }
  }
  if (primaryP !== null && rankP !== null && isSignificant(primaryP) !== isSignificant(rankP)) {
    lines.push("⚠️ Uji rata-rata dan uji peringkat tidak sepakat: periksa outlier atau data yang menceng sebelum menyimpulkan.");
  }
  const many = result.groups.length > 2;
  const verdict = primaryP === null ? "Kesimpulan: uji tidak bisa dihitung (variasi data nol)."
    : isSignificant(primaryP)
      ? `Kesimpulan: ada perbedaan yang signifikan secara statistik antar kelompok (${fmtP(primaryP)}).${many ? " Artinya minimal satu kelompok berbeda; bandingkan pasangan tertentu untuk tahu yang mana." : ""}`
      : `Kesimpulan: tidak ada perbedaan rata-rata yang signifikan secara statistik (${fmtP(primaryP)}).`;
  lines.push(verdict);
  lines.push("Ini perbandingan observasional: perbedaan antar kelompok tidak menunjukkan penyebabnya. Nilai p di bawah 0,05 lazim disebut signifikan; nilai efek menunjukkan apakah selisihnya cukup besar untuk berarti.");
  return { lines, sheet: sheetOf("Analisis Perbandingan", ["Kelompok", "n", "Rata-rata", "Median", "Simpangan baku", "Min", "Maks"], rows, notes), spoken: verdict };
}

// --- Time series --------------------------------------------------------------

const PERIOD = { day: "hari", week: "minggu", month: "bulan" };
const PERIOD_DAYS = { day: 1, week: 7, month: 365.25 / 12 };
const DIRECTION = { rising: "naik", falling: "turun", flat: "datar" };
const METRIC = { sum: "jumlah", avg: "rata-rata", count: "jumlah baris" };

// The trend line is fitted on the aggregated periods (what the user sees),
// with the engine's own linear_trend over each period's start date.
function periodTrend(series, period) {
  const rows = series.filter((p) => p.value !== null).map((p) => [period === "month" ? `${p.period}-01` : p.period, p.value]);
  return linearTrendTool({ columns: ["periode", "nilai"], types: ["text", "number"], rows }, { x: "periode", y: "nilai" });
}

// A first or last week/month that the data covers only partly makes "overall
// change" and the trend look like a jump or a drop. Flag it; never adjust.
function partialPeriods(table, args) {
  if (args.period === "day") return [];
  const i = table.data.columns.indexOf(args.date);
  const days = table.data.rows.map((r) => r[i]).filter((v) => typeof v === "string").map((v) => new Date(`${v.slice(0, 10)}T00:00:00Z`));
  if (!days.length) return [];
  const first = new Date(Math.min(...days));
  const last = new Date(Math.max(...days));
  const startsFull = args.period === "month" ? first.getUTCDate() === 1 : first.getUTCDay() === 1;
  const endOfMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
  const endsFull = args.period === "month" ? last.getUTCDate() === endOfMonth : last.getUTCDay() === 0;
  const unit = PERIOD[args.period];
  const iso = (d) => d.toISOString().slice(0, 10);
  const warn = (which, what) => `⚠️ ${unit[0].toUpperCase()}${unit.slice(1)} ${which} mungkin tidak lengkap (${what}); perubahan keseluruhan dan tren bisa terpengaruh.`;
  return [
    ...(startsFull ? [] : [warn("pertama", `data baru mulai ${iso(first)}`)]),
    ...(endsFull ? [] : [warn("terakhir", `data berhenti ${iso(last)}`)])
  ];
}

function timeSeriesReport(result, notes, table, args) {
  const unit = PERIOD[result.period];
  const title = result.metric === "count"
    ? `Tren jumlah baris per ${unit}`
    : `Tren "${result.value}" (${METRIC[result.metric]} per ${unit})`;
  const series = result.series;
  const lines = [title];
  if (series.length) lines.push(`Kolom tanggal: "${result.date}" · ${result.periods} periode (${series[0].period} s.d. ${series[series.length - 1].period})`);
  if (result.shown) lines.push(`Ditampilkan ${series.length} periode terakhir dari ${result.periods}.`);
  if (result.overall) {
    const first = series.find((p) => p.period === result.overall.from)?.value;
    const last = series.find((p) => p.period === result.overall.to)?.value;
    const pct = result.overall.change_pct === null ? "" : ` (${signed(result.overall.change_pct)}%)`;
    lines.push(`Perubahan keseluruhan: ${first === undefined ? result.overall.from : fmt(first)} → ${last === undefined ? result.overall.to : fmt(last)}${pct}`);
  }
  lines.push(...partialPeriods(table, args));
  let spoken = title;
  const trend = series.length >= 3 ? periodTrend(series, result.period) : null;
  if (trend && trend.slope !== null) {
    const perPeriod = trend.slope * PERIOD_DAYS[result.period];
    const weak = !isSignificant(trend.p_value);
    lines.push(`Tren linear: ${DIRECTION[trend.direction]} ≈ ${fmt(Math.abs(perPeriod))} per ${unit} (r² ${fmt(trend.r2)}, ${fmtP(trend.p_value)})${weak ? " — tidak signifikan; belum ada tren yang jelas" : ""}`);
    spoken = weak ? `${title}: belum ada tren yang jelas.` : `${title}: ${DIRECTION[trend.direction]} sekitar ${fmt(Math.abs(perPeriod))} per ${unit}.`;
  } else {
    lines.push("Tren linear: butuh minimal 3 periode berisi nilai.");
  }
  if (result.anomalies.length) {
    const shown = result.anomalies.slice(0, MAX_ANOMALIES).map((a) => `${a.period} = ${fmt(a.value)} (perkiraan ${fmt(a.expected)})`);
    lines.push(`Anomali (lebih dari 2,5 simpangan baku dari rata-rata ${result.window} ${unit} sebelumnya): ${shown.join("; ")}${result.anomalies.length > MAX_ANOMALIES ? "; …" : ""}`);
  }
  const recent = series.slice(-RECENT_PERIODS);
  if (recent.length) {
    lines.push(`Periode terakhir (rata-rata bergerak ${result.window} ${unit}):`);
    for (const p of recent) {
      const extra = [p.moving_avg === null ? "" : `rata-rata bergerak ${fmt(p.moving_avg)}`, p.change_pct === null ? "" : `${signed(p.change_pct)}%`].filter(Boolean).join("; ");
      lines.push(`  ${p.period}: ${fmt(p.value)}${extra ? ` (${extra})` : ""}`);
    }
  }
  lines.push("Periode tanpa baris tidak ditampilkan (bukan dihitung nol). Tren menggambarkan data lampau, bukan ramalan.");
  let rows = series.map((p) => [p.period, p.value, p.moving_avg, p.change, p.change_pct]);
  if (rows.length > SHEET_MAX_ROWS) {
    rows = rows.slice(-SHEET_MAX_ROWS);
    notes.push(`Sheet hasil memuat ${SHEET_MAX_ROWS} periode terakhir dari ${result.periods}.`);
  }
  return { lines, sheet: sheetOf("Analisis Tren", ["Periode", "Nilai", "Rata-rata bergerak", "Perubahan", "Perubahan (%)"], rows, notes), spoken };
}

// --- Entry point --------------------------------------------------------------

const TOOLS = {
  statistics: statisticsTool,
  correlate: correlateTool,
  compare_groups: compareGroupsTool,
  time_series: timeSeriesTool
};

// spec: { tool, args, auto } from resolveAnalysis; table: tableFromGrid().
// Returns { text, spoken, sheet: { name, columns, rows }, result }.
export function buildAnalysisReport(spec, table, { source = "" } = {}) {
  const tool = TOOLS[spec.tool];
  if (!tool) throw new Error(`Analisis "${spec.tool}" tidak didukung.`);
  let result;
  try {
    result = tool(table.data, spec.args);
  } catch (error) {
    throw new Error(`Analisis tidak bisa dijalankan: ${error?.message || error}`);
  }
  const sheetNotes = [];
  const part = spec.tool === "statistics" ? describeReport(result, spec.args, sheetNotes)
    : spec.tool === "correlate" ? correlateReport(result, sheetNotes)
      : spec.tool === "compare_groups" ? compareReport(result, sheetNotes)
        : timeSeriesReport(result, sheetNotes, table, spec.args);
  const [title, ...body] = part.lines;
  const context = [
    `Sumber: ${source || table.data.name} · ${table.data.rows.length} baris data`,
    ...(spec.auto || []).map((note) => `ℹ️ ${note}`),
    ...(table.notes || []).map((note) => `ℹ️ ${note}`)
  ];
  const text = [title, ...context, "", ...body, ...sheetNotes.map((note) => `ℹ️ ${note}`), "", LOCAL_FOOTER].join("\n");
  return { text, spoken: part.spoken, sheet: part.sheet, result };
}

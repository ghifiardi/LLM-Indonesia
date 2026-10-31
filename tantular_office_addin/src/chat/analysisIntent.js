// Local analytics for the Excel chat: which requests it takes, and which
// statistical tool + columns a request means. Deterministic on purpose — no
// model reads the request or the table here, so nothing from the workbook can
// leave the pane (the planner's runTantular may be a cloud gateway). When the
// columns or the intent are unclear it asks ONE question with the table's own
// column names as one-click answers; answers accumulate onto the original
// request (`analysisFollowUp`) and the whole text is resolved again.
// Pure and Office-free for unit tests.

import { isCancelReply, MAX_CLARIFY_OPTIONS } from "./excelClarify.js";

// Upstream limits (stats.mjs): statistics 1–10 columns and ≤30 groups,
// correlate 2–8 columns, compare_groups ≤10 groups.
const MAX_DESCRIBE_COLUMNS = 10;
const MAX_DESCRIBE_GROUPS = 30;
const MAX_CORRELATE_COLUMNS = 8;
const MAX_COMPARE_GROUPS = 10;

export const INTENT_OPTIONS = {
  statistics: "Statistik deskriptif",
  correlate: "Korelasi antar kolom",
  compare_groups: "Bandingkan kelompok",
  time_series: "Tren dari waktu ke waktu"
};
const ALL_NUMERIC_OPTION = "Semua kolom angka";
const COUNT_OPTION = "Jumlah baris";

// Phrases are matched as whole words on normalized text (see norm()).
const DESCRIBE = ["statistik deskriptif", "deskriptif", "statistik", "ringkasan statistik", "rata rata", "ratarata", "rerata",
  "median", "standar deviasi", "simpangan baku", "varians", "kuartil", "persentil", "pencilan", "outlier", "distribusi",
  "sebaran", "describe", "descriptive", "summary statistics", "statistics", "mean", "average", "std"];
const CORRELATE = ["korelasi", "berkorelasi", "korelasikan", "mengkorelasikan", "hubungan", "keterkaitan", "berhubungan",
  "correlation", "correlate", "correlations", "relationship", "pearson", "spearman"];
const COMPARE = ["bandingkan", "perbandingan", "membandingkan", "dibandingkan", "perbedaan", "berbeda", "uji t", "t test",
  "ttest", "anova", "kruskal", "mann whitney", "compare", "comparison", "difference", "antar kelompok", "signifikan"];
const TIME = ["tren", "trend", "dari waktu ke waktu", "time series", "timeseries", "deret waktu", "runtun waktu", "harian",
  "mingguan", "bulanan", "per hari", "per minggu", "per bulan", "tiap bulan", "setiap bulan", "tiap minggu", "setiap minggu",
  "tiap hari", "setiap hari", "moving average", "rata rata bergerak", "anomali", "over time", "daily", "weekly", "monthly",
  "per day", "per week", "per month", "perkembangan", "pertumbuhan"];
const GENERIC = ["analisis data", "analisa data", "analisis statistik", "analisa statistik", "analyze data", "analyse data",
  "data analysis", "statistical analysis", "analisis kolom", "analisis tabel", "analisa tabel"];
// Words that only statistics use: they keep a request here even when it also
// sounds like a chart ("bandingkan … dari waktu ke waktu" alone is a chart).
const STATS_ONLY = ["deskriptif", "statistik", "korelasi", "uji t", "t test", "anova", "signifikan", "median", "simpangan baku",
  "standar deviasi", "moving average", "rata rata bergerak", "anomali", "kruskal", "mann whitney", "time series", "deret waktu",
  "pearson", "spearman", "outlier", "pencilan", "statistics", "correlation"];
// Requests to change the workbook or draw stay with the planner.
const ACTION = ["chart", "grafik", "diagram", "plot", "visualisasi", "formula", "rumus", "tulis", "tambahkan", "tambah kolom",
  "hapus", "terjemahkan", "translate", "rapikan", "format", "isi kolom", "buat kolom", "sisipkan"];
const GROUP_WORDS = new Set(["per", "berdasarkan", "menurut", "antar", "tiap", "setiap", "by", "across", "kelompok", "dikelompokkan"]);
const PERIODS = {
  day: ["harian", "per hari", "tiap hari", "setiap hari", "daily", "per day"],
  week: ["mingguan", "per minggu", "tiap minggu", "setiap minggu", "weekly", "per week"],
  month: ["bulanan", "per bulan", "tiap bulan", "setiap bulan", "monthly", "per month"]
};
const PERIOD_LABEL = { day: "harian", week: "mingguan", month: "bulanan" };
const AVG = ["rata rata", "ratarata", "rerata", "average", "mean", "avg"];
const COUNT = ["jumlah baris", "banyak baris", "banyaknya baris", "jumlah data", "jumlah record", "jumlah transaksi",
  "banyak transaksi", "banyaknya transaksi", "count", "frekuensi", "berapa banyak", "number of rows", "jumlah baris data"];
const ALL_NUMERIC = ["semua kolom angka", "semua kolom numerik", "all numeric columns"];
const FORCE_RE = /^\s*(?:\/analisis|\/analysis|analisis lokal\s*:|analisis\s*:)/i;
const YES_NO = new Set(["yes", "y", "true", "ya", "no", "n", "false", "tidak"]);

export function norm(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim();
}

const has = (text, phrases) => phrases.some((p) => ` ${text} `.includes(` ${p} `));
const withoutMovingAverage = (text) => text.replace(/rata rata bergerak/g, " ");

function intentsOf(text) {
  const n = norm(text);
  const found = new Set();
  if (has(n, TIME)) found.add("time_series");
  if (has(n, CORRELATE)) found.add("correlate");
  if (has(n, COMPARE)) found.add("compare_groups");
  // "rata-rata bergerak" is a moving average (time series), not a mean.
  if (has(withoutMovingAverage(n), DESCRIBE)) found.add("statistics");
  return found;
}

function hasAnalysisWords(text) {
  const n = norm(text);
  return intentsOf(text).size > 0 || has(n, GENERIC);
}

// Does this message take the local analytics path (instead of the planner)?
export function isAnalysisRequest(message) {
  const text = String(message || "");
  if (FORCE_RE.test(text)) return true;
  const n = norm(text);
  if (has(n, ACTION)) return false;
  if (!hasAnalysisWords(text)) return false;
  // "Bandingkan target dan aktual dari waktu ke waktu" is a chart request.
  const intents = intentsOf(text);
  if (intents.has("compare_groups") && intents.has("time_series") && !has(n, STATS_ONLY)) return false;
  return true;
}

// What the next message means while an analytics question is open.
export function analysisFollowUp(pending, message) {
  const text = String(message || "").trim();
  if (isCancelReply(text)) return { type: "cancel" };
  const options = (pending?.options || []).map((o) => o.toLowerCase());
  if (!options.includes(text.toLowerCase())) {
    if (has(norm(text), ACTION)) return { type: "leave" };
    if (isAnalysisRequest(text) && intentsOf(text).size) return { type: "new", request: text };
  }
  return { type: "answer", request: `${pending.request}\n${text}` };
}

// Column names mentioned in the text, in order of appearance. Longer names
// win ("Tanggal Kirim" before "Tanggal"); `grouped` marks a name right after
// a grouping word ("per Region", "berdasarkan Kanal") on the same line, so a
// clarification answer on its own line is never "grouped" by the request.
const LINE_BREAK = "\u0000";
export function findColumnMentions(text, columns) {
  const words = String(text ?? "").split("\n")
    .flatMap((line, i) => [...(i ? [LINE_BREAK] : []), ...norm(line).split(" ")])
    .filter(Boolean);
  const taken = new Array(words.length).fill(false);
  const order = columns
    .map((name, index) => ({ name, index, words: norm(name).split(" ").filter(Boolean) }))
    .filter((c) => c.words.length)
    .sort((a, b) => b.words.length - a.words.length || b.name.length - a.name.length);
  const found = [];
  for (const column of order) {
    for (let i = 0; i + column.words.length <= words.length; i += 1) {
      if (taken.slice(i, i + column.words.length).some(Boolean)) continue;
      if (!column.words.every((w, k) => words[i + k] === w)) continue;
      for (let k = 0; k < column.words.length; k += 1) taken[i + k] = true;
      found.push({ name: column.name, index: column.index, start: i, grouped: i > 0 && GROUP_WORDS.has(words[i - 1]) });
      break;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function profile(table) {
  const { columns, rows } = table.data;
  return columns.map((name, i) => {
    const values = rows.map((r) => r[i]).filter((v) => v !== null);
    const distinct = new Set(values);
    const binary = distinct.size === 2 && [...distinct].every((v) => YES_NO.has(String(v).trim().toLowerCase()));
    return { name, index: i, kind: table.kinds[i], distinct: distinct.size, present: values.length, binary };
  });
}

const clarify = (question, choices) => {
  const options = choices.slice(0, MAX_CLARIFY_OPTIONS);
  return { kind: "clarify", question: choices.length > options.length ? `${question} (Atau ketik nama kolomnya.)` : question, options };
};
const refuse = (text) => ({ kind: "refuse", text });
const run = (tool, args, auto = []) => ({ kind: "run", spec: { tool, args, auto } });
const names = (list) => list.map((c) => c.name);
const quoted = (list) => list.map((c) => `"${c.name}"`).join(", ");

// Offered as a grouping: categories only. A numeric column (e.g. "Kelas" 1–3)
// still groups when the user names it after "per"/"berdasarkan".
function groupable(c) {
  return c.kind === "text" && c.distinct >= 2 && c.distinct <= MAX_COMPARE_GROUPS && c.distinct < c.present;
}

// request → { kind: "run", spec } | { kind: "clarify", question, options } | { kind: "refuse", text }
export function resolveAnalysis(request, table) {
  const text = String(request || "");
  const n = norm(text);
  const cols = profile(table);
  const mentions = findColumnMentions(text, table.data.columns).map((m) => ({ ...m, col: cols[m.index] }));
  const numeric = cols.filter((c) => c.kind === "number");
  const intents = intentsOf(text);

  let intent = ["time_series", "correlate", "compare_groups", "statistics"].find((name) => intents.has(name));
  if (!intent) {
    return clarify("Analisis apa yang Anda inginkan untuk tabel ini?", Object.values(INTENT_OPTIONS));
  }
  // A measure "related to" a category is a group comparison, not a correlation.
  if (intent === "correlate") {
    const category = mentions.find((m) => m.col.kind === "text" && !m.col.binary);
    if (category && mentions.some((m) => m.col.kind === "number")) intent = "compare_groups";
  }

  if (intent === "statistics") return resolveDescribe(mentions, numeric, cols);
  if (intent === "correlate") return resolveCorrelate(mentions, numeric, n);
  if (intent === "compare_groups") {
    const fromCorrelation = !intents.has("compare_groups");
    const plan = resolveCompare(mentions, numeric, cols);
    if (fromCorrelation && plan.kind === "run") plan.spec.auto.push(`"${plan.spec.args.groupBy}" berisi kategori, jadi hubungannya diuji sebagai perbandingan kelompok, bukan korelasi.`);
    return plan;
  }
  return resolveTimeSeries(mentions, numeric, cols, table, n);
}

function resolveDescribe(mentions, numeric, cols) {
  if (!numeric.length) return refuse(`Tidak ada kolom angka di tabel ini, jadi statistik deskriptif tidak bisa dihitung. Kolom: ${quoted(cols)}.`);
  const named = mentions.filter((m) => m.col.kind === "number" && !m.grouped).map((m) => m.col);
  const group = mentions.find((m) => m.col.kind !== "number" && m.col.kind !== "empty")?.col
    ?? mentions.find((m) => m.grouped)?.col;
  const auto = [];
  let columns = named;
  if (!columns.length) {
    if (numeric.length > MAX_DESCRIBE_COLUMNS) return clarify("Kolom angka mana yang ingin dihitung statistiknya?", names(numeric));
    columns = numeric;
    auto.push(`Semua ${numeric.length} kolom angka dipakai: ${quoted(numeric)}.`);
  }
  columns = columns.slice(0, MAX_DESCRIBE_COLUMNS);
  if (group) {
    if (group.distinct > MAX_DESCRIBE_GROUPS) return refuse(`Kolom "${group.name}" punya ${group.distinct} nilai; statistik per kelompok dibatasi ${MAX_DESCRIBE_GROUPS}. Pilih kolom kelompok dengan nilai lebih sedikit.`);
    return run("statistics", { columns: names(columns), groupBy: group.name }, auto);
  }
  return run("statistics", { columns: names(columns) }, auto);
}

function resolveCorrelate(mentions, numeric, n) {
  const named = mentions.filter((m) => m.col.kind === "number" || m.col.binary).map((m) => m.col);
  if (has(n, ALL_NUMERIC) || (!named.length && numeric.length >= 2)) {
    if (numeric.length < 2) return refuse("Korelasi butuh minimal 2 kolom angka; tabel ini tidak punya cukup kolom angka.");
    if (numeric.length > MAX_CORRELATE_COLUMNS) {
      return clarify(`Tabel punya ${numeric.length} kolom angka; korelasi dibatasi ${MAX_CORRELATE_COLUMNS}. Kolom mana yang ingin dikorelasikan?`, names(numeric));
    }
    return run("correlate", { columns: names(numeric) }, named.length ? [] : [`Semua ${numeric.length} kolom angka dikorelasikan: ${quoted(numeric)}.`]);
  }
  if (!named.length) return refuse("Korelasi butuh minimal 2 kolom angka; tabel ini tidak punya cukup kolom angka.");
  if (named.length === 1) {
    const others = numeric.filter((c) => c.index !== named[0].index);
    if (!others.length) return refuse(`Tidak ada kolom angka lain untuk dikorelasikan dengan "${named[0].name}".`);
    const choices = [...names(others), ...(numeric.length <= MAX_CORRELATE_COLUMNS && numeric.length > 2 ? [ALL_NUMERIC_OPTION] : [])];
    return clarify(`Korelasikan "${named[0].name}" dengan kolom mana?`, choices);
  }
  return run("correlate", { columns: names(named.slice(0, MAX_CORRELATE_COLUMNS)) });
}

function resolveCompare(mentions, numeric, cols) {
  const value = mentions.find((m) => m.col.kind === "number" && !m.grouped)?.col
    ?? mentions.find((m) => m.col.binary && !m.grouped)?.col;
  const candidates = cols.filter(groupable);
  const mentionedGroups = mentions.filter((m) => m.col !== value && m.col.kind !== "empty" && m.col.kind !== "date"
    && (m.grouped || m.col.kind === "text"));
  let group = (mentionedGroups.find((m) => m.grouped) ?? mentionedGroups[0])?.col;

  if (!value) {
    if (!numeric.length) return refuse(`Tidak ada kolom angka untuk dibandingkan. Kolom: ${quoted(cols)}.`);
    if (numeric.length > 1) return clarify("Ukuran (kolom angka) mana yang ingin dibandingkan antar kelompok?", names(numeric));
  }
  const measure = value ?? numeric[0];
  const auto = value ? [] : [`Ukuran yang dibandingkan: "${measure.name}" (satu-satunya kolom angka).`];
  if (!group) {
    const options = candidates.filter((c) => c.index !== measure.index);
    if (!options.length) return refuse(`Tidak ada kolom kategori dengan 2–${MAX_COMPARE_GROUPS} nilai untuk mengelompokkan "${measure.name}".`);
    if (options.length > 1) return clarify(`Bandingkan "${measure.name}" berdasarkan kolom kelompok mana?`, names(options));
    group = options[0];
    auto.push(`Kelompok: "${group.name}" (satu-satunya kolom kategori yang cocok).`);
  }
  if (group.distinct > MAX_COMPARE_GROUPS) {
    return refuse(`Kolom "${group.name}" punya ${group.distinct} nilai; perbandingan kelompok dibatasi ${MAX_COMPARE_GROUPS}. Pilih kolom dengan nilai lebih sedikit atau saring datanya dulu.`);
  }
  if (group.distinct < 2) return refuse(`Kolom "${group.name}" hanya punya ${group.distinct} nilai; perbandingan butuh minimal 2 kelompok.`);
  return run("compare_groups", { column: measure.name, groupBy: group.name }, auto);
}

function autoPeriod(table, dateIndex) {
  const days = table.data.rows.map((r) => r[dateIndex]).filter((v) => typeof v === "string").map((v) => Date.parse(v.slice(0, 10)) / 86_400_000);
  const span = days.length ? Math.max(...days) - Math.min(...days) : 0;
  return span <= 62 ? "day" : span <= 182 ? "week" : "month";
}

function resolveTimeSeries(mentions, numeric, cols, table, n) {
  const dates = cols.filter((c) => c.kind === "date");
  if (!dates.length) return refuse("Tidak ada kolom tanggal (format tanggal Excel atau YYYY-MM-DD), jadi analisis tren tidak bisa dijalankan.");
  let date = mentions.find((m) => m.col.kind === "date")?.col;
  if (!date) {
    if (dates.length > 1) return clarify("Pakai kolom tanggal yang mana?", names(dates));
    date = dates[0];
  }
  const auto = [];
  const value = mentions.find((m) => m.col.kind === "number")?.col;
  let args;
  if (value) {
    args = { date: date.name, value: value.name, metric: has(withoutMovingAverage(n), AVG) ? "avg" : "sum" };
  } else if (has(n, COUNT)) {
    args = { date: date.name, metric: "count" };
  } else if (numeric.length === 1) {
    args = { date: date.name, value: numeric[0].name, metric: "sum" };
    auto.push(`Nilai: jumlah "${numeric[0].name}" per periode (satu-satunya kolom angka).`);
  } else if (!numeric.length) {
    args = { date: date.name, metric: "count" };
    auto.push("Tidak ada kolom angka, jadi yang dihitung adalah jumlah baris per periode.");
  } else {
    return clarify("Nilai apa yang ingin dilihat trennya?", [...names(numeric).slice(0, MAX_CLARIFY_OPTIONS - 1), COUNT_OPTION]);
  }
  const period = Object.keys(PERIODS).find((p) => has(n, PERIODS[p]));
  if (period) args.period = period;
  else {
    args.period = autoPeriod(table, date.index);
    auto.push(`Periode otomatis: ${PERIOD_LABEL[args.period]} (sebutkan "harian", "mingguan" atau "bulanan" untuk mengubah).`);
  }
  return run("time_series", args, auto);
}

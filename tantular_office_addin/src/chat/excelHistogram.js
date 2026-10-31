// Distribution of ONE column for the Excel chat: a histogram, never a line
// over time. Excel's native Histogram chart type is tried first; when this
// Excel refuses it (Office.js support varies by host and version), the chart
// it may have left is deleted and a column chart of binned counts is built
// from a bin table on a new sheet. The preview says up front that this
// fallback writes that sheet, and the result says which path actually ran.
// Pure helpers are Office-free for unit tests.

import { createStepRunner, failAfterCleanup, rangeArg } from "./excelChartRun.js";
import {
  MAX_CHART_POINTS,
  colName,
  describeSkippedRows,
  edgeRowsToSkip,
  parseRangeRef,
  placeChart,
  seriesChartSupported,
  valuesFingerprint
} from "./excelSeriesChart.js";

const MAX_BINS = 30;
const MIN_VALUES = 2;
const q = (value) => JSON.stringify(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const label = new Intl.NumberFormat("id-ID", { maximumSignificantDigits: 4 });

// { op: "add_histogram", sheet?, title?, name?, values: "N4:N62" } → { action } | { error }
export function sanitizeHistogram(raw) {
  const ref = parseRangeRef(raw?.values);
  if (!ref) return { error: `add_histogram: range nilai "${String(raw?.values ?? "")}" tidak valid.` };
  if (ref.c1 !== ref.c2) return { error: `add_histogram: ${ref.address} harus satu kolom (distribusi satu ukuran).` };
  const points = ref.r2 - ref.r1 + 1;
  if (points > MAX_CHART_POINTS) return { error: `add_histogram: ${points} baris melebihi batas ${MAX_CHART_POINTS}.` };
  return {
    action: {
      op: "add_histogram",
      sheet: String(raw?.sheet || ref.sheet || "").trim().slice(0, 31),
      title: String(raw?.title || "").slice(0, 80),
      name: String(raw?.name || "").trim().slice(0, 60) || `Kolom ${colName(ref.c1)}`,
      values: ref.address
    }
  };
}

// Bins by Scott's rule (h = 3.49·s·n^(-1/3)), the rule Excel's own histogram
// uses by default, widened slightly so the bins exactly cover min..max. The
// last bin includes the maximum.
export function histogramBins(values) {
  const data = values.filter(isNumber);
  const n = data.length;
  if (n < MIN_VALUES) throw new Error(`Histogram butuh minimal ${MIN_VALUES} angka; kolom ini hanya punya ${n}.`);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(data.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  let count = 1;
  if (max > min && sd > 0) count = Math.min(MAX_BINS, Math.max(1, Math.ceil((max - min) / (3.49 * sd * n ** (-1 / 3)))));
  const width = max > min ? (max - min) / count : 0;
  const bins = Array.from({ length: count }, (_, i) => ({ from: min + i * width, to: i === count - 1 ? max : min + (i + 1) * width, count: 0 }));
  for (const v of data) bins[width ? Math.min(count - 1, Math.floor((v - min) / width)) : 0].count += 1;
  return { n, min, max, width, bins, rule: "Scott" };
}

export const binLabel = (bin) => `${label.format(bin.from)}–${label.format(bin.to)}`;

// values: the column's loaded values (2-D, one column); hiddenRows[i] for each row.
export function buildHistogramPreview(action, { values, hiddenRows = [] }) {
  const cells = (values || []).map((row) => row?.[0]);
  const flags = cells.map((value, i) => ({
    hidden: Boolean(hiddenRows[i]),
    reason: isNumber(value) ? "" : value === "" || value == null ? "kosong" : `"${String(value).slice(0, 30)}" bukan angka`
  }));
  const keep = edgeRowsToSkip(flags);
  if (keep.end <= keep.start) throw new Error(`Range ${action.values} tidak berisi angka yang terlihat untuk histogram.`);
  const ref = parseRangeRef(action.values);
  const first = ref.r1 + keep.start;
  const last = ref.r1 + keep.end - 1;
  const trimmed = { ...action, values: `${colName(ref.c1)}${first}:${colName(ref.c1)}${last}` };
  const kept = cells.slice(keep.start, keep.end);
  const numbers = kept.filter(isNumber);
  const warnings = [];
  if (numbers.length < kept.length) warnings.push(`${kept.length - numbers.length} cell di ${trimmed.values} bukan angka dan tidak dihitung.`);
  return {
    action: trimmed,
    bins: histogramBins(numbers),
    notes: describeSkippedRows(flags, ref.r1, keep),
    warnings,
    fingerprint: valuesFingerprint([kept])
  };
}

export function histogramPreviewText(preview) {
  const { action, bins } = preview;
  const lines = [
    `Pratinjau histogram${action.title ? ` "${action.title}"` : ""} di sheet "${action.sheet || "aktif"}":`,
    `• Distribusi "${action.name}": ${action.values} (${bins.n} angka; min ${label.format(bins.min)}, maks ${label.format(bins.max)})`,
    `• ${bins.bins.length} kelas, lebar ${label.format(bins.width)} (aturan Scott, sama seperti histogram Excel)`,
    ...preview.notes.map((n) => `ℹ️ ${n}`),
    ...preview.warnings.map((w) => `⚠️ ${w}`),
    "Jika histogram bawaan Excel tidak bisa dibuat, Tantular menulis tabel kelas (bin) di sheet baru dan membuat column chart jumlah per kelas dari tabel itu.",
    "Workbook belum diubah. Klik \"Buat chart\" untuk menambahkannya."
  ];
  return lines.join("\n");
}

// The bin table written for the fallback chart (header + one row per bin).
export function binTable(bins, name) {
  return [["Kelas", `Jumlah (${name})`.slice(0, 60)], ...bins.bins.map((bin) => [binLabel(bin), bin.count])];
}

// --- Office-bound parts -----------------------------------------------------

const resolveSheet = (workbook, name) => (name ? workbook.worksheets.getItem(name) : workbook.worksheets.getActiveWorksheet());

export async function readLiveHistogramPreview(action) {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  return Excel.run(async (context) => {
    const sheet = resolveSheet(context.workbook, action.sheet);
    sheet.load("name");
    const range = sheet.getRange(action.values);
    range.load("values");
    const ref = parseRangeRef(action.values);
    const rows = Array.from({ length: ref.r2 - ref.r1 + 1 }, (_, i) => {
      const row = range.getRow(i);
      row.load("rowHidden");
      return row;
    });
    await context.sync();
    return buildHistogramPreview({ ...action, sheet: action.sheet || sheet.name }, {
      values: range.values,
      hiddenRows: rows.map((row) => row.rowHidden === true)
    });
  });
}

async function chartNames(sheetName) {
  return Excel.run(async (context) => {
    const sheet = resolveSheet(context.workbook, sheetName);
    sheet.charts.load("items/name");
    await context.sync();
    return sheet.charts.items.map((c) => c.name);
  });
}

async function nativeHistogram(action) {
  let chartName = "";
  const beforeNames = await chartNames(action.sheet);
  try {
    return await Excel.run(async (context) => {
      const { step } = createStepRunner(context);
      const sheet = resolveSheet(context.workbook, action.sheet);
      const chart = await step("ChartCollection.add", [q("Histogram"), rangeArg(action.sheet, action.values), q("Columns")], () => {
        const created = sheet.charts.add("Histogram", sheet.getRange(action.values), "Columns");
        created.load("name");
        return created;
      });
      chartName = chart.name;
      const first = chart.series.getItemAt(0);
      await step("ChartSeries.name", [q(action.name)], () => { first.name = action.name; });
      await step("ChartTitle.text", [q(action.title || `Distribusi ${action.name}`)], () => { chart.title.text = action.title || `Distribusi ${action.name}`; });
      const anchor = await placeChart(step, sheet, chart, parseRangeRef(action.values).r1 - 1);
      return `✅ Histogram "${action.name}" dibuat dengan tipe chart Histogram bawaan Excel dari ${action.values}, ditempatkan di ${anchor}.`;
    });
  } catch (error) {
    throw await failAfterCleanup(error, { sheet: action.sheet, chartName, beforeNames });
  }
}

function uniqueSheetName(base, existing) {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const clean = base.replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || "Histogram";
  let name = clean;
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${clean.slice(0, 27)} ${i}`;
  return name;
}

async function binnedColumnChart(preview, reason) {
  const { action, bins } = preview;
  const table = binTable(bins, action.name);
  let sheetName = "";
  let chartName = "";
  try {
    return await Excel.run(async (context) => {
      const { step } = createStepRunner(context);
      const books = context.workbook.worksheets;
      books.load("items/name");
      await context.sync();
      sheetName = uniqueSheetName(`Histogram ${action.name}`, books.items.map((s) => s.name));
      const sheet = await step("WorksheetCollection.add", [q(sheetName)], () => books.add(sheetName));
      const tableAddress = `A1:B${table.length}`;
      await step("Range.values", [rangeArg(sheetName, tableAddress)], () => { sheet.getRange(tableAddress).values = table; });
      const data = sheet.getRange(tableAddress);
      const chart = await step("ChartCollection.add", [q("ColumnClustered"), rangeArg(sheetName, tableAddress), q("Columns")], () => {
        const created = sheet.charts.add("ColumnClustered", data, "Columns");
        created.load("name");
        return created;
      });
      chartName = chart.name;
      await step("ChartTitle.text", [q(action.title || `Distribusi ${action.name}`)], () => { chart.title.text = action.title || `Distribusi ${action.name}`; });
      const anchor = await placeChart(step, sheet, chart, 1);
      return [
        `ℹ️ Histogram bawaan Excel tidak bisa dibuat di sini. ${reason}`,
        `✅ Sebagai gantinya dibuat column chart jumlah per kelas: ${bins.bins.length} kelas dari ${bins.n} angka di ${action.values} (sheet "${action.sheet}"). Tabel kelas ditulis di sheet baru "${sheetName}" (${tableAddress}); chart ada di ${anchor} pada sheet itu.`
      ].join("\n");
    });
  } catch (error) {
    // The bin-table sheet exists only for this chart: a fallback that fails
    // part-way removes it too (deleting the sheet takes its chart with it).
    if (sheetName && await deleteSheet(sheetName)) {
      const wrapped = new Error(
        `Chart gagal dibuat: ${error?.message || error}.`
        + `${error?.tantularCall ? ` Panggilan Office.js yang gagal: ${error.tantularCall}.` : ""}`
        + ` Sheet "${sheetName}" yang sempat dibuat untuk tabel kelas sudah dihapus lagi.`
      );
      wrapped.cause = error;
      wrapped.tantularCall = error?.tantularCall;
      throw wrapped;
    }
    throw await failAfterCleanup(error, { sheet: sheetName, chartName });
  }
}

// true when the sheet existed and is gone; false when it was never created or
// could not be removed (the caller then falls back to chart-only cleanup).
async function deleteSheet(name) {
  try {
    return await Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getItemOrNullObject(name);
      sheet.load("isNullObject");
      await context.sync();
      if (sheet.isNullObject) return false;
      sheet.delete();
      await context.sync();
      return true;
    });
  } catch (cleanupError) {
    console.warn(`[TantularChart] gagal menghapus sheet ${name}`, cleanupError);
    return false;
  }
}

// The ONLY write: called from the preview's "Buat chart" click.
export async function createHistogramChart(preview) {
  if (!seriesChartSupported()) throw new Error("Excel versi ini belum mendukung pembuatan chart dari panel (butuh ExcelApi 1.7).");
  const fresh = await readLiveHistogramPreview(preview.action);
  if (fresh.fingerprint !== preview.fingerprint) {
    throw new Error("Data di range histogram berubah sejak pratinjau. Minta chart lagi agar pratinjaunya sesuai data terbaru.");
  }
  try {
    return await nativeHistogram(fresh.action);
  } catch (error) {
    console.warn("[TantularChart] Histogram bawaan ditolak, pakai column chart dari kelas", error?.cause || error);
    return binnedColumnChart(fresh, String(error?.message || error));
  }
}

// Charts from SEPARATE ranges (e.g. dates in A, target in AA, actual in BF)
// for the Excel chat, plus the bounded column map that lets the planner see
// those columns at all. The old snapshot stopped at 20 columns / 250 cells, so
// on a wide sheet the model only ever saw A–T and invented ranges there; and
// add_chart takes one continuous range, so "A + AA + BF" was unrepresentable.
//
// Nothing here writes to the workbook without a confirmed preview: the chat
// shows readLiveSeriesPreview()'s values first and only createSeriesChart()
// on the user's click, after re-reading the ranges to prove they did not
// change in between. Pure helpers are Office-free for unit tests.

import { createStepRunner, failAfterCleanup, rangeArg } from "./excelChartRun.js";

export const MAX_CHART_SERIES = 6;
export const MAX_CHART_POINTS = 500;
const MAX_MAP_COLUMNS = 100;
const MAX_MAP_CELLS = 20_000;
const MAX_HEADER_ROWS = 3;
export const SERIES_CHART_TYPES = new Set(["Line", "LineMarkers", "ColumnClustered", "BarClustered", "Radar", "RadarMarkers", "RadarFilled"]);
// A radar ("spider web") needs at least three spokes to be a shape at all.
export const MIN_RADAR_POINTS = 3;
const RANGE_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/;

export function colNumber(letters) {
  return [...String(letters).toUpperCase()].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
}

export function colName(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// "AA4:AA62", "$A$4:$A$62", "'Plot Data'!A4:A62", "Plot Data!A4:A62".
// Returns { sheet, address, c1, r1, c2, r2 } or null. Multi-area addresses
// ("B4:B13,G4:T13") are deliberately not parsed: each range here is one area.
export function parseRangeRef(value) {
  let text = String(value || "").trim();
  let sheet = "";
  const bang = text.lastIndexOf("!");
  if (bang > 0) {
    sheet = text.slice(0, bang).trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
    text = text.slice(bang + 1).trim();
  }
  const match = RANGE_RE.exec(text);
  if (!match) return null;
  const c1 = colNumber(match[1]);
  const r1 = Number(match[2]);
  const c2 = match[3] ? colNumber(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) : r1;
  if (c2 < c1 || r2 < r1 || r1 < 1) return null;
  const address = `${colName(c1)}${r1}${c2 !== c1 || r2 !== r1 ? `:${colName(c2)}${r2}` : ""}`;
  return { sheet: sheet.slice(0, 31), address, c1, r1, c2, r2 };
}

function vectorShape(ref) {
  if (ref.c1 === ref.c2) return { orientation: "column", points: ref.r2 - ref.r1 + 1 };
  if (ref.r1 === ref.r2) return { orientation: "row", points: ref.c2 - ref.c1 + 1 };
  return null;
}

// Validates a planner action of the form
//   { op:"add_series_chart", sheet?, type, title?, categories:"A4:A62",
//     series:[{ name:"Target", values:"AA4:AA62" }, ...] }
// Returns { action } or { error } (Indonesian, shown in the chat).
export function sanitizeSeriesChart(raw) {
  const label = "add_series_chart";
  const categories = parseRangeRef(raw?.categories);
  if (!categories) {
    return { error: `${label}: "categories" harus satu range kontinu satu kolom/baris (mis. A4:A62), bukan "${String(raw?.categories ?? "")}".` };
  }
  const catShape = vectorShape(categories);
  if (!catShape) return { error: `${label}: categories ${categories.address} harus satu kolom atau satu baris.` };
  if (catShape.points > MAX_CHART_POINTS) {
    return { error: `${label}: ${catShape.points} titik melebihi batas ${MAX_CHART_POINTS}.` };
  }
  const rawSeries = Array.isArray(raw?.series) ? raw.series : [];
  if (!rawSeries.length) return { error: `${label}: "series" kosong.` };
  if (rawSeries.length > MAX_CHART_SERIES) {
    return { error: `${label}: ${rawSeries.length} seri melebihi batas ${MAX_CHART_SERIES}.` };
  }
  let sheet = String(raw?.sheet || "").trim().slice(0, 31) || categories.sheet;
  const sameSheet = (ref) => !ref.sheet || !sheet || ref.sheet.toLowerCase() === sheet.toLowerCase();
  if (!sameSheet(categories)) return { error: `${label}: semua range harus di sheet yang sama ("${sheet}").` };
  const series = [];
  for (const [index, item] of rawSeries.entries()) {
    const ref = parseRangeRef(item?.values ?? item?.range);
    const name = String(item?.name || "").trim().slice(0, 60) || `Seri ${index + 1}`;
    if (!ref) return { error: `${label}: range seri "${name}" tidak valid ("${String(item?.values ?? "")}").` };
    if (!sheet && ref.sheet) sheet = ref.sheet;
    if (!sameSheet(ref)) return { error: `${label}: seri "${name}" ada di sheet lain; semua range harus di sheet yang sama.` };
    const shape = vectorShape(ref);
    if (!shape || shape.orientation !== catShape.orientation || shape.points !== catShape.points) {
      return {
        error: `${label}: seri "${name}" (${ref.address}) harus ${catShape.orientation === "column" ? "satu kolom" : "satu baris"} `
          + `dengan ${catShape.points} titik, sama seperti categories ${categories.address}.`
      };
    }
    // Same rows (or columns) as the X axis: an off-by-one range would plot
    // every value against the neighbouring date without any visible error.
    const aligned = catShape.orientation === "column" ? ref.r1 === categories.r1 : ref.c1 === categories.c1;
    if (!aligned) {
      return {
        error: `${label}: seri "${name}" (${ref.address}) harus mulai di ${catShape.orientation === "column" ? `baris ${categories.r1}` : `kolom ${colName(categories.c1)}`} `
          + `agar sejajar dengan categories ${categories.address}.`
      };
    }
    series.push({ name, values: ref.address });
  }
  const type = SERIES_CHART_TYPES.has(raw?.type) ? raw.type : "Line";
  if (type.startsWith("Radar") && catShape.points < MIN_RADAR_POINTS) {
    return { error: `${label}: chart radar butuh minimal ${MIN_RADAR_POINTS} kategori (sumbu jaring), categories ${categories.address} hanya ${catShape.points}.` };
  }
  return {
    action: {
      op: "add_series_chart",
      sheet,
      type,
      title: String(raw?.title || "").slice(0, 80),
      categories: categories.address,
      orientation: catShape.orientation,
      points: catShape.points,
      series
    }
  };
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

// Excel stores dates as serial days since 1899-12-30 (the 1900 leap-year bug
// is absorbed by that epoch for every date after Feb 1900).
export function excelSerialToIso(serial) {
  if (!isNumber(serial)) return "";
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000)).toISOString().slice(0, 10);
}

export function looksLikeDateFormat(format) {
  const text = String(format || "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
  return /[dy]/i.test(text) || /m{3,}/i.test(text) || (/m/i.test(text) && !/[hs0#]/i.test(text));
}

// Bounded per-column profile of a sheet block: header labels (with merged
// group headers carried right, e.g. "Target Maturity › Overall"), numeric row
// extent, and first/last values. This is how a 65-column sheet fits in a
// prompt: one line per column instead of thousands of cells.
export function profileColumns(values, { rowIndex = 0, colIndex = 0, numberFormats = null } = {}) {
  const rows = values?.length || 0;
  const cols = Math.min(Math.max(0, ...(values || []).map((r) => r?.length || 0)), MAX_MAP_COLUMNS);
  const headerRows = [];
  for (let r = 0; r < Math.min(rows, MAX_HEADER_ROWS); r += 1) {
    const filled = (values[r] || []).slice(0, cols).filter((v) => v !== "" && v != null);
    const text = filled.filter((v) => typeof v === "string" && Number.isNaN(Number(v)));
    if (!filled.length || text.length * 2 < filled.length) break;
    headerRows.push(r);
  }
  const carried = headerRows.map(() => "");
  const columns = [];
  for (let c = 0; c < cols; c += 1) {
    const parts = [];
    headerRows.forEach((r, level) => {
      const own = values[r]?.[c];
      if (own !== "" && own != null) carried[level] = String(own).trim();
      // Only the TOP header level carries across columns (merged group
      // titles); lower levels label their own column only.
      const label = level === 0 && headerRows.length > 1 ? carried[level] : (own === "" || own == null ? "" : String(own).trim());
      if (label && parts[parts.length - 1] !== label) parts.push(label);
    });
    let first = null;
    let last = null;
    let count = 0;
    for (let r = headerRows.length; r < rows; r += 1) {
      const value = values[r]?.[c];
      if (!isNumber(value)) continue;
      count += 1;
      if (!first) first = { row: rowIndex + r + 1, value };
      last = { row: rowIndex + r + 1, value };
    }
    const format = first && numberFormats ? numberFormats[first.row - rowIndex - 1]?.[c] : "";
    columns.push({
      column: colName(colIndex + c + 1),
      header: parts.join(" › ").slice(0, 80),
      numeric: count,
      firstRow: first?.row ?? null,
      lastRow: last?.row ?? null,
      first: first?.value ?? null,
      last: last?.value ?? null,
      date: Boolean(first && looksLikeDateFormat(format))
    });
  }
  return { headerRows: headerRows.map((r) => rowIndex + r + 1), columns, columnsTruncated: (values?.[0]?.length || 0) > cols };
}

const shortNumber = (value) => (isNumber(value) ? String(Math.round(value * 1000) / 1000) : String(value ?? ""));

export function columnMapToPromptText(map) {
  if (!map?.columns?.length) return "";
  const lines = [
    `Peta kolom sheet aktif (SEMUA kolom terpakai; header di baris ${map.headerRows.join(", ") || "-"}). Pakai ini untuk memilih range chart:`
  ];
  for (const col of map.columns) {
    if (!col.header && !col.numeric) continue;
    const extent = col.numeric
      ? ` — ${col.date ? "tanggal" : "angka"} baris ${col.firstRow}–${col.lastRow} (${col.numeric} nilai; awal ${col.date ? excelSerialToIso(col.first) : shortNumber(col.first)}, akhir ${col.date ? excelSerialToIso(col.last) : shortNumber(col.last)})`
      : " — tanpa angka";
    lines.push(`${col.column}: "${col.header || "(tanpa header)"}"${extent}`);
  }
  if (map.columnsTruncated) lines.push(`(peta kolom dibatasi ${MAX_MAP_COLUMNS} kolom pertama)`);
  if (map.rowsTruncated) lines.push(`(peta kolom dibaca dari ${map.rowsRead} baris pertama)`);
  return lines.join("\n");
}

// Rows the column map may read so a wide sheet stays within MAX_MAP_CELLS.
export function columnMapReadShape(rowCount, columnCount) {
  const cols = Math.min(columnCount, MAX_MAP_COLUMNS);
  const rows = Math.max(1, Math.min(rowCount, Math.floor(MAX_MAP_CELLS / Math.max(1, cols))));
  return { rows, cols };
}

function flatten(values) {
  return (values || []).flat();
}

// Stable fingerprint of the exact values a preview showed, so a confirm click
// can prove the chart is built from the same data the user reviewed.
export function valuesFingerprint(parts) {
  let hash = 2166136261;
  const text = JSON.stringify(parts);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

// Preview model from loaded values: what each range actually holds.
// `categoryFormat` is the number format of the first category cell.
export function buildSeriesPreview(action, { categoryValues, seriesValues, categoryFormat = "", notes = [] }) {
  const cats = flatten(categoryValues);
  const dated = cats.some(isNumber) && looksLikeDateFormat(categoryFormat);
  const show = (value) => (dated && isNumber(value) ? excelSerialToIso(value) : shortNumber(value));
  const warnings = [];
  const series = action.series.map((item, index) => {
    const vals = flatten(seriesValues[index]);
    const numeric = vals.filter(isNumber);
    if (!numeric.length) warnings.push(`Seri "${item.name}" (${item.values}) tidak berisi angka — chart akan kosong.`);
    else if (numeric.length < vals.length) warnings.push(`Seri "${item.name}": ${vals.length - numeric.length} dari ${vals.length} cell bukan angka.`);
    return {
      ...item,
      numeric: numeric.length,
      // Dates belong to the X axis only; series values are plain numbers.
      first: shortNumber(vals[0]),
      last: shortNumber(vals[vals.length - 1]),
      min: numeric.length ? shortNumber(Math.min(...numeric)) : "",
      max: numeric.length ? shortNumber(Math.max(...numeric)) : ""
    };
  });
  if (cats.some((v) => v === "" || v == null)) warnings.push(`Categories ${action.categories} berisi cell kosong.`);
  return {
    action,
    categories: { address: action.categories, dated, first: show(cats[0]), last: show(cats[cats.length - 1]), points: cats.length },
    series,
    warnings,
    notes,
    fingerprint: valuesFingerprint([categoryValues, seriesValues])
  };
}

export function seriesPreviewText(preview) {
  const { action, categories } = preview;
  const lines = [
    `Pratinjau chart ${action.type}${action.title ? ` "${action.title}"` : ""} di sheet "${action.sheet || "aktif"}":`,
    `• Sumbu X: ${categories.address} (${categories.points} titik, ${categories.first} → ${categories.last}${categories.dated ? ", tanggal" : ""})`,
    ...preview.series.map((s) => `• ${s.name}: ${s.values} (awal ${s.first}, akhir ${s.last}; min ${s.min}, maks ${s.max})`),
    ...(preview.notes || []).map((n) => `ℹ️ ${n}`),
    ...preview.warnings.map((w) => `⚠️ ${w}`),
    "Workbook belum diubah. Klik \"Buat chart\" untuk menambahkannya."
  ];
  return lines.join("\n");
}

// --- Rows that must not be plotted ------------------------------------------
//
// A planner range often starts one row too early: on "Plot Data" row 3 is a
// hidden "Initial" row (text in the date column) and the data starts at row 4.
// Rows at the START or END of a column range are dropped while they are
// hidden or are not data: a text label in an otherwise numeric/date X column,
// or an X cell and every series cell empty. Rows in the middle are kept (the
// ranges must stay contiguous); hidden ones there are only reported.

export function edgeRowsToSkip(rows) {
  let start = 0;
  while (start < rows.length && (rows[start].hidden || rows[start].reason)) start += 1;
  let end = rows.length;
  while (end > start && (rows[end - 1].hidden || rows[end - 1].reason)) end -= 1;
  return { start, end };
}

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isBlank = (value) => value === "" || value == null;

// rows: one entry per sheet row of a column-oriented series chart.
export function seriesRowFlags({ categoryValues, seriesValues, hiddenRows = [] }) {
  const cats = flatten(categoryValues);
  // Dates are numbers in Excel; empty cells do not count either way.
  const numericCategories = cats.filter(isNumber).length;
  const mostlyNumeric = numericCategories > 0 && numericCategories * 2 >= cats.filter((v) => !isBlank(v)).length;
  return cats.map((value, i) => {
    let reason = "";
    if (mostlyNumeric && isText(value)) reason = `"${String(value).slice(0, 30)}" bukan tanggal/angka`;
    else if (isBlank(value) && seriesValues.every((vals) => isBlank(vals?.[i]?.[0]))) reason = "kosong";
    return { hidden: Boolean(hiddenRows[i]), reason };
  });
}

// "Baris 3 dilewati (tersembunyi; "Initial" bukan tanggal/angka)."
export function describeSkippedRows(flags, firstRow, { start, end }, column = "") {
  const notes = [];
  const describe = (i) => {
    const why = [flags[i].hidden ? "tersembunyi" : "", flags[i].reason].filter(Boolean).join("; ");
    return `${firstRow + i}${why ? ` (${why})` : ""}`;
  };
  const skipped = [...Array(start).keys(), ...Array.from({ length: flags.length - end }, (_, k) => end + k)];
  if (skipped.length) {
    const shown = skipped.slice(0, 4).map(describe).join(", ");
    notes.push(`Baris ${shown}${skipped.length > 4 ? `, … (${skipped.length} baris)` : ""} dilewati${column ? ` di kolom ${column}` : ""}; data mulai baris ${firstRow + start}.`);
  }
  const hiddenInside = flags.slice(start, end).filter((f) => f.hidden).length;
  if (hiddenInside) notes.push(`${hiddenInside} baris tersembunyi di tengah range tidak akan tampil di chart (Excel hanya memplot cell yang terlihat).`);
  return notes;
}

const shiftColumnRange = (address, r1, r2) => {
  const ref = parseRangeRef(address);
  return `${colName(ref.c1)}${r1}:${colName(ref.c2)}${r2}`;
};

// --- Office-bound parts -----------------------------------------------------

function resolveSheet(workbook, name) {
  return name ? workbook.worksheets.getItem(name) : workbook.worksheets.getActiveWorksheet();
}

// Read-only: loads the referenced values (and which rows are hidden) for the
// preview, then trims hidden/non-data rows at the edges. Never writes.
export async function readLiveSeriesPreview(action) {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  return Excel.run(async (context) => {
    const sheet = resolveSheet(context.workbook, action.sheet);
    sheet.load("name");
    const categories = sheet.getRange(action.categories);
    categories.load(["values", "numberFormat"]);
    const series = action.series.map((item) => {
      const range = sheet.getRange(item.values);
      range.load("values");
      return range;
    });
    const byColumn = action.orientation !== "row";
    const rowRanges = byColumn
      ? Array.from({ length: parseRangeRef(action.categories).r2 - parseRangeRef(action.categories).r1 + 1 }, (_, i) => {
        const row = categories.getRow(i);
        row.load("rowHidden");
        return row;
      })
      : [];
    await context.sync();
    const resolved = { ...action, sheet: action.sheet || sheet.name };
    if (!byColumn) {
      return buildSeriesPreview(resolved, {
        categoryValues: categories.values,
        seriesValues: series.map((range) => range.values),
        categoryFormat: categories.numberFormat?.[0]?.[0] ?? ""
      });
    }
    const flags = seriesRowFlags({
      categoryValues: categories.values,
      seriesValues: series.map((range) => range.values),
      hiddenRows: rowRanges.map((row) => row.rowHidden === true)
    });
    const keep = edgeRowsToSkip(flags);
    if (keep.end <= keep.start) {
      throw new Error(`Range ${action.categories} tidak berisi baris data yang terlihat (semua baris tersembunyi atau bukan data).`);
    }
    const r1 = parseRangeRef(action.categories).r1;
    const notes = describeSkippedRows(flags, r1, keep);
    const first = r1 + keep.start;
    const last = r1 + keep.end - 1;
    const trimmed = keep.start === 0 && keep.end === flags.length ? resolved : {
      ...resolved,
      categories: shiftColumnRange(action.categories, first, last),
      points: last - first + 1,
      series: action.series.map((item) => ({ ...item, values: shiftColumnRange(item.values, first, last) }))
    };
    const slice = (values) => values.slice(keep.start, keep.end);
    return buildSeriesPreview(trimmed, {
      categoryValues: slice(categories.values),
      seriesValues: series.map((range) => slice(range.values)),
      categoryFormat: categories.numberFormat?.[keep.start]?.[0] ?? "",
      notes
    });
  });
}

export function seriesChartSupported() {
  return Boolean(globalThis.Office?.context?.requirements?.isSetSupported?.("ExcelApi", "1.7"));
}

const MAX_SHEET_COLUMNS = 16384;
const CHART_WIDTH_COLUMNS = 9;
const CHART_HEIGHT_ROWS = 18;
const q = (value) => JSON.stringify(value);

// Column for the chart's top-left corner: right of the cells that hold VALUES
// (getUsedRange(true); formatting alone used to push it past column XFD and
// getRangeByIndexes threw "Parameter out of range"), clamped to the sheet.
export function chartAnchorColumn(usedColumnIndex, usedColumnCount) {
  return Math.max(0, Math.min(usedColumnIndex + usedColumnCount + 1, MAX_SHEET_COLUMNS - CHART_WIDTH_COLUMNS - 1));
}

async function chartNamesOn(sheetName) {
  return Excel.run(async (context) => {
    const sheet = resolveSheet(context.workbook, sheetName);
    sheet.charts.load("items/name");
    await context.sync();
    return sheet.charts.items.map((c) => c.name);
  });
}

// The ONLY write: called from the preview's "Buat chart" click. Every Office.js
// call is its own logged step (createStepRunner); any failure after
// charts.add deletes the chart again before the error is shown.
export async function createSeriesChart(preview) {
  if (!seriesChartSupported()) {
    throw new Error("Excel versi ini belum mendukung chart dari range terpisah (butuh ExcelApi 1.7).");
  }
  const fresh = await readLiveSeriesPreview(preview.action);
  if (fresh.fingerprint !== preview.fingerprint) {
    throw new Error("Data di range chart berubah sejak pratinjau. Minta chart lagi agar pratinjaunya sesuai data terbaru.");
  }
  const { action } = fresh;
  const beforeNames = await chartNamesOn(action.sheet);
  let chartName = "";
  try {
    return await Excel.run(async (context) => {
      const { step } = createStepRunner(context);
      const sheet = resolveSheet(context.workbook, action.sheet);
      const at = (address) => rangeArg(action.sheet, address);
      const categoryRange = sheet.getRange(action.categories);
      const seriesBy = action.orientation === "row" ? "Rows" : "Columns";
      const chart = await step("ChartCollection.add", [q(action.type), at(action.series[0].values), q(seriesBy)], () => {
        const created = sheet.charts.add(action.type, sheet.getRange(action.series[0].values), seriesBy);
        created.load("name");
        return created;
      });
      chartName = chart.name;
      const firstSeries = chart.series.getItemAt(0);
      await step("ChartSeries.name", [q(action.series[0].name)], () => { firstSeries.name = action.series[0].name; });
      await step("ChartSeries.setXAxisValues", [at(action.categories)], () => firstSeries.setXAxisValues(categoryRange));
      for (const item of action.series.slice(1)) {
        const added = await step("ChartSeriesCollection.add", [q(item.name)], () => chart.series.add(item.name));
        await step("ChartSeries.setValues", [at(item.values)], () => added.setValues(sheet.getRange(item.values)));
        await step("ChartSeries.setXAxisValues", [at(action.categories)], () => added.setXAxisValues(categoryRange));
      }
      if (action.title) await step("ChartTitle.text", [q(action.title)], () => { chart.title.text = action.title; });
      await step("ChartLegend.position", [q("Bottom")], () => { chart.legend.position = "Bottom"; });
      const anchor = await placeChart(step, sheet, chart, parseRangeRef(action.categories).r1 - 1);
      return `✅ Chart ${action.type} dibuat dari ${action.categories} + ${action.series.map((s) => `${s.values} (${s.name})`).join(", ")}, ditempatkan di ${anchor}.`;
    });
  } catch (error) {
    throw await failAfterCleanup(error, { sheet: action.sheet, chartName, beforeNames });
  }
}

// Beside the cells in use, level with the data's first row, so the chart never
// covers data; selecting the anchor (best effort) scrolls it into view.
// Returns the anchor address.
export async function placeChart(step, sheet, chart, firstRowIndex) {
  const used = await step("Worksheet.getUsedRange", ["true"], () => {
    const range = sheet.getUsedRange(true);
    range.load(["columnIndex", "columnCount"]);
    return range;
  });
  const column = chartAnchorColumn(used.columnIndex, used.columnCount);
  const row = Math.max(0, firstRowIndex - 1);
  const anchor = sheet.getRangeByIndexes(row, column, 1, 1);
  const corner = anchor.getOffsetRange(CHART_HEIGHT_ROWS, CHART_WIDTH_COLUMNS);
  await step("Chart.setPosition", [`getRangeByIndexes(${row}, ${column}, 1, 1)`, `getOffsetRange(${CHART_HEIGHT_ROWS}, ${CHART_WIDTH_COLUMNS})`], () => {
    chart.setPosition(anchor, corner);
    anchor.load("address");
  });
  try {
    await step("Range.select", [anchor.address], () => anchor.select());
  } catch (_) { /* scrolling to the chart is a convenience, never a failure */ }
  return String(anchor.address).split("!").pop();
}

// Excel range → the table shape of the vendored statistics engine
// (src/vendor/tantular-dashboard/stats.mjs): { name, columns, types, rows },
// types "number" | "text", empty cells null. Typing follows upstream
// parseCSV (core.mjs): a column is numeric only when every value is a number,
// and numbers with leading zeros are identifiers, not measurements. Excel
// additions: date serials with a date format become ISO dates (the engine's
// date format), booleans read as true/false, error cells (#N/A …) are empty,
// title rows above the header and a trailing TOTAL row are left out.
// The adapter is pure; the Office-bound reader at the bottom only reads.

import { colName, excelSerialToIso, looksLikeDateFormat, valuesFingerprint } from "./excelSeriesChart.js";

// Upstream in-memory limits (core.mjs MAX_ROWS, 50 columns).
export const MAX_ANALYSIS_ROWS = 10_000;
export const MAX_ANALYSIS_COLUMNS = 50;
const HEADER_SCAN_ROWS = 10;
const MAX_HEADER_CHARS = 100;

const NUMERIC_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const LEADING_ZERO_RE = /^[-+]?0\d/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const ERROR_RE = /^#(?:N\/A|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)/i;
const TOTAL_RE = /^(?:grand\s+total|sub\s?total|total(?:\s+keseluruhan)?|jumlah(?:\s+total)?|keseluruhan)\b/i;

const isBlank = (raw) => raw == null || (typeof raw === "string" && raw.trim() === "");

function cellValue(raw, format) {
  if (isBlank(raw)) return { value: null };
  if (typeof raw === "boolean") return { value: raw ? "true" : "false" };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { value: null, error: true };
    return { value: format && looksLikeDateFormat(format) ? excelSerialToIso(raw) : raw };
  }
  const text = String(raw).trim();
  if (ERROR_RE.test(text)) return { value: null, error: true };
  return { value: text };
}

const isNumberLike = (v) => typeof v === "number" || (NUMERIC_RE.test(v) && Number.isFinite(Number(v)) && !LEADING_ZERO_RE.test(v));
const isIsoDate = (v) => typeof v === "string" && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10)));

// The header is the first of the top rows that is all text and about as wide
// as the widest of them; a one-cell title ("Laporan Penjualan") is skipped.
export function detectHeaderRow(values) {
  const top = (values || []).slice(0, HEADER_SCAN_ROWS);
  const filled = top.map((row) => (row || []).filter((v) => !isBlank(v)));
  const widest = Math.max(0, ...filled.map((cells) => cells.length));
  for (let r = 0; r < top.length; r += 1) {
    const cells = filled[r];
    if (!cells.length || r + 1 >= values.length) continue;
    const allText = cells.every((v) => typeof v === "string" && !isNumberLike(v.trim()));
    if (allText && cells.length >= Math.max(1, Math.ceil(widest * 0.6))) return r;
  }
  return 0;
}

// values / numberFormats: Excel's 2-D arrays for one range. colIndex is the
// range's 0-based first column, used to name blank headers ("Kolom D").
export function tableFromGrid(values, { numberFormats = null, name = "Excel", colIndex = 0 } = {}) {
  const grid = Array.isArray(values) ? values : [];
  if (!grid.length || grid.every((row) => (row || []).every(isBlank))) {
    throw new Error("Range data kosong. Pilih tabel berisi header dan baris data.");
  }
  const notes = [];
  const headerRow = detectHeaderRow(grid);
  if (headerRow > 0) notes.push(`Header dibaca dari baris ke-${headerRow + 1} range; ${headerRow} baris di atasnya (judul) tidak dianalisis.`);
  const width = Math.max(...grid.map((row) => row?.length || 0));

  // Data rows: below the header, fully empty rows skipped, trailing total rows left out.
  let errors = 0;
  let body = [];
  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const raw = grid[r] || [];
    if (raw.every(isBlank)) continue;
    const cells = [];
    for (let c = 0; c < width; c += 1) {
      const cell = cellValue(raw[c], numberFormats?.[r]?.[c]);
      if (cell.error) errors += 1;
      cells.push(cell.value);
    }
    body.push({ offset: r, cells });
  }
  while (body.length) {
    const last = body[body.length - 1];
    const label = last.cells.find((v) => typeof v === "string" && !isNumberLike(v));
    if (!label || !TOTAL_RE.test(label)) break;
    notes.push(`Baris ke-${last.offset + 1} ("${label.slice(0, 40)}") tampak sebagai baris total, jadi tidak ikut dianalisis.`);
    body = body.slice(0, -1);
  }
  if (!body.length) throw new Error("Tabel hanya berisi header, belum ada baris data untuk dianalisis.");
  if (body.length > MAX_ANALYSIS_ROWS) {
    throw new Error(`Tabel berisi ${body.length.toLocaleString("id-ID")} baris data; analisis lokal dibatasi 10.000 baris. Pilih range yang lebih kecil.`);
  }
  if (errors) notes.push(`${errors} cell error (#N/A, #DIV/0!, …) dibaca sebagai kosong.`);

  // Columns: blank header + no data → dropped; blank header with data → "Kolom X".
  const header = grid[headerRow] || [];
  const keep = [];
  const named = [];
  for (let c = 0; c < width; c += 1) {
    const label = isBlank(header[c]) ? "" : String(header[c]).trim().replace(/\s+/g, " ").slice(0, MAX_HEADER_CHARS);
    const hasData = body.some((row) => row.cells[c] !== null);
    if (!label && !hasData) continue;
    keep.push(c);
    named.push(label || `Kolom ${colName(colIndex + c + 1)}`);
    if (!label) notes.push(`Kolom tanpa header diberi nama "Kolom ${colName(colIndex + c + 1)}".`);
  }
  if (keep.length > MAX_ANALYSIS_COLUMNS) {
    throw new Error(`Tabel berisi ${keep.length} kolom; analisis lokal dibatasi 50 kolom. Pilih kolom yang relevan saja.`);
  }
  const seen = new Map();
  const columns = named.map((label) => {
    const key = label.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? label : `${label} (${count})`;
  });

  const types = [];
  const kinds = [];
  const rows = body.map(() => []);
  keep.forEach((c) => {
    const present = body.map((row) => row.cells[c]).filter((v) => v !== null);
    const numeric = present.length > 0 && present.every(isNumberLike);
    types.push(numeric ? "number" : "text");
    kinds.push(numeric ? "number" : !present.length ? "empty" : present.every(isIsoDate) ? "date" : "text");
    body.forEach((row, i) => {
      const v = row.cells[c];
      rows[i].push(v === null ? null : numeric ? Number(v) : String(v));
    });
  });

  return {
    data: { name: String(name).slice(0, 150), columns, types, rows, kind: "excel", importedAt: new Date().toISOString() },
    kinds,
    headerRow,
    notes
  };
}

// Invalidation key over exactly what was analysed (values and date formats).
export function sourceFingerprint({ values, numberFormats }) {
  return valuesFingerprint([values, numberFormats]);
}

// Result sheets are written with range.values: text that starts like a
// formula is prefixed with an apostrophe so Excel stores it as text.
export function safeSheetValue(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

// --- Office-bound parts (read-only) -----------------------------------------

const READ_SLACK_ROWS = HEADER_SCAN_ROWS + 50;

function addressPart(address) {
  const text = String(address || "");
  return text.slice(text.lastIndexOf("!") + 1);
}

function tablesSupported() {
  return Boolean(globalThis.Office?.context?.requirements?.isSetSupported?.("ExcelApi", "1.9"));
}

// Which cells to analyse: a multi-row selection; else the Excel table under
// the cursor (ExcelApi 1.9); else the active sheet's used range. Returns the
// values with their number formats plus where they came from, so the result
// can be re-checked before anything is written. Never writes.
export async function readAnalysisSource() {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  return Excel.run(async (context) => {
    const workbook = context.workbook;
    const selection = workbook.getSelectedRange();
    selection.load(["address", "rowCount", "columnCount"]);
    await context.sync();

    let range = null;
    let origin = "";
    let label = "";
    if (selection.rowCount >= 2) {
      range = selection;
      origin = "selection";
      // Whole-column selections ("A:D") are clipped to the cells in use.
      if (selection.rowCount > MAX_ANALYSIS_ROWS + READ_SLACK_ROWS) {
        const used = workbook.worksheets.getActiveWorksheet().getUsedRangeOrNullObject();
        const clipped = selection.getIntersectionOrNullObject(used);
        clipped.load("isNullObject");
        await context.sync();
        if (!clipped.isNullObject) range = clipped;
      }
    } else if (tablesSupported()) {
      const tables = selection.getTables(false);
      tables.load("items/name");
      await context.sync();
      if (tables.items.length === 1) {
        range = tables.items[0].getRange();
        origin = "table";
        label = tables.items[0].name;
      }
    }
    if (!range) {
      const used = workbook.worksheets.getActiveWorksheet().getUsedRangeOrNullObject();
      used.load("isNullObject");
      await context.sync();
      if (used.isNullObject) throw new Error("Sheet aktif kosong. Buka sheet berisi tabel data, atau pilih range-nya.");
      range = used;
      origin = "used";
    }
    range.load(["address", "rowCount", "columnCount", "columnIndex"]);
    range.worksheet.load("name");
    await context.sync();
    if (range.rowCount > MAX_ANALYSIS_ROWS + READ_SLACK_ROWS) {
      throw new Error(`Range ${addressPart(range.address)} berisi ${range.rowCount.toLocaleString("id-ID")} baris; analisis lokal dibatasi 10.000 baris. Pilih range yang lebih kecil.`);
    }
    if (range.columnCount > MAX_ANALYSIS_COLUMNS * 2) {
      throw new Error(`Range ${addressPart(range.address)} berisi ${range.columnCount} kolom; pilih kolom yang relevan saja (maks. 50).`);
    }
    range.load(["values", "numberFormat"]);
    await context.sync();
    return {
      sheet: range.worksheet.name,
      address: addressPart(range.address),
      origin,
      label,
      columnIndex: range.columnIndex,
      values: range.values || [],
      numberFormats: range.numberFormat || null
    };
  });
}

// Re-reads the same cells and returns their fingerprint (read-only), or ""
// when the sheet is gone — which never matches, so a missing source is stale.
export async function readSourceFingerprint(source) {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  return Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getItemOrNullObject(source.sheet);
    sheet.load("isNullObject");
    await context.sync();
    if (sheet.isNullObject) return "";
    const range = sheet.getRange(source.address);
    range.load(["values", "numberFormat"]);
    await context.sync();
    return sourceFingerprint({ values: range.values || [], numberFormats: range.numberFormat || null });
  });
}

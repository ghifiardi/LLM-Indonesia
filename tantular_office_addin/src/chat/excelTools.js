// Excel chat tooling: workbook context reader + guarded action executor.
// The model plans JSON actions; everything here validates and executes them.
// Pure helpers (sanitizeExcelActions, a1Dims) are Office-free for unit tests.

import {
  columnMapReadShape,
  columnMapToPromptText,
  profileColumns,
  sanitizeSeriesChart
} from "./excelSeriesChart.js";
import { sanitizeHistogram } from "./excelHistogram.js";
import { createStepRunner, failAfterCleanup, rangeArg } from "./excelChartRun.js";

const MAX_WRITE_CELLS_PER_TURN = 400;
const MAX_SHEET_ROWS = 60;
const MAX_SHEET_COLS = 20;
// Radar = Excel's "spider/web" chart (Excel.ChartType Radar/RadarMarkers/RadarFilled).
const CHART_TYPES = new Set(["ColumnClustered", "BarClustered", "Line", "Pie", "Radar", "RadarMarkers", "RadarFilled"]);
const A1_RE = /^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/;

export function a1Dims(address) {
  const match = A1_RE.exec(String(address || "").trim());
  if (!match) return null;
  const colNum = (letters) => [...letters.toUpperCase()].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  const c1 = colNum(match[1]);
  const r1 = Number(match[2]);
  const c2 = match[3] ? colNum(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) : r1;
  if (c2 < c1 || r2 < r1) return null;
  return { rows: r2 - r1 + 1, cols: c2 - c1 + 1 };
}

// Validate + normalize raw model actions. Returns { actions, rejected } where
// rejected is a list of human-readable reasons (surfaced in chat, not hidden).
export function sanitizeExcelActions(rawActions) {
  const actions = [];
  const rejected = [];
  let writeBudget = MAX_WRITE_CELLS_PER_TURN;
  // Sheet-wide edits (translate/clean-up) legitimately need many per-cell
  // writes; the real safety valve is the cell budget, not the action count.
  const list = Array.isArray(rawActions) ? rawActions.slice(0, 60) : [];

  for (const raw of list) {
    const op = String(raw?.op || "").trim();
    const sheet = String(raw?.sheet || "").trim().slice(0, 31);

    if (op === "write_cells") {
      const address = String(raw.address || "").trim();
      const values = raw.values;
      if (!A1_RE.test(address)) { rejected.push(`write_cells: alamat "${address}" tidak valid.`); continue; }
      if (!Array.isArray(values) || !values.length || !Array.isArray(values[0]) || !values[0].length) {
        rejected.push(`write_cells ${address}: "values" harus array 2 dimensi.`); continue;
      }
      const rows = values.length;
      const cols = Math.max(...values.map((r) => (Array.isArray(r) ? r.length : 0)));
      const cells = rows * cols;
      if (cells > writeBudget) { rejected.push(`write_cells ${address}: ${cells} cell melebihi batas ${MAX_WRITE_CELLS_PER_TURN}/giliran.`); continue; }
      writeBudget -= cells;
      const norm = values.map((r) => {
        const row = Array.isArray(r) ? [...r] : [r];
        while (row.length < cols) row.push("");
        return row.map((v) => (v == null ? "" : v));
      });
      actions.push({ op, sheet, address, values: norm });
    } else if (op === "set_formula") {
      const address = String(raw.address || "").trim();
      const formula = String(raw.formula || "").trim();
      const dims = a1Dims(address);
      if (!dims || dims.rows * dims.cols !== 1) { rejected.push(`set_formula: alamat "${address}" harus satu cell.`); continue; }
      if (!formula.startsWith("=")) { rejected.push(`set_formula ${address}: formula harus diawali "=".`); continue; }
      if (writeBudget < 1) { rejected.push(`set_formula ${address}: batas tulis ${MAX_WRITE_CELLS_PER_TURN} cell/giliran habis.`); continue; }
      writeBudget -= 1;
      actions.push({ op, sheet, address, formula });
    } else if (op === "add_sheet") {
      const name = String(raw.name || "Sheet Tantular").trim().replace(/[\\/?*\[\]:]/g, " ").slice(0, 31) || "Sheet Tantular";
      const columns = Array.isArray(raw.columns) ? raw.columns.slice(0, MAX_SHEET_COLS).map((c) => String(c ?? "")) : [];
      const rows = (Array.isArray(raw.rows) ? raw.rows.slice(0, MAX_SHEET_ROWS) : [])
        .map((r) => (Array.isArray(r) ? r.slice(0, columns.length || MAX_SHEET_COLS).map((v) => (v == null ? "" : v)) : []));
      if (!columns.length) { rejected.push(`add_sheet "${name}": "columns" kosong.`); continue; }
      actions.push({ op, name, columns, rows });
    } else if (op === "add_chart") {
      const type = CHART_TYPES.has(raw.type) ? raw.type : "ColumnClustered";
      const dataAddress = String(raw.dataAddress || raw.address || "").trim();
      if (dataAddress.includes(",")) {
        rejected.push(`add_chart: "${dataAddress}" terdiri dari beberapa range terpisah; add_chart hanya menerima satu range kontinu. Untuk kolom terpisah (mis. tanggal, target, aktual) gunakan add_series_chart.`);
        continue;
      }
      if (!A1_RE.test(dataAddress)) { rejected.push(`add_chart: dataAddress "${dataAddress}" tidak valid.`); continue; }
      actions.push({ op, sheet: String(raw.sheet || "").trim(), type, dataAddress, title: String(raw.title || "").slice(0, 80) });
    } else if (op === "add_series_chart") {
      const { action, error } = sanitizeSeriesChart(raw);
      if (error) { rejected.push(error); continue; }
      actions.push(action);
    } else if (op === "add_histogram") {
      const { action, error } = sanitizeHistogram(raw);
      if (error) { rejected.push(error); continue; }
      actions.push(action);
    } else if (op) {
      rejected.push(`Aksi "${op}" tidak dikenal (didukung: write_cells, set_formula, add_sheet, add_chart, add_series_chart, add_histogram).`);
    }
  }
  return { actions, rejected };
}

// Chart actions never run straight from a plan: the chat shows a preview and
// creates the chart only on the user's click (see excelChat.js).
export function isChartAction(action) {
  return action?.op === "add_chart" || action?.op === "add_series_chart" || action?.op === "add_histogram";
}

// --- Office-bound parts -----------------------------------------------------

export function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Flatten a values grid into addressed non-empty cells: [{address, value}].
// rowIndex/colIndex are the grid's 0-based absolute offsets in the sheet.
// Caps keep the prompt bounded; `truncated` tells the model data was cut.
export function gridToAddressedCells(values, rowIndex = 0, colIndex = 0, { maxCells = 250, maxChars = 9000 } = {}) {
  const cells = [];
  let chars = 0;
  let truncated = false;
  for (let r = 0; r < (values?.length || 0); r += 1) {
    for (let c = 0; c < (values[r]?.length || 0); c += 1) {
      const raw = values[r][c];
      if (raw === "" || raw == null) continue;
      const value = String(raw).slice(0, 300);
      if (cells.length >= maxCells || chars + value.length > maxChars) { truncated = true; break; }
      cells.push({ address: `${colLetter(colIndex + c + 1)}${rowIndex + r + 1}`, value });
      chars += value.length;
    }
    if (truncated) break;
  }
  return { cells, truncated };
}

// Workbook snapshot for the model prompt: every non-empty cell of the active
// sheet WITH its address (bounded), so sheet-wide edits (translate, clean up,
// reformat) are plannable as write_cells back to exact addresses.
export async function getExcelChatContext() {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  return Excel.run(async (context) => {
    const workbook = context.workbook;
    const sheets = workbook.worksheets;
    sheets.load("items/name");
    const active = workbook.worksheets.getActiveWorksheet();
    active.load("name");
    const used = active.getUsedRangeOrNullObject();
    used.load(["address", "rowCount", "columnCount", "rowIndex", "columnIndex", "isNullObject"]);
    const selection = workbook.getSelectedRange();
    selection.load(["address", "rowCount", "columnCount"]);
    await context.sync();

    let cells = [];
    let truncated = false;
    let usedAddress = "";
    if (!used.isNullObject) {
      usedAddress = used.address;
      const rows = Math.min(used.rowCount, 120);
      const cols = Math.min(used.columnCount, 20);
      const sampleRange = used.getAbsoluteResizedRange(rows, cols);
      sampleRange.load("values");
      await context.sync();
      ({ cells, truncated } = gridToAddressedCells(sampleRange.values || [], used.rowIndex, used.columnIndex));
      if (rows < used.rowCount || cols < used.columnCount) truncated = true;
    }

    // Column map: one line per used column (header + numeric extent), so a
    // wide sheet's far columns (e.g. AA, BF) are visible to the planner even
    // though the per-cell sample above stops at 20 columns. Bounded by
    // columnMapReadShape (≤100 columns, ≤20k cells read).
    let columnMap = null;
    if (!used.isNullObject) {
      const shape = columnMapReadShape(used.rowCount, used.columnCount);
      const block = used.getAbsoluteResizedRange(shape.rows, shape.cols);
      block.load(["values", "numberFormat"]);
      await context.sync();
      columnMap = {
        ...profileColumns(block.values || [], {
          rowIndex: used.rowIndex,
          colIndex: used.columnIndex,
          numberFormats: block.numberFormat
        }),
        rowsTruncated: shape.rows < used.rowCount,
        rowsRead: shape.rows
      };
    }

    let selectionValues = [];
    let selectionMap = null;
    const selectionCells = selection.rowCount * selection.columnCount;
    if (selectionCells <= 50) {
      selection.load("values");
      await context.sync();
      selectionValues = selection.values || [];
    } else if (selectionCells <= 20_000) {
      // A large selection is summarized per column instead of dropped.
      selection.load(["values", "numberFormat", "rowIndex", "columnIndex"]);
      await context.sync();
      selectionMap = {
        ...profileColumns(selection.values || [], {
          rowIndex: selection.rowIndex,
          colIndex: selection.columnIndex,
          numberFormats: selection.numberFormat
        }),
        rowsTruncated: false,
        rowsRead: selection.rowCount
      };
    }

    return {
      activeSheet: active.name,
      sheetNames: (sheets.items || []).map((s) => s.name),
      usedAddress,
      cells,
      truncated,
      columnMap,
      selectionAddress: selection.address,
      selectionValues,
      selectionMap
    };
  });
}

export function contextToPromptText(ctx) {
  const lines = [
    `Sheet aktif: ${ctx.activeSheet}`,
    `Semua sheet: ${ctx.sheetNames.join(", ") || "-"}`,
    `Data terpakai: ${ctx.usedAddress || "(kosong)"}`
  ];
  if (ctx.cells?.length) {
    lines.push("Isi sheet aktif per cell (alamat: nilai) — inilah bukti isi sheet:");
    for (const cell of ctx.cells) lines.push(`${cell.address}: ${cell.value}`);
    if (ctx.truncated) lines.push("(sebagian isi terpotong karena batas ukuran — sebutkan di reply jika relevan)");
  }
  const columnMapText = columnMapToPromptText(ctx.columnMap);
  if (columnMapText) lines.push(columnMapText);
  lines.push(`Seleksi pengguna: ${ctx.selectionAddress || "-"}`);
  if (ctx.selectionValues?.length) {
    lines.push("Nilai seleksi:");
    for (const row of ctx.selectionValues) lines.push(row.map((v) => String(v ?? "")).join(" | "));
  }
  const selectionMapText = columnMapToPromptText(ctx.selectionMap);
  if (selectionMapText) lines.push(selectionMapText.replace(/^Peta kolom sheet aktif/, "Ringkasan seleksi per kolom"));
  return lines.join("\n");
}

// Execute sanitized actions. Each action is isolated: one failure is reported
// and the rest still run. Returns per-action result lines for the chat bubble.
export async function executeExcelActions(actions) {
  if (!actions.length) return [];
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  const results = [];
  for (const action of actions) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOneAction(action));
    } catch (error) {
      console.warn("[TantularChat/Excel] aksi gagal", action, error, error?.debugInfo);
      results.push(`❌ ${action.op}${action.address ? ` ${action.address}` : ""}: ${error?.message || String(error)}`);
    }
  }
  return results;
}

async function runOneAction(action) {
  return Excel.run(async (context) => {
    const workbook = context.workbook;
    const resolveSheet = (name) => (name ? workbook.worksheets.getItem(name) : workbook.worksheets.getActiveWorksheet());

    if (action.op === "write_cells") {
      const sheet = resolveSheet(action.sheet);
      const rows = action.values.length;
      const cols = action.values[0].length;
      // Anchor on the top-left cell and resize: forgiving when the model gives
      // a single-cell anchor for a block of values (avoids shape mismatch).
      const target = sheet.getRange(action.address).getCell(0, 0).getResizedRange(rows - 1, cols - 1);
      target.values = action.values;
      target.load("address");
      await context.sync();
      return `✅ ${rows}×${cols} nilai ditulis di ${target.address}.`;
    }

    if (action.op === "set_formula") {
      const sheet = resolveSheet(action.sheet);
      const target = sheet.getRange(action.address);
      target.formulas = [[action.formula]];
      await context.sync();
      return `✅ Formula ${action.formula} dipasang di ${action.address}.`;
    }

    if (action.op === "add_sheet") {
      const existing = workbook.worksheets;
      existing.load("items/name");
      await context.sync();
      const usedNames = new Set((existing.items || []).map((s) => String(s.name).toLowerCase()));
      let name = action.name;
      let suffix = 2;
      while (usedNames.has(name.toLowerCase())) name = `${action.name.slice(0, 28)} ${suffix++}`;
      const sheet = workbook.worksheets.add(name);
      const values = [action.columns, ...action.rows.map((r) => {
        const row = [...r];
        while (row.length < action.columns.length) row.push("");
        return row;
      })];
      const range = sheet.getRangeByIndexes(0, 0, values.length, action.columns.length);
      range.values = values;
      range.format.autofitColumns();
      const header = sheet.getRangeByIndexes(0, 0, 1, action.columns.length);
      header.format.font.bold = true;
      sheet.activate();
      await context.sync();
      return `✅ Sheet "${name}" dibuat (${action.columns.length} kolom, ${action.rows.length} baris data).`;
    }

    if (action.op === "add_chart") return addChart(context, action);

    throw new Error(`Aksi tidak dikenal: ${action.op}`);
  });
}

// One continuous range → one chart. Office.js reports a failure only at
// sync, after the calls queued before it already ran, so a single sync over
// charts.add + setPosition + title left a chart behind whenever a later call
// threw (the old try/catch around setPosition could never catch it). Every
// call is now its own step; a failure after charts.add deletes the chart.
// Placement stays best-effort: if it fails, the finished chart keeps Excel's
// default position and the message says so.
async function addChart(context, action) {
  const workbook = context.workbook;
  const sheetName = action.sheet || "";
  const resolve = () => (sheetName ? workbook.worksheets.getItem(sheetName) : workbook.worksheets.getActiveWorksheet());
  const beforeNames = await chartNamesOn(context, resolve());
  const { step } = createStepRunner(context);
  const sheet = resolve();
  let chartName = "";
  try {
    const chart = await step("ChartCollection.add", [JSON.stringify(action.type), rangeArg(sheetName, action.dataAddress), '"Auto"'], () => {
      const created = sheet.charts.add(action.type, sheet.getRange(action.dataAddress), "Auto");
      created.load("name");
      return created;
    });
    chartName = chart.name;
    if (action.title) await step("ChartTitle.text", [JSON.stringify(action.title)], () => { chart.title.text = action.title; });
    const dims = a1Dims(action.dataAddress);
    // Below a tall range means hundreds of rows off-screen — users think no
    // chart was created. Tall data gets the chart BESIDE its top edge.
    const tall = (dims?.rows || 1) > 25;
    const [dr, dc] = tall ? [0, (dims?.cols || 1) + 1] : [(dims?.rows || 1) + 2, 0];
    let placement;
    try {
      await step("Chart.setPosition", [`getOffsetRange(${dr}, ${dc})`, "getOffsetRange(16, 8)"], () => {
        const anchor = sheet.getRange(action.dataAddress).getCell(0, 0).getOffsetRange(dr, dc);
        chart.setPosition(anchor, anchor.getOffsetRange(16, 8));
      });
      placement = tall ? " di samping kanan-atas data" : " di bawah data";
    } catch (_) {
      placement = " di posisi bawaan Excel (penempatan otomatis gagal)";
    }
    return `✅ Chart ${action.type} dibuat dari ${action.dataAddress}${placement}.`;
  } catch (error) {
    throw await failAfterCleanup(error, { sheet: sheetName, chartName, beforeNames });
  }
}

async function chartNamesOn(context, sheet) {
  sheet.charts.load("items/name");
  await context.sync();
  return sheet.charts.items.map((c) => c.name);
}

// Excel chat tooling: workbook context reader + guarded action executor.
// The model plans JSON actions; everything here validates and executes them.
// Pure helpers (sanitizeExcelActions, a1Dims) are Office-free for unit tests.

const MAX_WRITE_CELLS_PER_TURN = 400;
const MAX_SHEET_ROWS = 60;
const MAX_SHEET_COLS = 20;
const CHART_TYPES = new Set(["ColumnClustered", "BarClustered", "Line", "Pie"]);
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
  const list = Array.isArray(rawActions) ? rawActions.slice(0, 12) : [];

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
      if (!A1_RE.test(dataAddress)) { rejected.push(`add_chart: dataAddress "${dataAddress}" tidak valid.`); continue; }
      actions.push({ op, sheet: String(raw.sheet || "").trim(), type, dataAddress, title: String(raw.title || "").slice(0, 80) });
    } else if (op) {
      rejected.push(`Aksi "${op}" tidak dikenal (didukung: write_cells, set_formula, add_sheet, add_chart).`);
    }
  }
  return { actions, rejected };
}

// --- Office-bound parts -----------------------------------------------------

// Compact workbook snapshot for the model prompt.
export async function getExcelChatContext() {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  return Excel.run(async (context) => {
    const workbook = context.workbook;
    const sheets = workbook.worksheets;
    sheets.load("items/name");
    const active = workbook.worksheets.getActiveWorksheet();
    active.load("name");
    const used = active.getUsedRangeOrNullObject();
    used.load(["address", "rowCount", "columnCount", "isNullObject"]);
    const selection = workbook.getSelectedRange();
    selection.load(["address", "rowCount", "columnCount"]);
    await context.sync();

    let sample = [];
    let usedAddress = "";
    if (!used.isNullObject) {
      usedAddress = used.address;
      const rows = Math.min(used.rowCount, 12);
      const cols = Math.min(used.columnCount, 10);
      const sampleRange = used.getAbsoluteResizedRange(rows, cols);
      sampleRange.load("values");
      await context.sync();
      sample = sampleRange.values || [];
    }

    let selectionValues = [];
    if (selection.rowCount * selection.columnCount <= 50) {
      selection.load("values");
      await context.sync();
      selectionValues = selection.values || [];
    }

    return {
      activeSheet: active.name,
      sheetNames: (sheets.items || []).map((s) => s.name),
      usedAddress,
      sample,
      selectionAddress: selection.address,
      selectionValues
    };
  });
}

export function contextToPromptText(ctx) {
  const lines = [
    `Sheet aktif: ${ctx.activeSheet}`,
    `Semua sheet: ${ctx.sheetNames.join(", ") || "-"}`,
    `Data terpakai: ${ctx.usedAddress || "(kosong)"}`
  ];
  if (ctx.sample?.length) {
    lines.push("Cuplikan data (baris pertama = kemungkinan header):");
    for (const row of ctx.sample) lines.push(row.map((v) => String(v ?? "")).join(" | "));
  }
  lines.push(`Seleksi pengguna: ${ctx.selectionAddress || "-"}`);
  if (ctx.selectionValues?.length) {
    lines.push("Nilai seleksi:");
    for (const row of ctx.selectionValues) lines.push(row.map((v) => String(v ?? "")).join(" | "));
  }
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

    if (action.op === "add_chart") {
      const sheet = resolveSheet(action.sheet);
      const dataRange = sheet.getRange(action.dataAddress);
      const chart = sheet.charts.add(action.type, dataRange, "Auto");
      try {
        const dims = a1Dims(action.dataAddress);
        const anchorRow = dims ? dims.rows + 2 : 2;
        chart.setPosition(
          sheet.getRange(action.dataAddress).getCell(0, 0).getOffsetRange(anchorRow, 0),
          sheet.getRange(action.dataAddress).getCell(0, 0).getOffsetRange(anchorRow + 15, Math.max(7, (dims?.cols || 4)))
        );
      } catch (_) { /* position is best-effort */ }
      try { if (action.title) chart.title.text = action.title; } catch (_) { /* optional */ }
      await context.sync();
      return `✅ Chart ${action.type} dibuat dari ${action.dataAddress}.`;
    }

    throw new Error(`Aksi tidak dikenal: ${action.op}`);
  });
}

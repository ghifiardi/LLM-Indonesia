// Review-then-apply for the Excel chat's non-chart changes (write_cells,
// set_formula, add_sheet). The planner's actions are never run straight from
// the plan: readLiveEditPreview() reads (only reads) every target range so the
// review can show what will be overwritten, and applyEditPreview() runs on the
// user's "Terapkan" click after re-reading those ranges to prove they did not
// change in between. Pure helpers are Office-free for unit tests.

import { executeExcelActions } from "./excelTools.js";
import { colName, parseRangeRef, valuesFingerprint } from "./excelSeriesChart.js";

const SAMPLE_VALUES = 3;

// { sheet, address } of the cells an action will change, or null (add_sheet).
// write_cells anchors on the top-left cell and resizes to its values, exactly
// as the executor does, so the review shows the block that really changes.
export function writeTarget(action) {
  if (action.op === "set_formula") return { sheet: action.sheet || "", address: action.address };
  if (action.op !== "write_cells") return null;
  const ref = parseRangeRef(action.address);
  if (!ref) return null;
  const rows = action.values.length;
  const cols = action.values[0].length;
  const end = `${colName(ref.c1 + cols - 1)}${ref.r1 + rows - 1}`;
  const start = `${colName(ref.c1)}${ref.r1}`;
  return { sheet: action.sheet || "", address: rows === 1 && cols === 1 ? start : `${start}:${end}` };
}

const filled = (value) => value !== "" && value != null;
const quote = (value) => `"${String(value).slice(0, 40)}"`;
const sheetLabel = (sheet) => (sheet ? `sheet "${sheet}"` : "sheet aktif");

function overwritten(before, after) {
  let count = 0;
  for (let r = 0; r < after.length; r += 1) {
    for (let c = 0; c < after[r].length; c += 1) {
      const old = before?.[r]?.[c];
      if (filled(old) && String(old) !== String(after[r][c])) count += 1;
    }
  }
  return count;
}

// `current[i]` per action: { formulas } for an existing target, { newSheet }
// when the target sheet is created earlier in this plan, { missingSheet }
// when it does not exist at all, null for add_sheet.
export function buildEditPreview(actions, current) {
  const items = [];
  const blocked = [];
  let overwrites = 0;
  actions.forEach((action, index) => {
    const now = current[index];
    const target = writeTarget(action);
    if (now?.missingSheet) blocked.push(`Sheet "${target.sheet}" tidak ada di workbook (${action.op} ${target.address}).`);
    const where = target ? `${target.address} (${sheetLabel(target.sheet)}${now?.newSheet ? ", sheet baru" : ""})` : "";
    if (action.op === "write_cells") {
      const sample = action.values.flat().filter(filled).slice(0, SAMPLE_VALUES).map(quote).join(", ");
      const count = overwritten(now?.formulas, action.values);
      overwrites += count;
      items.push(`• Tulis ${action.values.length}×${action.values[0].length} nilai di ${where}`
        + `${sample ? ` — contoh: ${sample}` : ""}${count ? `; menimpa ${count} cell berisi` : ""}`);
    } else if (action.op === "set_formula") {
      const old = now?.formulas?.[0]?.[0];
      const replaces = filled(old) && String(old) !== action.formula;
      if (replaces) overwrites += 1;
      items.push(`• Formula ${action.formula} di ${where}${replaces ? `; menimpa ${quote(old)}` : ""}`);
    } else if (action.op === "add_sheet") {
      items.push(`• Sheet baru "${action.name}": ${action.columns.length} kolom (${action.columns.join(", ").slice(0, 120)}), ${action.rows.length} baris data`);
    }
  });
  return { actions, items, blocked, overwrites, fingerprint: valuesFingerprint(current) };
}

export function editPreviewText(preview) {
  const lines = [`Pratinjau ${preview.actions.length} perubahan:`, ...preview.items];
  if (preview.overwrites) lines.push(`⚠️ ${preview.overwrites} cell berisi akan ditimpa.`);
  if (preview.blocked.length) {
    lines.push(...preview.blocked.map((b) => `❌ ${b}`));
    lines.push("Workbook belum diubah. Perubahan ini tidak bisa diterapkan; perjelas permintaannya.");
  } else {
    lines.push("Workbook belum diubah. Klik \"Terapkan\" untuk menjalankan semua perubahan di atas.");
  }
  return lines.join("\n");
}

// --- Office-bound parts -----------------------------------------------------

// Read-only: loads the current content of every target range. Never writes.
async function readEditTargets(actions) {
  if (!globalThis.Excel?.run) throw new Error("Excel JavaScript API tidak tersedia.");
  const created = new Set(actions.filter((a) => a.op === "add_sheet").map((a) => a.name.toLowerCase()));
  return Excel.run(async (context) => {
    const books = context.workbook.worksheets;
    const targets = actions.map(writeTarget);
    const sheets = targets.map((target) => {
      if (!target) return null;
      if (!target.sheet) return books.getActiveWorksheet();
      const sheet = books.getItemOrNullObject(target.sheet);
      sheet.load("isNullObject");
      return sheet;
    });
    await context.sync();
    const missing = targets.map((target, i) => Boolean(target?.sheet && sheets[i].isNullObject));
    const ranges = targets.map((target, i) => {
      if (!target || missing[i]) return null;
      const range = sheets[i].getRange(target.address);
      range.load("formulas");
      return range;
    });
    await context.sync();
    return targets.map((target, i) => {
      if (!target) return null;
      if (missing[i]) return created.has(target.sheet.toLowerCase()) ? { newSheet: true } : { missingSheet: true };
      return { formulas: ranges[i].formulas };
    });
  });
}

export async function readLiveEditPreview(actions) {
  return buildEditPreview(actions, await readEditTargets(actions));
}

// The ONLY write path for these actions: called from the "Terapkan" click.
// Returns the executor's per-action result lines (✅/❌).
export async function applyEditPreview(preview) {
  if (preview.blocked.length) throw new Error(preview.blocked.join(" "));
  const fresh = await readLiveEditPreview(preview.actions);
  if (fresh.blocked.length) throw new Error(fresh.blocked.join(" "));
  if (fresh.fingerprint !== preview.fingerprint) {
    throw new Error("Isi cell tujuan berubah sejak pratinjau. Minta perubahan lagi agar pratinjaunya sesuai data terbaru.");
  }
  return executeExcelActions(preview.actions);
}

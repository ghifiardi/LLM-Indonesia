import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEditPreview,
  buildEditPreview,
  editPreviewText,
  readLiveEditPreview,
  writeTarget
} from "../src/chat/excelEditPreview.js";
import { colName, parseRangeRef } from "../src/chat/excelSeriesChart.js";
import { sanitizeExcelActions } from "../src/chat/excelTools.js";

const plan = (raw) => sanitizeExcelActions(raw).actions;

// --- Pure: what each change targets and how it is described ----------------

test("writeTarget expands a write anchor to the full block it will fill", () => {
  const [write, formula, sheet] = plan([
    { op: "write_cells", sheet: "Data", address: "B2", values: [["a", "b"], ["c", "d"], ["e", "f"]] },
    { op: "set_formula", address: "D2", formula: "=SUM(A1:A5)" },
    { op: "add_sheet", name: "Ringkasan", columns: ["Kol1"] }
  ]);
  assert.deepEqual(writeTarget(write), { sheet: "Data", address: "B2:C4" });
  assert.deepEqual(writeTarget(formula), { sheet: "", address: "D2" });
  assert.equal(writeTarget(sheet), null);
});

test("the review lists every change with its range, size, sample and sheet", () => {
  const actions = plan([
    { op: "write_cells", sheet: "Data", address: "B2", values: [["Total", 12], ["Rata-rata", 4]] },
    { op: "set_formula", address: "D2", formula: "=SUM(A1:A5)" },
    { op: "add_sheet", name: "Ringkasan", columns: ["Bidang", "Skor"], rows: [["G", 3], ["P", 2]] }
  ]);
  const preview = buildEditPreview(actions, [{ formulas: [["", ""], ["", ""]] }, { formulas: [[""]] }, null]);
  const text = editPreviewText(preview);
  assert.match(text, /2×2 nilai di B2:C3 \(sheet "Data"\)/);
  assert.match(text, /"Total"/);
  assert.match(text, /=SUM\(A1:A5\) di D2 \(sheet aktif\)/);
  assert.match(text, /Sheet baru "Ringkasan": 2 kolom \(Bidang, Skor\), 2 baris data/);
  assert.match(text, /Workbook belum diubah/);
  assert.match(text, /Terapkan/);
  assert.equal(preview.blocked.length, 0);
});

test("overwriting non-empty cells is called out; writing the same content is not", () => {
  const actions = plan([
    { op: "write_cells", address: "A1", values: [["x", "same"], ["y", "z"]] },
    { op: "set_formula", address: "C1", formula: "=A1*2" }
  ]);
  const preview = buildEditPreview(actions, [
    { formulas: [["old", "same"], ["", "keep?"]] },
    { formulas: [["=A1*3"]] }
  ]);
  const text = editPreviewText(preview);
  assert.match(text, /menimpa 2 cell berisi/);
  assert.match(text, /menimpa "=A1\*3"/);
  assert.match(text, /3 cell berisi akan ditimpa/);
});

test("a change aimed at a sheet that does not exist blocks the whole review", () => {
  const actions = plan([{ op: "write_cells", sheet: "Tidak Ada", address: "A1", values: [["x"]] }]);
  const preview = buildEditPreview(actions, [{ missingSheet: true }]);
  assert.equal(preview.blocked.length, 1);
  const text = editPreviewText(preview);
  assert.match(text, /Tidak Ada/);
  assert.doesNotMatch(text, /Klik "Terapkan"/);
});

test("writes into a sheet created earlier in the same plan are allowed", () => {
  const actions = plan([
    { op: "add_sheet", name: "Ringkasan", columns: ["A"] },
    { op: "write_cells", sheet: "Ringkasan", address: "B2", values: [["x"]] }
  ]);
  const preview = buildEditPreview(actions, [null, { newSheet: true }]);
  assert.equal(preview.blocked.length, 0);
  assert.match(editPreviewText(preview), /sheet baru/);
});

test("the fingerprint changes when the target cells change", () => {
  const actions = plan([{ op: "write_cells", address: "A1", values: [["x"]] }]);
  const a = buildEditPreview(actions, [{ formulas: [[""]] }]);
  const b = buildEditPreview(actions, [{ formulas: [["typed meanwhile"]] }]);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

// --- Office-bound: read-only review, guarded apply -------------------------

function fakeWorkbook(sheets) {
  const writes = [];
  const added = [];
  const cellsOf = (grid, address) => {
    const ref = parseRangeRef(address);
    const out = [];
    for (let r = ref.r1; r <= ref.r2; r += 1) {
      const row = [];
      for (let c = ref.c1; c <= ref.c2; c += 1) row.push(grid[`${colName(c)}${r}`] ?? "");
      out.push(row);
    }
    return out;
  };
  const makeSheet = (name) => {
    const grid = sheets[name];
    const range = (address) => ({
      address,
      load() {},
      get formulas() { return cellsOf(grid, address); },
      set values(v) { writes.push([name, address, v]); },
      set formulas(v) { writes.push([name, address, v]); },
      getCell(r, c) {
        const ref = parseRangeRef(address);
        return range(`${colName(ref.c1 + c)}${ref.r1 + r}`);
      },
      getResizedRange(dr, dc) {
        const ref = parseRangeRef(address);
        return range(`${address}:${colName(ref.c1 + dc)}${ref.r1 + dr}`);
      }
    });
    return { name, isNullObject: false, load() {}, getRange: range };
  };
  const worksheets = {
    getActiveWorksheet: () => makeSheet("Data"),
    getItem: (name) => makeSheet(name),
    getItemOrNullObject: (name) => (sheets[name] ? makeSheet(name) : { isNullObject: true, load() {} }),
    add: (name) => { added.push(name); return makeSheet(name); }
  };
  const context = { workbook: { worksheets }, sync: async () => {} };
  return { Excel: { run: async (fn) => fn(context) }, writes, added };
}

function install(fake) {
  globalThis.Excel = fake.Excel;
  return () => { delete globalThis.Excel; };
}

test("reading the review never writes to the workbook", async () => {
  const fake = fakeWorkbook({ Data: { A1: "old" } });
  const restore = install(fake);
  try {
    const preview = await readLiveEditPreview(plan([
      { op: "write_cells", address: "A1", values: [["new"]] },
      { op: "write_cells", sheet: "Tidak Ada", address: "A1", values: [["x"]] }
    ]));
    assert.equal(fake.writes.length, 0);
    assert.match(editPreviewText(preview), /menimpa 1 cell berisi/);
    assert.equal(preview.blocked.length, 1);
  } finally {
    restore();
  }
});

test("apply refuses when the target cells changed after the review", async () => {
  const grid = { A1: "" };
  const fake = fakeWorkbook({ Data: grid });
  const restore = install(fake);
  try {
    const preview = await readLiveEditPreview(plan([{ op: "write_cells", address: "A1", values: [["new"]] }]));
    grid.A1 = "typed meanwhile";
    await assert.rejects(applyEditPreview(preview), /berubah sejak pratinjau/);
    assert.equal(fake.writes.length, 0);
  } finally {
    restore();
  }
});

test("apply refuses a blocked review even if called directly", async () => {
  const fake = fakeWorkbook({ Data: {} });
  const restore = install(fake);
  try {
    const preview = await readLiveEditPreview(plan([{ op: "write_cells", sheet: "Tidak Ada", address: "A1", values: [["x"]] }]));
    await assert.rejects(applyEditPreview(preview), /Tidak Ada/);
    assert.equal(fake.writes.length, 0);
  } finally {
    restore();
  }
});

test("apply on an unchanged review writes and reports each result", async () => {
  const fake = fakeWorkbook({ Data: { A1: "" } });
  const restore = install(fake);
  try {
    const preview = await readLiveEditPreview(plan([{ op: "write_cells", address: "A1", values: [["new"]] }]));
    const results = await applyEditPreview(preview);
    assert.equal(fake.writes.length, 1);
    assert.equal(results.length, 1);
    assert.match(results[0], /^✅/);
  } finally {
    restore();
  }
});

// --- Wiring: nothing in the Excel chat writes outside a click --------------

test("Excel chat runs edits and charts only from their confirm clicks", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chat = fs.readFileSync(path.join(root, "src/chat/excelChat.js"), "utf8");
  assert.match(chat, /renderEditPreview\(answer, otherActions, chartActions\)/);
  // Edits: one apply call, inside the "Terapkan" click handler.
  assert.equal(chat.split("applyEditPreview(").length - 1, 1);
  const applyClick = chat.indexOf('apply.addEventListener("click"');
  assert.ok(applyClick > 0 && chat.indexOf("await applyEditPreview(preview)") > applyClick);
  // The plan no longer executes anything directly.
  assert.equal(chat.split("executeExcelActions(").length - 1, 1, "only the add_chart confirm click executes");
  const chartClick = chat.indexOf('confirm.addEventListener("click"');
  assert.ok(chartClick > 0 && chat.indexOf("executeExcelActions([action])") > chartClick);
  assert.doesNotMatch(chat, /Menjalankan \$\{otherActions\.length\} aksi/);
});

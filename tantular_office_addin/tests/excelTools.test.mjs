import test from "node:test";
import assert from "node:assert/strict";
import { a1Dims, sanitizeExcelActions } from "../src/chat/excelTools.js";

test("a1Dims parses single cells and ranges", () => {
  assert.deepEqual(a1Dims("B2"), { rows: 1, cols: 1 });
  assert.deepEqual(a1Dims("A1:C10"), { rows: 10, cols: 3 });
  assert.equal(a1Dims("Sheet1!A1"), null); // sheet prefix handled via "sheet" field
  assert.equal(a1Dims("banana"), null);
  assert.equal(a1Dims("C10:A1"), null); // inverted range
});

test("sanitize accepts valid actions of every op", () => {
  const { actions, rejected } = sanitizeExcelActions([
    { op: "write_cells", address: "B2", values: [["a", "b"], ["c"]] },
    { op: "set_formula", address: "D2", formula: "=SUM(A1:A5)" },
    { op: "add_sheet", name: "Ringkasan", columns: ["Kol1", "Kol2"], rows: [["x", 1]] },
    { op: "add_chart", type: "Line", dataAddress: "A1:C10", title: "Tren" }
  ]);
  assert.equal(rejected.length, 0);
  assert.equal(actions.length, 4);
  // short row padded to rectangle
  assert.deepEqual(actions[0].values, [["a", "b"], ["c", ""]]);
});

test("sanitize rejects bad addresses, formulas, and unknown ops", () => {
  const { actions, rejected } = sanitizeExcelActions([
    { op: "write_cells", address: "not-an-address", values: [["x"]] },
    { op: "set_formula", address: "A1:B2", formula: "=SUM(A:A)" }, // must be one cell
    { op: "set_formula", address: "A1", formula: "SUM(A:A)" }, // missing "="
    { op: "delete_sheet", name: "Data" },
    { op: "add_chart", dataAddress: "??" }
  ]);
  assert.equal(actions.length, 0);
  assert.equal(rejected.length, 5);
});

test("sanitize enforces the per-turn write budget", () => {
  const big = Array.from({ length: 30 }, () => Array.from({ length: 20 }, () => "x")); // 600 cells
  const { actions, rejected } = sanitizeExcelActions([
    { op: "write_cells", address: "A1", values: big }
  ]);
  assert.equal(actions.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /melebihi batas/);
});

test("sanitize defaults chart type and caps sheet size", () => {
  const { actions } = sanitizeExcelActions([
    { op: "add_chart", type: "Radar3D", dataAddress: "A1:B5" },
    { op: "add_sheet", name: "Big", columns: Array.from({ length: 40 }, (_, i) => `K${i}`), rows: [] }
  ]);
  assert.equal(actions[0].type, "ColumnClustered");
  assert.equal(actions[1].columns.length, 20);
});

test("sanitize null/garbage input yields empty plan", () => {
  assert.deepEqual(sanitizeExcelActions(null), { actions: [], rejected: [] });
  assert.deepEqual(sanitizeExcelActions("chart please"), { actions: [], rejected: [] });
});

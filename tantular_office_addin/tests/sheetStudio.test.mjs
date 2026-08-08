import test from "node:test";
import assert from "node:assert/strict";
import {
  fallbackWorkbookSpec,
  normalizeWorkbookSpec
} from "../src/workbook/workbookPlanner.js";
import { buildWorkbookXlsxBase64 } from "../src/workbook/xlsxBuilder.js";

test("normalizes sheets and pads short rows", () => {
  const spec = normalizeWorkbookSpec({
    title: "Project Tracker",
    sheets: [{
      name: "Tasks",
      columns: ["Task", "Owner", "Status"],
      rows: [["Setup", "A"], ["Test", "B", "Done", "ignored"]]
    }]
  }, "source", 2);
  assert.equal(spec.sheets.length, 1);
  assert.deepEqual(spec.sheets[0].rows[0], ["Setup", "A", ""]);
  assert.deepEqual(spec.sheets[0].rows[1], ["Test", "B", "Done"]);
});

test("deduplicates and sanitizes Excel sheet names", () => {
  const spec = normalizeWorkbookSpec({
    title: "Workbook",
    sheets: [
      { name: "Risk/Register", columns: ["A"], rows: [] },
      { name: "Risk:Register", columns: ["A"], rows: [] }
    ]
  }, "source", 3);
  assert.equal(spec.sheets[0].name, "Risk Register");
  assert.equal(spec.sheets[1].name, "Risk Register 2");
});

test("fallback creates a safe five-column data sheet", () => {
  const spec = fallbackWorkbookSpec("Item pertama\nItem kedua", "Tracker");
  assert.deepEqual(spec.sheets[0].columns, ["No", "Item", "Detail", "Status", "Catatan"]);
  assert.equal(spec.sheets[0].rows.length, 2);
});

test("builds an XLSX OOXML zip as base64", () => {
  const spec = {
    title: "Workbook Uji",
    sheets: [{
      name: "Data",
      description: "",
      columns: ["No", "Item", "Nilai"],
      rows: [["1", "Alpha & Beta", "10.5"]],
      notes: ["Isi data aktual."]
    }]
  };
  const bytes = Buffer.from(buildWorkbookXlsxBase64(spec), "base64");
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
  assert.ok(bytes.length > 2500);
});

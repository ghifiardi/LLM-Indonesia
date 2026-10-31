import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composePlanAnswer, interpretPlan, repairChartActions, stripChangeClaims } from "../src/chat/excelPlan.js";

// Column map as getExcelChatContext() builds it for the maturity sheet:
// dates in A, Target Overall in AA, Actual Overall in BF, rows 4–62.
const column = (letter, header, firstRow, lastRow, extra = {}) => ({
  column: letter, header, numeric: firstRow ? lastRow - firstRow + 1 : 0, firstRow, lastRow,
  first: 1, last: 2, date: false, ...extra
});
function ctxWith(overrides = {}, mapOverrides = {}) {
  return {
    activeSheet: "Plot Data",
    columnMap: {
      headerRows: [2, 3],
      columns: [
        column("A", "Tanggal", 4, 62, { date: true }),
        column("B", "Target Maturity › G", 4, 62),
        column("AA", "Target Maturity › Overall", 4, 62),
        column("BF", "Actual Maturity › Overall", 4, 62),
        column("BG", "Catatan", null, null)
      ],
      columnsTruncated: false,
      rowsTruncated: false,
      rowsRead: 62,
      ...mapOverrides
    },
    ...overrides
  };
}

const INTERNAL = /add_chart|add_series_chart|dataAddress|categories|"series"/;
const FALSE_CLAIM = "Chart Line target vs aktual sudah dibuat dari kolom A, AA, dan BF.";

// --- The exact screenshot failure -------------------------------------------

test("A:A,AA:AA,BF:BF add_chart becomes a bounded add_series_chart from the live column map", () => {
  const out = interpretPlan({
    reply: FALSE_CLAIM,
    actions: [{ op: "add_chart", type: "Line", dataAddress: "A:A,AA:AA,BF:BF", title: "Target vs Aktual Maturity" }]
  }, ctxWith());
  assert.equal(out.kind, "act");
  assert.deepEqual(out.rejected, []);
  assert.equal(out.actions.length, 1);
  const [chart] = out.actions;
  assert.equal(chart.op, "add_series_chart");
  assert.equal(chart.type, "Line");
  assert.equal(chart.title, "Target vs Aktual Maturity");
  assert.equal(chart.categories, "A4:A62");
  assert.deepEqual(chart.series, [
    { name: "Target Maturity › Overall", values: "AA4:AA62" },
    { name: "Actual Maturity › Overall", values: "BF4:BF62" }
  ]);
});

test("the model's false success claim is never shown, and the repair is stated, not silent", () => {
  const out = interpretPlan({
    reply: FALSE_CLAIM,
    actions: [{ op: "add_chart", type: "Line", dataAddress: "A:A,AA:AA,BF:BF" }]
  }, ctxWith());
  assert.doesNotMatch(out.text, /sudah dibuat/);
  assert.doesNotMatch(out.text, INTERNAL);
  assert.match(out.text, /belum diubah/);
  assert.match(out.text, /A4:A62/);
  assert.match(out.text, /AA4:AA62/);
  assert.match(out.text, /BF4:BF62/);
});

test("without a column map the same plan asks instead of guessing, with no false claim", () => {
  const out = interpretPlan({
    reply: FALSE_CLAIM,
    actions: [{ op: "add_chart", type: "Line", dataAddress: "A:A,AA:AA,BF:BF" }]
  }, ctxWith({ columnMap: null }));
  assert.equal(out.kind, "clarify");
  assert.equal("actions" in out, false);
  assert.doesNotMatch(out.text, /sudah dibuat/);
  assert.doesNotMatch(out.text, INTERNAL);
  assert.match(out.text, /belum diubah/);
  assert.match(out.question, /baris/);
});

// --- Misaligned and ambiguous ranges ask a follow-up ------------------------

test("columns whose numeric rows differ are misaligned: ask, and offer the shared rows", () => {
  const ctx = ctxWith();
  ctx.columnMap.columns[2] = column("AA", "Target Maturity › Overall", 4, 60);
  const out = interpretPlan({ reply: "", actions: [{ op: "add_chart", dataAddress: "A:A,AA:AA,BF:BF" }] }, ctx);
  assert.equal(out.kind, "clarify");
  assert.match(out.question, /AA[^.]*4–60/);
  assert.match(out.question, /tidak sama/);
  assert.ok(out.options.includes("Pakai baris 4–60"), JSON.stringify(out.options));
  assert.doesNotMatch(out.text, INTERNAL);
});

test("bounded but misaligned ranges ask instead of surfacing the validator error", () => {
  const out = interpretPlan({ reply: "", actions: [{ op: "add_chart", dataAddress: "A4:A62,AA5:AA62,BF4:BF62" }] }, ctxWith());
  assert.equal(out.kind, "clarify");
  assert.match(out.question, /tidak sama/);
  assert.ok(out.options.includes("Pakai baris 5–62"));
  assert.doesNotMatch(out.text, INTERNAL);
});

test("bounded aligned ranges convert directly, even on another sheet", () => {
  const out = interpretPlan({
    reply: "",
    actions: [{ op: "add_chart", type: "ColumnClustered", dataAddress: "'Data Lain'!A4:A10,'Data Lain'!AA4:AA10" }]
  }, ctxWith());
  assert.equal(out.kind, "act");
  assert.equal(out.actions[0].sheet, "Data Lain");
  assert.equal(out.actions[0].type, "ColumnClustered");
  assert.deepEqual(out.actions[0].series, [{ name: "Kolom AA", values: "AA4:AA10" }]);
});

test("ambiguous plans ask a follow-up: unknown, non-numeric, truncated, other-sheet, multi-column", () => {
  const cases = [
    ["column absent from the map", ctxWith(), "A:A,ZZ:ZZ"],
    ["column with no numbers", ctxWith(), "A:A,BG:BG"],
    ["map read only the first rows", ctxWith({}, { rowsTruncated: true, rowsRead: 300 }), "A:A,AA:AA"],
    ["whole columns on a sheet without a map", ctxWith(), "Lain!A:A,Lain!AA:AA"],
    ["a multi-column part", ctxWith(), "A4:B62,AA4:AA62"],
    ["unreadable part", ctxWith(), "A:A,Target"],
    ["one column only", ctxWith(), "A:A,"],
    ["too many series", ctxWith(), Array.from({ length: 8 }, () => "AA:AA").concat("A:A").reverse().join(",")]
  ];
  for (const [label, ctx, dataAddress] of cases) {
    const out = interpretPlan({ reply: FALSE_CLAIM, actions: [{ op: "add_chart", dataAddress }] }, ctx);
    assert.equal(out.kind, "clarify", label);
    assert.ok(out.question.length > 10, label);
    assert.doesNotMatch(out.text, INTERNAL, label);
    assert.doesNotMatch(out.text, /sudah dibuat/, label);
  }
});

test("a clarifying repair drops every other action in the plan", () => {
  const out = interpretPlan({
    reply: "",
    actions: [
      { op: "write_cells", address: "A1", values: [["x"]] },
      { op: "add_chart", dataAddress: "A:A,ZZ:ZZ" }
    ]
  }, ctxWith());
  assert.equal(out.kind, "clarify");
  assert.equal("actions" in out, false);
});

test("whole-column add_series_chart is repaired the same way", () => {
  const out = interpretPlan({
    reply: "",
    actions: [{ op: "add_series_chart", categories: "A:A", series: [{ name: "Target", values: "AA:AA" }, { name: "Aktual", values: "BF:BF" }] }]
  }, ctxWith());
  assert.equal(out.kind, "act");
  assert.deepEqual(out.actions[0].series, [{ name: "Target", values: "AA4:AA62" }, { name: "Aktual", values: "BF4:BF62" }]);
});

test("a Pie request over separate ranges becomes Line, and says so", () => {
  const out = interpretPlan({ reply: "", actions: [{ op: "add_chart", type: "Pie", dataAddress: "A:A,AA:AA" }] }, ctxWith());
  assert.equal(out.actions[0].type, "Line");
  assert.match(out.text, /Pie/);
});

test("valid plans are left alone", () => {
  const raw = [
    { op: "add_chart", type: "Line", dataAddress: "A1:C10" },
    { op: "add_series_chart", categories: "A4:A62", series: [{ name: "T", values: "AA4:AA62" }] },
    { op: "write_cells", address: "B2", values: [["x"]] }
  ];
  const repaired = repairChartActions(raw, ctxWith());
  assert.deepEqual(repaired, { actions: raw, notes: [], clarify: null });
});

// --- No success claim before Excel confirms --------------------------------

test("stripChangeClaims removes completion claims and keeps everything else", () => {
  const claims = [
    "Chart sudah dibuat.",
    "Saya telah menambahkan chart Line di samping data.",
    "Chart berhasil ditambahkan ke sheet Plot Data.",
    "✅ Chart Line dibuat dari A4:A62.",
    "Chart Line dibuat di sheet Plot Data.",
    "Formula sudah dipasang di C2.",
    "Sheet Ringkasan telah selesai.",
    "I have created the chart.",
    "The chart was successfully added.",
    "Chart sudah dibuat, klik untuk melihatnya."
  ];
  for (const claim of claims) assert.equal(stripChangeClaims(claim).text, "", claim);
  const keep = [
    "Chart akan dibuat setelah Anda klik \"Buat chart\".",
    "Data tanggal sudah lengkap di baris 4–62.",
    "Kolom AA berisi Target Maturity Overall.",
    "Chart tidak dibuat karena kolomnya kosong.",
    "Workbook belum diubah."
  ];
  for (const sentence of keep) assert.equal(stripChangeClaims(sentence).text, sentence, sentence);
  const mixed = stripChangeClaims("Kolom AA berisi target. Chart sudah dibuat! Periksa pratinjau.");
  assert.equal(mixed.text, "Kolom AA berisi target. Periksa pratinjau.");
  assert.equal(mixed.removed, 1);
});

test("a rejected action says plainly that no change was made, without internal errors", () => {
  const text = composePlanAnswer({ reply: FALSE_CLAIM, changesPending: false, rejectedCount: 1, notes: [] });
  assert.doesNotMatch(text, /sudah dibuat/);
  assert.match(text, /tidak dijalankan/);
  assert.match(text, /Tidak ada perubahan yang dibuat di workbook/);
  assert.doesNotMatch(text, INTERNAL);
});

test("rejected write actions are reported generically, the valid rest still go to review", () => {
  const out = interpretPlan({
    reply: "Saya sudah menulis nilai di B2.",
    actions: [
      { op: "write_cells", address: "not-an-address", values: [["x"]] },
      { op: "write_cells", address: "B2", values: [["y"]] }
    ]
  }, ctxWith());
  assert.equal(out.kind, "act");
  assert.equal(out.actions.length, 1);
  assert.equal(out.rejected.length, 1, "details are kept for the console, not the chat");
  assert.doesNotMatch(out.text, /sudah menulis/);
  assert.doesNotMatch(out.text, /write_cells|not-an-address/);
  assert.match(out.text, /1 aksi[^.]*tidak dijalankan/);
});

test("a question from the model has its reply guarded too", () => {
  const out = interpretPlan({ reply: FALSE_CLAIM, clarify: { question: "Ukuran mana?", options: ["Overall"] } }, ctxWith());
  assert.equal(out.kind, "clarify");
  assert.doesNotMatch(out.text, /sudah dibuat/);
  assert.match(out.text, /Ukuran mana\?/);
});

// --- Wiring -----------------------------------------------------------------

test("Excel chat displays, speaks and remembers only the guarded text", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chat = fs.readFileSync(path.join(root, "src/chat/excelChat.js"), "utf8");
  assert.match(chat, /interpretPlan\(parsed, ctx\)/);
  // The raw model reply never reaches the bubble, the voice output or history.
  assert.equal(chat.split("parsed.reply").length - 1, 1, "parsed.reply is only checked for type");
  assert.match(chat, /typeof parsed\.reply !== "string"/);
  assert.doesNotMatch(chat, /history\.add\("assistant", parsed\.reply\)/);
  assert.doesNotMatch(chat, /rejected\.map\(\(r\) => `⚠️ \$\{r\}`\)/);
  assert.match(chat, /spoken = answer\.textContent/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseEditContract, locateEdit, resolveEdits, searchOrdinalAt } from "../src/chat/editContract.js";

const DOC = "Laporan tahunan.\nPendapatan naik 10 persen.\nPendapatan naik 10 persen di Q4.\nPenutup.";

test("parses contract from fenced JSON", () => {
  const raw = 'Berikut:\n```json\n{"edits":[{"find":"naik","replace":"meningkat","alasan":"formal"}]}\n```';
  const { edits } = parseEditContract(raw);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].occurrence, 1);
});

test("rejects malformed contracts", () => {
  assert.throws(() => parseEditContract("bukan json"));
  assert.throws(() => parseEditContract('{"edits":[]}'));
  assert.throws(() => parseEditContract(JSON.stringify({ edits: Array.from({ length: 21 }, () => ({ find: "a", replace: "b" })) })));
  assert.throws(() => parseEditContract(JSON.stringify({ edits: [{ find: "x".repeat(201), replace: "y" }] })));
});

// REGRESSION: one malformed item in an otherwise-good batch used to discard
// the whole batch — a weaker/faster local model asked for many edits at once
// is more likely to slip on exactly one item, and for a slow local model a
// forced full retry can mean burning another timeout instead of just using
// what parsed correctly.
test("keeps valid edits and reports skipped ones instead of throwing on one bad item", () => {
  const raw = JSON.stringify({
    edits: [
      { find: "naik", replace: "meningkat" },
      { find: "" /* missing find */, replace: "y" },
      { find: "x".repeat(201) /* too long */, replace: "y" },
      { find: "Penutup.", replace: "Selesai." }
    ]
  });
  const { edits, skipped } = parseEditContract(raw);
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.map((e) => e.find), ["naik", "Penutup."]);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].index, 2);
  assert.match(skipped[0].reason, /find/);
  assert.equal(skipped[1].index, 3);
  assert.match(skipped[1].reason, /panjang/);
});

test("all-invalid edits still throws, naming why each one failed", () => {
  assert.throws(
    () => parseEditContract(JSON.stringify({ edits: [{ find: "", replace: "a" }, { find: "x".repeat(201), replace: "b" }] })),
    /Semua 2 edit tidak valid/
  );
});

test("unique find resolves", () => {
  const r = locateEdit(DOC, { find: "Laporan tahunan.", replace: "", occurrence: 1 });
  assert.equal(r.index, 0);
  assert.equal(r.length, "Laporan tahunan.".length);
});

test("repeated find without disambiguation is ambiguous", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", occurrence: 1 });
  assert.equal(r.error, "ambiguous");
});

test("after-context disambiguates repeated find", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", after: " di Q4", occurrence: 1 });
  assert.equal(DOC.slice(r.index, r.index + r.length), "Pendapatan naik 10 persen");
  assert.ok(DOC.slice(r.index).includes("di Q4"));
});

test("occurrence disambiguates repeated find", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", occurrence: 2 });
  assert.ok(r.index > DOC.indexOf("Pendapatan"));
});

test("whitespace-normalized retry", () => {
  const r = locateEdit("kata  ganda di sini", { find: "kata ganda", replace: "", occurrence: 1 });
  assert.equal(r.index, 0);
});

test("missing anchor reports not_found", () => {
  assert.equal(locateEdit(DOC, { find: "tidak ada", replace: "", occurrence: 1 }).error, "not_found");
});

test("empty find returns not_found promptly", () => {
  const r = locateEdit("abc", { find: "", replace: "x", occurrence: 1 });
  assert.equal(r.error, "not_found");
});

test("provided but failing anchor on repeated find is ambiguous, not positional", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", before: "xxx tidak ada", occurrence: 2 });
  assert.equal(r.error, "ambiguous");
});

test("unique find with wrong anchor still resolves (pool of one is unambiguous)", () => {
  const r = locateEdit(DOC, { find: "Laporan tahunan.", replace: "", before: "salah total" });
  assert.equal(r.index, 0);
  assert.equal(r.length, "Laporan tahunan.".length);
});

test("searchOrdinalAt finds ordinal among non-overlapping occurrences", () => {
  assert.equal(searchOrdinalAt("a b a b a", "a", 4), 1);
});

test("searchOrdinalAt treats occurrences as non-overlapping", () => {
  assert.equal(searchOrdinalAt("aaaa", "aa", 2), 1);
  assert.equal(searchOrdinalAt("aaaa", "aa", 1), -1);
});

test("searchOrdinalAt returns -1 for absent or empty find", () => {
  assert.equal(searchOrdinalAt("abc", "zz", 0), -1);
  assert.equal(searchOrdinalAt("abc", "", 0), -1);
});

test("searchOrdinalAt with the matched (whitespace-normalized) text finds its own ordinal", () => {
  // Defect 2 regression: locateEdit's whitespace-normalized retry can
  // resolve a match whose literal text differs from edit.find (e.g. find
  // "Halo dunia" against doc "Halo   dunia"). wordEdits.js must re-derive
  // the actually-matched text and use IT for both the ordinal lookup and
  // the Word search — using edit.find here would return -1 and skip.
  assert.equal(searchOrdinalAt("Halo   dunia", "Halo   dunia", 0), 0);
});

test("resolveEdits keeps per-edit status", () => {
  const out = resolveEdits(DOC, [
    { find: "Penutup.", replace: "Selesai.", occurrence: 1 },
    { find: "hilang", replace: "x", occurrence: 1 }
  ]);
  assert.equal(out[0].index >= 0, true);
  assert.equal(out[1].error, "not_found");
});

import test from "node:test";
import assert from "node:assert/strict";
import { applyEditsToText } from "../src/chat/applyEdits.js";

test("single edit applies", () => {
  const r = applyEditsToText("Pendapatan naik.", [{ find: "naik", replace: "meningkat", occurrence: 1 }]);
  assert.equal(r.text, "Pendapatan meningkat.");
  assert.deepEqual(r.perEditStatus, ["applied"]);
});
test("whitespace-normalized anchor applies against matched text", () => {
  const r = applyEditsToText("Halo   dunia", [{ find: "Halo dunia", replace: "Hai", occurrence: 1 }]);
  assert.equal(r.text, "Hai");
  assert.deepEqual(r.perEditStatus, ["applied"]);
});
test("sequential edits on repeated token land on distinct occurrences", () => {
  const doc = "kucing dan kucing";
  const r = applyEditsToText(doc, [
    { find: "kucing", replace: "anjing", before: "", after: " dan", occurrence: 1 },
    { find: "kucing", replace: "burung", before: "dan ", after: "", occurrence: 1 }
  ]);
  assert.equal(r.text, "anjing dan burung");
});
test("missing anchor → not_found, text unchanged", () => {
  const r = applyEditsToText("abc", [{ find: "zzz", replace: "x", occurrence: 1 }]);
  assert.equal(r.text, "abc");
  assert.deepEqual(r.perEditStatus, ["not_found"]);
});
test("ambiguous anchor → skipped", () => {
  const r = applyEditsToText("aa aa aa", [{ find: "aa", replace: "b", occurrence: 1 }]);
  assert.deepEqual(r.perEditStatus, ["skipped"]);
  assert.equal(r.text, "aa aa aa");
});

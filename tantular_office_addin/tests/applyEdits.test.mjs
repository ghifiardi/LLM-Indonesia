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
// Discriminates progressive re-anchoring from a buggy "always resolve against
// original text" implementation. Edit 2 is occurrence-based (no before/after)
// and targets "kucing", a token that DOES NOT EXIST anywhere in the original
// document — it is only introduced by edit 1's replacement text. So:
//   - Progressive (correct): edit 2 is located against the POST-edit-1 text,
//     where "kucing" now occurs exactly once → resolves and applies, giving
//     "Anjing dan burung berlari di taman." with both edits "applied".
//   - Non-progressive (buggy, locates every edit against the ORIGINAL text):
//     edit 2 searches for "kucing" in "Anjing berlari di taman." and finds
//     zero occurrences → status "not_found", and the final text keeps the
//     literal "kucing" edit 1 inserted instead of "burung".
// Verified directly: calling locateEdit(originalDoc, edit2) returns
// {error:"not_found"}, while applyEditsToText (which threads `text`
// progressively) applies both edits successfully. The two implementations
// therefore produce different perEditStatus and different final text,
// so this test fails under a non-progressive implementation.
test("occurrence-based edit only resolves because edit 1 already created the target token", () => {
  const doc = "Anjing berlari di taman.";
  const r = applyEditsToText(doc, [
    { find: "Anjing", replace: "Anjing dan kucing", occurrence: 1 },
    { find: "kucing", replace: "burung", occurrence: 1 }
  ]);
  assert.equal(r.text, "Anjing dan burung berlari di taman.");
  assert.deepEqual(r.perEditStatus, ["applied", "applied"]);
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

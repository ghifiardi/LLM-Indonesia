// Elaborate the attachment into the document (2026-09-05): section by
// section, grounded on each section's own text, bounded and cancellable.
import test from "node:test";
import assert from "node:assert/strict";
import {
  splitAttachmentSections, planElaboration, wantsElaboration, elaborateSections, ELABORATION_SYSTEM
} from "../src/chat/attachmentElaborate.js";

const BOOK = [
  "[Page 1]\nStatistics for Business & Economics\n14e Metric Version",
  "[Page 3]\nChapter 1 Data and Statistics\n\nStatistics is the art and science of collecting, analyzing, presenting, and interpreting data. Applications include accounting, finance, and marketing.",
  "[Page 9]\nChapter 2 Descriptive Statistics\n\nA frequency distribution is a tabular summary of data showing the number of observations in each of several nonoverlapping categories.\n\nA histogram is a graphical presentation of a frequency distribution.",
  "[Page 20]\nChapter 3 Regression Analysis\n\nRegression analysis studies the relationship between a dependent variable and one or more independent variables."
].join("\n\n");

test("splitAttachmentSections splits on heading-like lines and keeps page numbers", () => {
  const sections = splitAttachmentSections(BOOK);
  assert.deepEqual(sections.map((s) => s.heading), ["Statistics for Business & Economics", "Chapter 1 Data and Statistics", "Chapter 2 Descriptive Statistics", "Chapter 3 Regression Analysis"]);
  assert.deepEqual(sections.map((s) => s.page), [1, 3, 9, 20]);
  assert.match(sections[2].text, /histogram/);
});

test("wantsElaboration recognises a request to write the attachment into the document", () => {
  for (const m of ["elaborasi seluruh isi lampiran ke dokumen", "uraikan buku ini ke dalam dokumen", "tuliskan bab regresi dari PDF ke dokumen", "expand the attached book into the document"]) {
    assert.equal(wantsElaboration(m), true, m);
  }
  assert.equal(wantsElaboration("berapa halaman buku ini?"), false);
  assert.equal(wantsElaboration("ringkas paragraf ini"), false);
});

test("planElaboration: 'seluruh' takes every section up to the cap; otherwise the sections matching the request", () => {
  const sections = splitAttachmentSections(BOOK);
  const all = planElaboration(sections, "elaborasi seluruh isi buku ke dokumen", { cap: 3 });
  assert.equal(all.scope, "all");
  assert.equal(all.sections.length, 3);
  assert.equal(all.truncated, 1, "one section beyond the cap is reported, never silently dropped");
  const some = planElaboration(sections, "uraikan bab tentang regresi ke dokumen");
  assert.equal(some.scope, "matched");
  assert.deepEqual(some.sections.map((s) => s.heading), ["Chapter 3 Regression Analysis"]);
  const none = planElaboration(sections, "uraikan bab tentang zzz ke dokumen");
  assert.equal(none.scope, "none");
});

test("elaborateSections calls the model once per section with that section's text only, assembles headings, stops on abort", async () => {
  const sections = splitAttachmentSections(BOOK).slice(1, 3);
  const seen = [];
  const progress = [];
  const result = await elaborateSections({
    sections, instruction: "uraikan",
    run: async ({ user }) => { seen.push(user); return `Uraian untuk ${user.match(/Judul bagian: (.*)/)[1]}.`; },
    onProgress: (t) => progress.push(t)
  });
  assert.equal(seen.length, 2);
  assert.ok(!seen[0].includes("histogram") && seen[1].includes("histogram"), "each call sees its own section only");
  assert.match(result.text, /^## Chapter 1 Data and Statistics \(hal\. 3\)\n\nUraian untuk Chapter 1/);
  assert.match(result.text, /## Chapter 2 Descriptive Statistics \(hal\. 9\)/);
  assert.equal(result.done, 2);
  assert.ok(progress.some((p) => /1\/2/.test(p)));
  const controller = new AbortController();
  const aborted = await elaborateSections({
    sections, instruction: "uraikan", signal: controller.signal,
    run: async () => { controller.abort(); return "x"; }
  });
  assert.equal(aborted.done, 1, "stops after the section in flight");
  assert.equal(aborted.aborted, true);
  assert.match(ELABORATION_SYSTEM, /jangan menambah fakta|hanya dari teks bagian/i);
});

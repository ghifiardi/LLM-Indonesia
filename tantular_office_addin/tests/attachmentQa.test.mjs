// Chat over the attached file (2026-09-05). A book PDF attached in the
// source card was invisible to the chat, which only saw the Word body, and
// "how many pages" is metadata no excerpt can answer. Counts are computed
// from the extraction; everything else is question-driven retrieval over
// the attachment's own text. Pure.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAttachment, answerAttachmentStats, retrieveFromAttachment, mentionsAttachment, attachmentLabel
} from "../src/chat/attachmentQa.js";

const PDF_TEXT = [
  "[Page 1]\nStatistics for Business & Economics\n14e Metric Version",
  "[Page 2]\nCopyright 2020 Cengage Learning, Inc.\n\nAll rights reserved.",
  "[Page 3]\nChapter 1 Data and Statistics\n\nStatistics is the art and science of collecting, analyzing, presenting, and interpreting data.\n\nApplications in business and economics include accounting, finance, marketing, production, and economics.",
  "[Page 4]\nChapter 2 Descriptive Statistics\n\nA frequency distribution is a tabular summary of data showing the number of observations in each of several nonoverlapping categories."
].join("\n\n");

test("describeAttachment counts pages from the extractor's page markers, plus words, paragraphs and sections", () => {
  const stats = describeAttachment({ filename: "Book.pdf", kind: "pdf", text: PDF_TEXT, chars: PDF_TEXT.length });
  assert.equal(stats.pages, 4);
  assert.equal(stats.paragraphs, 8);
  assert.ok(stats.words > 50 && stats.words < 90, `words ${stats.words}`);
  assert.equal(stats.chars, PDF_TEXT.length);
  assert.equal(stats.filename, "Book.pdf");
  const txt = describeAttachment({ filename: "notes.txt", kind: "text", text: "Satu.\n\nDua.\n\nTiga." });
  assert.equal(txt.pages, null, "no page markers ⇒ page count unknown, never guessed");
  assert.equal(txt.paragraphs, 3);
});

test("answerAttachmentStats answers count questions deterministically, in the question's language, and admits unknowns", () => {
  const stats = describeAttachment({ filename: "Book.pdf", kind: "pdf", text: PDF_TEXT, chars: PDF_TEXT.length });
  const en = answerAttachmentStats("How many pages does the book have and how many paragraphs does it have?", stats);
  assert.match(en, /4 pages/);
  assert.match(en, /8 paragraphs/);
  assert.match(en, /Book\.pdf/);
  const id = answerAttachmentStats("berapa jumlah halaman dan kata di dokumen ini?", stats);
  assert.match(id, /4 halaman/);
  assert.match(id, /\d+ kata/);
  const unknown = answerAttachmentStats("berapa halaman?", describeAttachment({ filename: "n.txt", kind: "text", text: "a\n\nb" }));
  assert.match(unknown, /tidak tersedia|tidak diketahui/);
  assert.equal(answerAttachmentStats("apa isi bab 2?", stats), null, "not a stats question");
});

test("retrieveFromAttachment returns the relevant excerpt with its page, and falls back to the opening when nothing matches", () => {
  const hit = retrieveFromAttachment(PDF_TEXT, "what is a frequency distribution?");
  assert.match(hit.text, /frequency distribution/);
  assert.match(hit.text, /\[Page 4\]|Halaman 4/);
  assert.equal(hit.mode, "retrieved");
  const miss = retrieveFromAttachment(PDF_TEXT, "zzz qqq");
  assert.equal(miss.mode, "opening");
  assert.match(miss.text, /Statistics for Business/);
  assert.ok(miss.text.length <= 6000);
});

test("mentionsAttachment recognises references to the uploaded file", () => {
  for (const m of ["apa isi buku yang saya lampirkan?", "dari dokumen yang diunggah", "in the attached PDF", "menurut file tersebut", "the book says"]) {
    assert.equal(mentionsAttachment(m), true, m);
  }
  assert.equal(mentionsAttachment("perbaiki bahasa paragraf ini"), false);
  assert.equal(attachmentLabel("Book Statistics for Business and Economics_ Metric Version.pdf"), "Lampiran: Book Statistics for Business and Economics_ Metric Version.pdf");
});

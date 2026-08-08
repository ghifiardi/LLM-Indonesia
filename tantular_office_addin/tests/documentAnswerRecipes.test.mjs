import test from "node:test";
import assert from "node:assert/strict";
import {
  closedVsOpenWeightElaboration,
  closedVsOpenWeightEdit,
  isClosedVsOpenWeightTopic
} from "../src/chat/documentAnswerRecipes.js";
import {
  deriveInsertionAnchor,
  runTanyaDokumen
} from "../src/chat/pipelines/tanyaDokumen.js";

const CONTEXT = [
  "Closed Model vs. Open-Weight: Memahami Perbedaan",
  "Closed model dan open-weight adalah dua pendekatan berbeda dalam pengembangan AI.",
  "Kedua pendekatan memiliki manfaat dan risiko."
].join("\n");

test("detects the closed vs open-weight workshop topic", () => {
  assert.equal(isClosedVsOpenWeightTopic("Jelaskan closed model vs open-weight", CONTEXT), true);
});

test("an unrelated question does not trigger the canned recipe by itself", () => {
  // The canned answer must be driven by the QUESTION. A document that merely
  // contains the topic (e.g. a previously inserted answer) must not hijack
  // unrelated follow-ups like a table request.
  assert.equal(
    isClosedVsOpenWeightTopic("apakah paragraph yang saya pilih bisa ditampilkan dalam bentuk tabel?"),
    false
  );
});

test("elaboration distinguishes open-weight from full open-source", () => {
  const text = closedVsOpenWeightElaboration();
  assert.match(text, /tidak otomatis berarti open-source penuh/i);
  assert.match(text, /tidak ada pendekatan yang otomatis lebih aman/i);
  assert.match(text, /portofolio/i);
});

test("builds a resolvable deterministic document edit", () => {
  const edit = closedVsOpenWeightEdit(CONTEXT);
  assert.ok(edit);
  assert.ok(CONTEXT.includes(edit.find));
  assert.ok(edit.replace.length > 1000);
  assert.match(edit.replace, /vendor lock-in/i);
});

test("uses the last body paragraph, not the subsection heading, as insertion anchor", () => {
  assert.equal(
    deriveInsertionAnchor(CONTEXT),
    "Kedua pendekatan memiliki manfaat dan risiko."
  );
});

test("uses a searchable final sentence for a long subsection paragraph", () => {
  const finalSentence = "Kalimat penutup ini menjadi jangkar untuk penyisipan.";
  const context = [
    "Judul Subbagian",
    `${"Penjelasan panjang tanpa risiko khusus ".repeat(12)}. ${finalSentence}`
  ].join("\n");
  const anchor = deriveInsertionAnchor(context);
  assert.equal(anchor, finalSentence);
  assert.ok(anchor.length <= 255);
});

test("anchors inside the excerpt matching the question, not the last excerpt", () => {
  // buildDocumentContext joins up to 4 retrieved excerpts with blank lines, in
  // document order. The trailing excerpt can come from the very end of the
  // document (e.g. Kesimpulan), so the anchor must follow the query instead.
  const multiExcerpt = [
    CONTEXT,
    [
      "Kesimpulan & Langkah Berikutnya",
      "Dokumen ini dirancang untuk memandu pembuatan presentasi dua puluh slide yang menarik dan informatif.",
      "Silakan tambahkan visual per slide sesuai dengan konteks dan kebutuhan presentasi."
    ].join("\n")
  ].join("\n\n");
  assert.equal(
    deriveInsertionAnchor(multiExcerpt, "Elaborasi closed model vs open-weight"),
    "Kedua pendekatan memiliki manfaat dan risiko."
  );
});

test("falls back to the last excerpt when the question matches nothing", () => {
  const multiExcerpt = [
    CONTEXT,
    [
      "Kesimpulan",
      "Silakan tambahkan visual per slide sesuai dengan konteks dan kebutuhan presentasi."
    ].join("\n")
  ].join("\n\n");
  assert.equal(
    deriveInsertionAnchor(multiExcerpt, ""),
    "Silakan tambahkan visual per slide sesuai dengan konteks dan kebutuhan presentasi."
  );
});

test("never anchors on a copy of its own previously inserted answer", async () => {
  // Simulate a document that already contains the canned answer appended at
  // the end (as plain text, the way insertStructuredTextIntoWord writes it).
  const insertedCopy = closedVsOpenWeightElaboration()
    .split("\n")
    .filter(Boolean)
    .map((line) => line
      .replace(/^#+\s*/, "")
      .replace(/^-\s*/, "• ")
      .replace(/\*\*/g, ""))
    .join("\n");
  const poisoned = [CONTEXT, insertedCopy].join("\n\n");
  const result = await runTanyaDokumen({
    instruction: "Elaborasi closed model vs open-weight",
    contextText: poisoned,
    history: { toMessages: () => [] },
    emit: () => {}
  });
  assert.equal(result.insertionAnchor, "Kedua pendekatan memiliki manfaat dan risiko.");
});

test("prefers the section containing the document's own definition sentence", async () => {
  // Original section is token-poor; a poisoned copy of the answer is token-rich.
  const originalSection = [
    "Perbandingan Pendekatan",
    "Closed model dan open-weight adalah dua pendekatan berbeda dalam pengembangan AI.",
    "Pilihan pendekatan bergantung pada kebutuhan organisasi."
  ].join("\n");
  const insertedCopy = closedVsOpenWeightElaboration().replace(/[#*]/g, "");
  const poisoned = [originalSection, insertedCopy].join("\n\n");
  const result = await runTanyaDokumen({
    instruction: "Elaborasi closed model vs open-weight",
    contextText: poisoned,
    history: { toMessages: () => [] },
    emit: () => {}
  });
  assert.equal(result.insertionAnchor, "Pilihan pendekatan bergantung pada kebutuhan organisasi.");
});

test("document answer includes an optional anchored edit", async () => {
  let emitted = "";
  const result = await runTanyaDokumen({
    instruction: "Elaborasi closed model vs open-weight",
    contextText: CONTEXT,
    history: { toMessages: () => [] },
    emit: (text) => { emitted += text; }
  });
  assert.equal(result.kind, "text");
  assert.equal(emitted, result.text);
  assert.equal(result.insertionAnchor, "Kedua pendekatan memiliki manfaat dan risiko.");
  assert.ok(result.suggestedEdit);
  assert.ok(CONTEXT.includes(result.suggestedEdit.find));
});

test("a table request naming the topic reaches the model, not the canned answer", async () => {
  const { wantsFormatTransform } = await import("../src/chat/pipelines/tanyaDokumen.js");
  assert.equal(wantsFormatTransform("buat tabel perbandingan closed model vs open-weight"), true);
  assert.equal(wantsFormatTransform("jadikan poin-poin dari bagian ini"), true);
  assert.equal(wantsFormatTransform("Elaborasi closed model vs open-weight"), false);
});

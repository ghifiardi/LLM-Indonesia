import test from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_TOKEN_BUDGET,
  MODEL_CONTEXT_TOKENS,
  RESERVED_OUTPUT_TOKENS,
  estimateTokens,
  numericDensity,
  chunkDocument,
  scoreChunk,
  selectSource,
  selectedSourceText,
  selectionInstruction,
  describeSelection,
} from "../src/deck/sourceSelection.js";

// A miniature bilingual financial report with the shape that broke Deck Studio:
// statement rows are not sentences, so a prose-oriented splitter drops them.
const BALANCE_SHEET = `[Page 3]
LAPORAN POSISI KEUANGAN KONSOLIDASIAN
(Dinyatakan dalam ribuan Dolar AS)
Kas dan setara kas 1.234.567 2.345.678
Piutang usaha 456.789 512.345
Jumlah aset lancar 2.691.356 3.058.023`;

const NARRATIVE = `[Page 1]
SAMBUTAN DIREKSI
Tahun ini perusahaan menghadapi banyak tantangan pasar. Kami tetap optimistis
terhadap prospek jangka panjang dan berkomitmen pada tata kelola yang baik.`;

const NOTES = `[Page 40]
CATATAN ATAS LAPORAN KEUANGAN KONSOLIDASIAN
Kebijakan akuntansi yang diterapkan konsisten dengan tahun sebelumnya.`;

// --- budget ------------------------------------------------------------------

test("source budget leaves room for output and prompt inside num_ctx", () => {
  // The whole point of the fix: the budget must be strictly smaller than the
  // context, or generation silently truncates again.
  assert.ok(SOURCE_TOKEN_BUDGET < MODEL_CONTEXT_TOKENS);
  assert.ok(SOURCE_TOKEN_BUDGET + RESERVED_OUTPUT_TOKENS <= MODEL_CONTEXT_TOKENS);
  assert.ok(SOURCE_TOKEN_BUDGET > 10_000, "budget must still be useful");
});

test("token estimate over-estimates rather than under-estimates", () => {
  // Overshooting the context is silent; undershooting only wastes a little.
  const text = "a".repeat(3500);
  assert.ok(estimateTokens(text) >= 1000);
});

// --- chunking ----------------------------------------------------------------

test("chunks split on page markers and carry the page number", () => {
  const chunks = chunkDocument(`${NARRATIVE}\n\n${BALANCE_SHEET}`);
  const pages = [...new Set(chunks.map((c) => c.page))];
  assert.deepEqual(pages, [1, 3]);
});

test("a statement heading becomes the chunk heading and stays in its text", () => {
  const chunks = chunkDocument(BALANCE_SHEET);
  const sheet = chunks.find((c) => /POSISI KEUANGAN/.test(c.heading || ""));
  assert.ok(sheet, "balance sheet heading must be detected");
  // The title carries period and currency basis — dropping it strands the rows.
  assert.match(sheet.text, /LAPORAN POSISI KEUANGAN KONSOLIDASIAN/);
  assert.match(sheet.text, /Kas dan setara kas/);
});

test("numeric rows survive chunking (the sentence-splitter bug)", () => {
  const chunks = chunkDocument(BALANCE_SHEET);
  const joined = chunks.map((c) => c.text).join("\n");
  for (const figure of ["1.234.567", "2.345.678", "2.691.356"]) {
    assert.ok(joined.includes(figure), `figure ${figure} must survive`);
  }
});

test("an oversized section is split without cutting a row in half", () => {
  const row = "Kas dan setara kas 1.234.567 2.345.678";
  const huge = `[Page 5]\nLAPORAN ARUS KAS\n${`${row}\n`.repeat(500)}`;
  const chunks = chunkDocument(huge);
  assert.ok(chunks.length > 1, "must split by size");
  for (const chunk of chunks) {
    for (const line of chunk.text.split("\n")) {
      if (line.includes("Kas dan setara")) {
        assert.equal(line.trim(), row, "a row must never be cut mid-line");
      }
    }
  }
});

test("size splitting never straddles two sections", () => {
  const chunks = chunkDocument(`${BALANCE_SHEET}\n\n${NARRATIVE}`);
  for (const chunk of chunks) {
    const hasSheet = /POSISI KEUANGAN/.test(chunk.text);
    const hasNarrative = /SAMBUTAN DIREKSI/.test(chunk.text);
    assert.ok(!(hasSheet && hasNarrative), "provenance would be untruthful");
  }
});

// --- scoring -----------------------------------------------------------------

test("numericDensity separates statement rows from prose", () => {
  assert.ok(numericDensity("Kas dan setara kas 1.234.567 2.345.678") > 0.3);
  assert.ok(numericDensity("Kami tetap optimistis terhadap prospek jangka panjang") < 0.05);
});

test("statements outrank narrative", () => {
  const [sheet] = chunkDocument(BALANCE_SHEET);
  const [prose] = chunkDocument(NARRATIVE);
  assert.ok(scoreChunk(sheet) > scoreChunk(prose));
});

test("notes are excluded by default and included on request", () => {
  const [notes] = chunkDocument(NOTES);
  const [sheet] = chunkDocument(BALANCE_SHEET);

  // The requirement is ranking, not sign: notes must lose to the statements,
  // which they would otherwise beat on sheer volume in any real report.
  assert.ok(scoreChunk(notes, { includeNotes: false }) < scoreChunk(sheet),
    "notes must rank below the statements they annotate");
  // A notes heading always says "konsolidasian", collecting the statement bonus
  // twice; the penalty has to outweigh that rather than merely cancel it.
  assert.ok(scoreChunk(notes, { includeNotes: false }) < 0);
  assert.ok(scoreChunk(notes, { includeNotes: true })
    > scoreChunk(notes, { includeNotes: false }));
});

// --- notes continuation ------------------------------------------------------

// The real shape: notes say so once, then run for hundreds of pages under
// numbered headings that never repeat the phrase.
const NOTES_RUN = `[Page 40]
CATATAN ATAS LAPORAN KEUANGAN KONSOLIDASIAN
Kebijakan akuntansi diterapkan secara konsisten.

[Page 41]
1. UMUM 1. GENERAL
Perusahaan didirikan berdasarkan Akta Notaris tertanggal 1 Desember 2004.

[Page 42]
1. UMUM (lanjutan) 1. GENERAL (continued)
Kantor pusat Perusahaan berlokasi di Jakarta Selatan.

[Page 43]
34. LIABILITAS IMBALAN KERJA
Liabilitas imbalan kerja dihitung oleh aktuaris independen.`;

test("a notes run carries past headings that never repeat the phrase", () => {
  const chunks = chunkDocument(NOTES_RUN);
  const numbered = chunks.filter((c) => /^\d/.test(c.heading || ""));
  assert.ok(numbered.length >= 3, "expected the numbered note headings");
  for (const chunk of numbered) {
    assert.equal(chunk.isNotes, true, `"${chunk.heading}" must be inside the notes run`);
  }
});

test("continuation pages are penalised, not just the first notes page", () => {
  const chunks = chunkDocument(NOTES_RUN);
  const umum = chunks.find((c) => /1\. UMUM \(lanjutan\)/.test(c.heading || ""));
  assert.ok(scoreChunk(umum, { includeNotes: false }) < 0,
    "matching only the literal phrase left every later page at full weight");
});

test("a note named after a balance-sheet component is still a note", () => {
  // "34. LIABILITAS" matches a component keyword. Treating that as a statement
  // would flip the rest of the notes back to full weight.
  const chunks = chunkDocument(NOTES_RUN);
  const liabilitas = chunks.find((c) => /LIABILITAS/.test(c.heading || ""));
  assert.equal(liabilitas.isNotes, true);
  assert.ok(scoreChunk(liabilitas, { includeNotes: false }) < 0);
});

test("a real statement title ends the notes run", () => {
  const doc = `${NOTES_RUN}\n\n[Page 60]\nLAPORAN POSISI KEUANGAN KONSOLIDASIAN\nKas dan setara kas 1.234.567 2.345.678`;
  const chunks = chunkDocument(doc);
  const sheet = chunks.find((c) => /POSISI KEUANGAN/.test(c.heading || ""));
  assert.equal(sheet.isNotes, false, "the statement must not inherit the notes penalty");
  assert.ok(scoreChunk(sheet) > 0);
});

test("a statement continued across pages does not become notes", () => {
  // "(lanjutan)" means "same section as before" — statements are continued too.
  const doc = `[Page 5]\nLAPORAN ARUS KAS KONSOLIDASIAN\nArus kas operasi 111.111 222.222\n\n`
    + `[Page 6]\nLAPORAN ARUS KAS KONSOLIDASIAN (lanjutan)\nArus kas investasi 333.333 444.444`;
  for (const chunk of chunkDocument(doc)) {
    assert.equal(chunk.isNotes, false, `"${chunk.heading}" is a statement, not a note`);
  }
});

test("notes lose the budget to statements across a whole report", () => {
  const doc = `[Page 3]\nLAPORAN POSISI KEUANGAN KONSOLIDASIAN\n`
    + `Kas dan setara kas 1.234.567 2.345.678\nJumlah aset lancar 2.691.356 3.058.023\n\n`
    + NOTES_RUN + "\n\n"
    + Array.from({ length: 20 }, (_, i) =>
        `[Page ${50 + i}]\n${i + 2}. CATATAN LAIN (lanjutan)\n${"Uraian kebijakan akuntansi yang panjang. ".repeat(20)}`
      ).join("\n\n");
  const selection = selectSource(doc, { budget: 400 });
  const kept = selection.selected.map((c) => c.text).join("\n");
  assert.match(kept, /Kas dan setara kas/, "the statement must survive the notes");
  assert.ok(selection.selected.every((c) => !c.isNotes),
    "notes must not take budget from statements");
});

// --- selection ---------------------------------------------------------------

test("under budget: everything is selected and reported as exhaustive", () => {
  const selection = selectSource(`${NARRATIVE}\n\n${BALANCE_SHEET}`);
  assert.equal(selection.truncated, false);
  assert.equal(selection.exhaustive, true);
  assert.equal(selection.dropped.length, 0);
  assert.equal(describeSelection(selection), null, "no warning when nothing dropped");
});

test("over budget: statements are kept, narrative is dropped", () => {
  const filler = `[Page 9]\nSAMBUTAN DIREKSI\n${"Kalimat basa-basi yang panjang. ".repeat(400)}`;
  const selection = selectSource(`${filler}\n\n${BALANCE_SHEET}`, { budget: 300 });
  assert.equal(selection.truncated, true);
  const kept = selection.selected.map((c) => c.text).join("\n");
  assert.match(kept, /POSISI KEUANGAN/, "the statement must win the budget");
  assert.ok(selection.tokensSelected <= selection.budget, "budget must be enforced");
});

test("selection never exceeds the budget", () => {
  const big = Array.from({ length: 60 }, (_, i) =>
    `[Page ${i + 1}]\nLAPORAN POSISI KEUANGAN KONSOLIDASIAN\n${"Kas 1.234.567 2.345.678\n".repeat(80)}`
  ).join("\n\n");
  const selection = selectSource(big, { budget: 5000 });
  assert.ok(selection.tokensSelected <= 5000);
  assert.ok(selection.truncated);
});

test("selected chunks are emitted in document order, not rank order", () => {
  const doc = `${BALANCE_SHEET}\n\n[Page 8]\nLAPORAN ARUS KAS\nArus kas operasi 111.111 222.222`;
  const selection = selectSource(doc);
  const indexes = selection.selected.map((c) => c.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
});

// --- provenance and honesty --------------------------------------------------

test("source text handed to the deck builder is plain, never annotated", () => {
  // Annotating this stream put "[Sumber: hal. 1 — ...]" on a slide headline:
  // a deterministic builder cannot distinguish a note about the text from the
  // text. Provenance travels in the prompt channel instead.
  const filler = `[Page 9]\nSAMBUTAN DIREKSI\n${"Kalimat panjang sekali. ".repeat(400)}`;
  const selection = selectSource(`${filler}\n\n${BALANCE_SHEET}`, { budget: 300 });
  const text = selectedSourceText(selection);
  assert.ok(!text.includes("[Sumber:"), "provenance must not reach slide content");
  assert.ok(!text.includes("PENTING"), "the coverage notice must not reach slide content");
  assert.match(text, /Kas dan setara kas 1\.234\.567/, "the figures must still be there");
});

test("truncated selection instructs the model that it is a selection", () => {
  const filler = `[Page 9]\nSAMBUTAN DIREKSI\n${"Kalimat panjang sekali. ".repeat(400)}`;
  const selection = selectSource(`${filler}\n\n${BALANCE_SHEET}`, { budget: 300 });
  const instruction = selectionInstruction(selection);
  assert.match(instruction, /DIPILIH, bukan seluruh dokumen/);
  assert.match(instruction, /Jangan menyatakan atau menyiratkan cakupan menyeluruh/);
  // Provenance so a slide can say which section it came from.
  assert.match(instruction, /hal\. 3 — LAPORAN POSISI KEUANGAN KONSOLIDASIAN/);
});

test("complete source yields no instruction, so the model is not falsely hedged", () => {
  assert.equal(selectionInstruction(selectSource(BALANCE_SHEET)), "");
});

test("notes exclusion is not reported as the document being too large", () => {
  // A report that fits but contains notes must not send anyone splitting a file
  // that was never too big.
  const doc = `[Page 3]\nLAPORAN POSISI KEUANGAN KONSOLIDASIAN\n`
    + `Kas dan setara kas 1.234.567 2.345.678\nJumlah aset lancar 2.691.356 3.058.023\n\n`
    + NOTES_RUN;
  const selection = selectSource(doc);
  assert.equal(selection.truncated, false, "nothing was dropped for size");
  assert.ok(selection.excluded.length > 0, "notes were excluded on purpose");
  const warning = describeSelection(selection, "laporan.pdf");
  assert.match(warning, /catatan atas laporan keuangan sengaja dilewati/);
  assert.ok(!/terlalu besar/.test(warning), "size was not the reason");
});

test("a document that is only notes still produces a deck", () => {
  const selection = selectSource(NOTES_RUN);
  assert.ok(selection.selected.length > 0,
    "excluding everything would leave the user with nothing");
});

test("the warning names what was dropped and refuses to imply full coverage", () => {
  const filler = `[Page 9]\nSAMBUTAN DIREKSI\n${"Kalimat panjang sekali. ".repeat(400)}`;
  const selection = selectSource(`${filler}\n\n${BALANCE_SHEET}`, { budget: 300 });
  const warning = describeSelection(selection, "laporan.pdf");
  assert.match(warning, /laporan\.pdf/);
  assert.match(warning, /terlalu besar/, "size was the reason here");
  assert.match(warning, /tidak muat/);
  assert.match(warning, /bukan seluruh dokumen/);
});

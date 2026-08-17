import test from "node:test";
import assert from "node:assert/strict";
import { buildDocumentDeckSpec } from "../src/deck/documentDeck.js";
import { selectSource, selectedSourceText } from "../src/deck/sourceSelection.js";

// Shaped like the report that exposed all of this: bilingual four-column
// statement pages, then a long notes run.
function statementPages(pages = [3, 4, 5]) {
  return pages.map((p) =>
    `[Page ${p}]\n31 DESEMBER 2025 DAN 2024 31 DECEMBER 2025 AND 2024\n`
    + `LAPORAN POSISI KEUANGAN KONSOLIDASIAN\n(Dinyatakan dalam ribuan Dolar AS)\n`
    + `Kas dan setara kas ${p}.234.567 ${p}.345.678 Cash and cash equivalents\n`
    + `Piutang usaha ${p}56.789 ${p}12.345 Trade receivables\n`
    + `Jumlah aset lancar ${p}.691.356 ${p}.058.023 Total current assets`
  ).join("\n\n");
}

const NOTES = `[Page 40]\nCATATAN ATAS LAPORAN KEUANGAN KONSOLIDASIAN\nKebijakan akuntansi konsisten.\n\n`
  + Array.from({ length: 12 }, (_, i) =>
      `[Page ${41 + i}]\n1. UMUM (lanjutan) 1. GENERAL (continued)\n`
      + `${"Uraian kebijakan akuntansi yang sangat panjang dan berulang. ".repeat(15)}`
    ).join("\n\n");

const bulletSlides = (spec) => spec.slides.filter((s) => s.type === "bullets");

test("statement figures reach the slides", () => {
  // The original failure: every number was dropped because rows are not
  // sentences, and the deck still looked like a successful run.
  const spec = buildDocumentDeckSpec(statementPages(), 8);
  const flat = JSON.stringify(spec);
  for (const figure of ["3.234.567", "356.789", "5.691.356"]) {
    assert.ok(flat.includes(figure), `figure ${figure} must appear on a slide`);
  }
});

test("a statement row never becomes a headline", () => {
  const doc = `[Page 7]\nhasil investasi lain-lain 91,003 18,478 from other investments\n`
    + `Kas dan setara kas 1.234.567 2.345.678 Cash and cash equivalents\n`
    + `Piutang usaha 456.789 512.345 Trade receivables\n`
    + `Jumlah aset lancar 2.691.356 3.058.023 Total current assets\n`
    + `${"Uraian tambahan yang cukup panjang untuk mengisi bagian ini. ".repeat(6)}`;
  const spec = buildDocumentDeckSpec(doc, 6);
  for (const slide of spec.slides) {
    assert.ok(!/91,003\s+18,478/.test(slide.headline || ""),
      `headline still contains a whole row: ${slide.headline}`);
  }
});

test("mirrored bilingual headings are not doubled on slides", () => {
  const spec = buildDocumentDeckSpec(statementPages(), 8);
  for (const slide of spec.slides) {
    assert.ok(!/DESEMBER.*DECEMBER/i.test(slide.headline || ""),
      `headline keeps both languages: ${slide.headline}`);
  }
});

test("no two slides share a headline and bullets", () => {
  // Section expansion emitted the same statement heading twice with identical
  // content (slides 28 and 29 in the reported deck).
  const spec = buildDocumentDeckSpec(statementPages([3, 3, 3]), 10);
  const seen = new Set();
  for (const slide of bulletSlides(spec)) {
    const key = `${slide.headline}|${(slide.bullets || []).join("|")}`;
    assert.ok(!seen.has(key), `duplicate slide: ${slide.headline}`);
    seen.add(key);
  }
});

test("takeaways carry figures and never repeat one line", () => {
  const spec = buildDocumentDeckSpec(statementPages(), 8);
  const closing = spec.slides.find((s) => s.type === "closing");
  const bullets = closing.bullets || [];
  assert.equal(new Set(bullets).size, bullets.length, "takeaways must not repeat");
  // Taking the first bullet blindly filled these with the currency-basis line,
  // which heads every statement section and says nothing on its own.
  assert.ok(bullets.some((b) => /\d/.test(b)), "at least one takeaway must carry figures");
});

test("bullets are single-line", () => {
  // Section bodies keep newlines so rows stay separable; a bullet must not.
  const spec = buildDocumentDeckSpec(statementPages(), 8);
  for (const slide of spec.slides) {
    for (const bullet of slide.bullets || []) {
      assert.ok(!bullet.includes("\n"), `bullet contains a newline: ${bullet.slice(0, 60)}`);
    }
  }
});

test("prose documents are unaffected by statement handling", () => {
  const prose = `PENDAHULUAN\n${"Perusahaan menghadapi tantangan pasar yang signifikan. ".repeat(10)}\n\n`
    + `METODOLOGI\n${"Pendekatan yang digunakan bersifat kualitatif dan kuantitatif. ".repeat(10)}\n\n`
    + `KESIMPULAN\n${"Hasil menunjukkan perbaikan yang konsisten sepanjang periode. ".repeat(10)}`;
  const spec = buildDocumentDeckSpec(prose, 6);
  const slides = bulletSlides(spec);
  assert.ok(slides.length >= 2);
  for (const slide of slides) {
    for (const bullet of slide.bullets) {
      // Prose bullets must still read as sentences, not as "label — value".
      assert.ok(!/ — \d/.test(bullet), `prose bullet formatted as a row: ${bullet}`);
    }
  }
});

test("end to end: notes are excluded and statements survive", () => {
  const selection = selectSource(`${statementPages()}\n\n${NOTES}`);
  const spec = buildDocumentDeckSpec(selectedSourceText(selection), 8);
  const flat = JSON.stringify(spec);
  assert.ok(flat.includes("3.234.567"), "statements must reach the deck");
  assert.ok(!flat.includes("UMUM"), "notes must not fill slides");
});

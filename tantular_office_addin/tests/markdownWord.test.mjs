import test from "node:test";
import assert from "node:assert/strict";
import { markdownToWordBlocks, markdownToWordHtml } from "../src/officeClient.js";

test("converts chat markdown into structured Word blocks", () => {
  assert.deepEqual(
    markdownToWordBlocks([
      "### **Judul Bagian**",
      "",
      "Paragraf dengan **penekanan**.",
      "- **Deployment:** Jalankan di lingkungan yang dipilih.",
      "1. Langkah pertama"
    ].join("\n")),
    [
      { type: "heading", level: 3, text: "Judul Bagian" },
      { type: "paragraph", text: "Paragraf dengan penekanan." },
      { type: "bullet", text: "Deployment: Jalankan di lingkungan yang dipilih." },
      { type: "number", text: "Langkah pertama" }
    ]
  );
});

test("converts markdown tables into bordered HTML tables", () => {
  const html = markdownToWordHtml([
    "### Perbandingan",
    "| Aspek | Closed | Open-Weight |",
    "| --- | --- | --- |",
    "| Akses | API penyedia | Bobot tersedia |",
    "| Kustomisasi | Terbatas | Fine-tuning |"
  ].join("\n"));
  assert.match(html, /<h3>Perbandingan<\/h3>/);
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /<th[^>]*>Aspek<\/th>/);
  assert.match(html, /<td[^>]*>API penyedia<\/td>/);
  assert.match(html, /<td[^>]*>Fine-tuning<\/td>/);
  assert.doesNotMatch(html, /---/);
});

test("escapes HTML and renders inline markdown in HTML output", () => {
  const html = markdownToWordHtml("Nilai 5 < 6 & **penting** `kode`\n- butir <b>satu</b>");
  assert.match(html, /<p>Nilai 5 &lt; 6 &amp; <strong>penting<\/strong> <code>kode<\/code><\/p>/);
  assert.match(html, /<ul><li>butir &lt;b&gt;satu&lt;\/b&gt;<\/li><\/ul>/);
});

test("renders numbered lists and paragraphs in HTML output", () => {
  const html = markdownToWordHtml("1. langkah satu\n2. langkah dua\n\nParagraf akhir.");
  assert.match(html, /<ol><li>langkah satu<\/li><li>langkah dua<\/li><\/ol>/);
  assert.match(html, /<p>Paragraf akhir\.<\/p>/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  fallbackDocumentSpec,
  normalizeDocumentSpec
} from "../src/document/documentPlanner.js";
import { buildDocumentDocxBase64 } from "../src/document/docxBuilder.js";

test("normalizes a model document spec", () => {
  const spec = normalizeDocumentSpec({
    title: "Laporan AI",
    executiveSummary: ["Poin satu", "Poin dua"],
    sections: [
      {
        heading: "Pendahuluan",
        paragraphs: ["Paragraf pembuka."],
        bullets: ["Tujuan utama"]
      }
    ],
    closing: ["Langkah berikutnya"]
  }, "Sumber", 6);
  assert.equal(spec.title, "Laporan AI");
  assert.equal(spec.sections.length, 1);
  assert.deepEqual(spec.sections[0].bullets, ["Tujuan utama"]);
});

test("fills a missing model section heading deterministically", () => {
  const spec = normalizeDocumentSpec({
    title: "Laporan",
    sections: [{ paragraphs: ["Isi bagian tanpa judul."] }]
  }, "Sumber", 4);
  assert.equal(spec.sections[0].heading, "Bagian 1");
});

test("drops invented author and date metadata", () => {
  const spec = normalizeDocumentSpec({
    title: "Laporan",
    author: "Nama Buatan",
    date: "2023-11-15",
    sections: [{ heading: "Isi", paragraphs: ["Teks."] }]
  }, "Buat laporan untuk direksi.", 4);
  assert.equal(spec.author, "");
  assert.equal(spec.date, "");
});

test("fallback document never copies a create instruction as the title", () => {
  const spec = fallbackDocumentSpec(
    "Buatlah laporan tentang sovereign AI Indonesia. Jelaskan opsi dan langkah berikutnya.",
    "Laporan profesional",
    4
  );
  assert.equal(/^buatlah/i.test(spec.title), false);
  assert.ok(spec.sections.length >= 1);
});

test("builds a DOCX OOXML zip as base64", () => {
  const spec = {
    title: "Dokumen Uji",
    subtitle: "Tantular",
    author: "",
    date: "",
    executiveSummary: ["Ringkasan"],
    sections: [{
      heading: "Bagian 1",
      level: 1,
      paragraphs: ["Isi dengan karakter aman & benar."],
      bullets: ["Poin A"],
      quote: ""
    }],
    closing: ["Selesai"]
  };
  const base64 = buildDocumentDocxBase64(spec);
  const bytes = Buffer.from(base64, "base64");
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
  assert.ok(bytes.length > 3000);
});

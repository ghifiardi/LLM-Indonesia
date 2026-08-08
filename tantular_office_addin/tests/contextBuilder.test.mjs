import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkText,
  hashText,
  normalizeSearchText,
  selectRelevantContext
} from "../src/chat/contextBuilder.js";

test("short text is a single chunk", () => {
  assert.deepEqual(chunkText("halo dunia", { chunkSize: 3000 }), ["halo dunia"]);
});

test("splits on paragraph boundaries, not mid-paragraph", () => {
  const p1 = "a".repeat(1800), p2 = "b".repeat(1800), p3 = "c".repeat(1800);
  const chunks = chunkText(`${p1}\n${p2}\n${p3}`, { chunkSize: 3000 });
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].includes(p1) && !chunks[0].includes("b"));
});

test("hard-splits a single oversized paragraph", () => {
  const chunks = chunkText("x".repeat(7000), { chunkSize: 3000 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 3000);
});

test("hash is stable and change-sensitive", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("normalizes punctuation and casing for heading search", () => {
  assert.equal(
    normalizeSearchText("Closed Model vs. Open-Weight: Memahami Perbedaan"),
    "closed model vs open weight memahami perbedaan"
  );
});

test("retrieves an exact quoted subsection and its following paragraphs", () => {
  const body = [
    "Digital Sovereignty",
    "Digital sovereignty adalah konsep bahwa kita memiliki kontrol atas data.",
    "Closed Model vs. Open-Weight: Memahami Perbedaan",
    "Closed model dan open-weight adalah dua pendekatan berbeda dalam pengembangan AI.",
    "Kedua pendekatan memiliki manfaat dan risiko.",
    "Roadmap Implementasi",
    "Implementasi dilakukan bertahap."
  ].join("\n");
  const result = selectRelevantContext(
    body,
    "Apakah bisa dielaborasi di sub-section 'Closed Model vs. Open-Weight: Memahami Perbedaan'?"
  );
  assert.match(result, /Closed Model vs\. Open-Weight/);
  assert.match(result, /dua pendekatan berbeda/);
  assert.doesNotMatch(result, /Roadmap Implementasi/);
});

test("finds a relevant section late in a long document without summarizing it away", () => {
  const filler = Array.from({ length: 80 }, (_, i) => `Bagian umum ${i}\nIsi umum yang tidak relevan ${i}.`).join("\n");
  const target = "Arsitektur Model Terbuka\nOpen-weight memberi opsi kustomisasi dan exit plan.";
  const result = selectRelevantContext(
    `${filler}\n${target}`,
    "Jelaskan bagian Arsitektur Model Terbuka"
  );
  assert.match(result, /Arsitektur Model Terbuka/);
  assert.match(result, /exit plan/);
});

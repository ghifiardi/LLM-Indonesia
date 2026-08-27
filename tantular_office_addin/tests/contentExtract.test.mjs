import test from "node:test";
import assert from "node:assert/strict";
import { extractFetchedText, htmlToText } from "../src/chat/contentExtract.js";

test("HTML extraction removes scripts/styles and keeps visible text", () => {
  const text = htmlToText(`<html><style>.x{}</style><script>steal()</script>
    <h1>Judul Resmi</h1><p>Data &amp; statistik Indonesia.</p></html>`);
  assert.equal(text, "Judul Resmi\nData & statistik Indonesia.");
  assert.doesNotMatch(text, /steal|\.x/);
});

test("PDF is allowed by fetch policy but not silently treated as text", () => {
  const out = extractFetchedText({ body: Buffer.from("%PDF"), contentType: "application/pdf" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "pdf_extractor_required");
});

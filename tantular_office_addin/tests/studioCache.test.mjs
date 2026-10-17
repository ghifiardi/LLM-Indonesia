import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintStudioInputs } from "../src/chat/studioCache.js";

test("identical inputs fingerprint identically regardless of options key order", () => {
  const a = fingerprintStudioInputs({
    content: "Brief.", options: { sectionCount: 6, tone: "formal" },
    instruction: "gunakan bullet", mode: "local", model: "tantular-office:0.5-9b"
  });
  const b = fingerprintStudioInputs({
    content: "Brief.", options: { tone: "formal", sectionCount: 6 },
    instruction: "gunakan bullet", mode: "local", model: "tantular-office:0.5-9b"
  });
  assert.equal(a, b);
});

test("changing the source content invalidates the fingerprint", () => {
  const base = { options: { sectionCount: 6 }, instruction: "", mode: "local", model: "m" };
  const a = fingerprintStudioInputs({ ...base, content: "Brief satu." });
  const b = fingerprintStudioInputs({ ...base, content: "Brief dua." });
  assert.notEqual(a, b);
});

test("changing any option invalidates the fingerprint", () => {
  const base = { content: "Brief.", instruction: "", mode: "local", model: "m" };
  const a = fingerprintStudioInputs({ ...base, options: { sectionCount: 6 } });
  const b = fingerprintStudioInputs({ ...base, options: { sectionCount: 12 } });
  assert.notEqual(a, b);
});

test("changing the instruction invalidates the fingerprint", () => {
  const base = { content: "Brief.", options: {}, mode: "local", model: "m" };
  const a = fingerprintStudioInputs({ ...base, instruction: "formal" });
  const b = fingerprintStudioInputs({ ...base, instruction: "santai" });
  assert.notEqual(a, b);
});

test("changing mode or model invalidates the fingerprint — a different mode/model can answer differently", () => {
  const base = { content: "Brief.", options: {}, instruction: "" };
  const localVsCloud = [
    fingerprintStudioInputs({ ...base, mode: "local", model: "m" }),
    fingerprintStudioInputs({ ...base, mode: "cloud", model: "m" })
  ];
  assert.notEqual(localVsCloud[0], localVsCloud[1]);

  const modelA = fingerprintStudioInputs({ ...base, mode: "local", model: "tantular-office:0.5-9b" });
  const modelB = fingerprintStudioInputs({ ...base, mode: "local", model: "tantular-office:lite" });
  assert.notEqual(modelA, modelB);
});

test("missing fields do not throw and still fingerprint consistently", () => {
  assert.equal(fingerprintStudioInputs(), fingerprintStudioInputs({}));
  assert.doesNotThrow(() => fingerprintStudioInputs({ content: "x" }));
});

// --- resolveAutoLoadedSource (verified fix follow-up: long Word sources) ---
// Document Studio's Word auto-read fits only a 12,000-char preview into the
// textarea; without this, a Download right after Create on a longer source
// fingerprinted the truncated preview while Create fingerprinted the full
// body — two different fingerprints for what the user experienced as
// "nothing changed," so the cache never actually hit.

import { resolveAutoLoadedSource } from "../src/chat/studioCache.js";

function longSource(chars) {
  // Deterministic, easy to eyeball in a failure message, and NOT just
  // whitespace repeated (which some trims could collapse).
  let s = "";
  while (s.length < chars) s += "Paragraf sumber Word yang panjang. ";
  return s.slice(0, chars);
}

test("a >12,000-char Word source is reused in full when the textarea is untouched", () => {
  const full = longSource(15_500);
  const preview = full.slice(0, 12_000);
  const result = resolveAutoLoadedSource({
    docFile: null,
    typedContent: preview, // what uploadedOrTypedContent() reads back from the textarea
    storedFullText: full,
    storedPreview: preview
  });
  assert.equal(result.reused, true);
  assert.equal(result.content, full);
  assert.equal(result.content.length, 15_500);
});

test("editing the textarea even slightly invalidates the stored full source", () => {
  const full = longSource(15_500);
  const preview = full.slice(0, 12_000);
  const edited = `${preview} `; // one extra character
  const result = resolveAutoLoadedSource({
    docFile: null,
    typedContent: edited,
    storedFullText: full,
    storedPreview: preview
  });
  assert.equal(result.reused, false);
  assert.equal(result.content, edited, "an edit must be treated as the new content, not silently discarded");
});

test("uploading a file supersedes a previously auto-loaded Word source even if the textarea still matches", () => {
  const full = longSource(15_500);
  const preview = full.slice(0, 12_000);
  const result = resolveAutoLoadedSource({
    docFile: { name: "brief.pdf" },
    typedContent: preview,
    storedFullText: full,
    storedPreview: preview
  });
  assert.equal(result.reused, false, "an uploaded file's content path must win, not the stale Word source");
});

test("nothing stored yet: the typed/preview content is used as-is", () => {
  const result = resolveAutoLoadedSource({
    docFile: null, typedContent: "Teks pendek.", storedFullText: "", storedPreview: ""
  });
  assert.equal(result.reused, false);
  assert.equal(result.content, "Teks pendek.");
});

test("Create then Download fingerprints identically for a >12,000-char auto-loaded source", () => {
  const full = longSource(15_500);
  const preview = full.slice(0, 12_000);
  const options = { documentType: "Laporan profesional", tone: "", sectionCount: 6 };

  // Create: resolveDocumentSpec has just read `full` directly from Word.
  const createFingerprint = fingerprintStudioInputs({
    content: full, options, instruction: "", mode: "local", model: "tantular-office:0.5-9b"
  });

  // Download: uploadedOrTypedContent() can only see the textarea (the
  // preview) — resolveAutoLoadedSource must recover `full` before fingerprinting.
  const restored = resolveAutoLoadedSource({
    docFile: null, typedContent: preview, storedFullText: full, storedPreview: preview
  });
  const downloadFingerprint = fingerprintStudioInputs({
    content: restored.content, options, instruction: "", mode: "local", model: "tantular-office:0.5-9b"
  });

  assert.equal(createFingerprint, downloadFingerprint,
    "Create and an immediate Download must fingerprint the SAME (full) content for a long Word source, or the cache can never hit");
});

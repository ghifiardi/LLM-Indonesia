import test from "node:test";
import assert from "node:assert/strict";
import { assertUploadSize, MAX_UPLOAD_BYTES } from "../src/deck/documentExtract.js";

const HUNDRED_MB = 100 * 1024 * 1024;

test("MAX_UPLOAD_BYTES is exactly 100 MB", () => {
  assert.equal(MAX_UPLOAD_BYTES, HUNDRED_MB);
});

test("assertUploadSize passes a file exactly at the 100 MB boundary", () => {
  assert.doesNotThrow(() => assertUploadSize({ size: HUNDRED_MB, name: "big.txt" }));
});

test("assertUploadSize throws for a file one byte over the 100 MB boundary", () => {
  assert.throws(
    () => assertUploadSize({ size: HUNDRED_MB + 1, name: "big.txt" }),
    (err) => err instanceof Error && err.message.includes("100 MB")
  );
});

test("assertUploadSize error message matches the Indonesian wording exactly", () => {
  try {
    assertUploadSize({ size: HUNDRED_MB + 1, name: "big.txt" });
    assert.fail("expected assertUploadSize to throw");
  } catch (err) {
    assert.equal(err.message, "File terlalu besar (maks 100 MB).");
  }
});

test("assertUploadSize throws when no file is provided", () => {
  assert.throws(() => assertUploadSize(null), /Tidak ada file dokumen/);
});

// --- Mode Cloud degradation --------------------------------------------------
// The hosted gateway serves only /api/chat-completions, so PDF/DOCX/PPTX
// extraction must name what is missing instead of surfacing a raw 404.

async function inCloudSession(run) {
  const prevOffice = globalThis.Office;
  const prevLocation = globalThis.location;
  const prevStorage = globalThis.localStorage;
  const store = new Map([[
    "tantular.office.mode.v1",
    JSON.stringify({ mode: "cloud", chosenInOffice: true })
  ]]);
  Object.defineProperty(globalThis, "Office", {
    configurable: true, value: { context: { host: "PowerPoint" } }
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true, value: { hostname: "workshop-web-gamma.vercel.app" }
  });
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  try {
    return await run();
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevOffice === undefined) delete globalThis.Office;
    else Object.defineProperty(globalThis, "Office", { configurable: true, value: prevOffice });
    if (prevLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: prevLocation });
  }
}

test("cloud mode: a PDF upload fails with the companion message, not a 404", async () => {
  await inCloudSession(async () => {
    const { extractDocumentFile } = await import(`../src/deck/documentExtract.js?t=${Date.now()}`);
    await assert.rejects(
      () => extractDocumentFile({ name: "brief.pdf", type: "application/pdf", size: 1024 }),
      (err) => {
        assert.match(err.message, /Tantular Companion/);
        assert.match(err.message, /Mode Cloud/);
        return true;
      }
    );
  });
});

test("cloud mode: a plain-text upload still works — it needs no companion", async () => {
  await inCloudSession(async () => {
    const { extractDocumentFile } = await import(`../src/deck/documentExtract.js?t=${Date.now()}b`);
    const result = await extractDocumentFile({
      name: "notes.txt",
      type: "text/plain",
      size: 12,
      text: async () => "halo dunia"
    });
    assert.equal(result.kind, "text");
    assert.equal(result.text, "halo dunia");
  });
});

test("cloud mode: Extract from image names the unavailable feature", async () => {
  await inCloudSession(async () => {
    const { extractSlideFromImage } = await import(`../src/deck/visionExtract.js?t=${Date.now()}`);
    await assert.rejects(
      () => extractSlideFromImage("data:image/png;base64,AA"),
      (err) => {
        assert.match(err.message, /Extract from image/);
        assert.match(err.message, /Mode Cloud/);
        return true;
      }
    );
  });
});

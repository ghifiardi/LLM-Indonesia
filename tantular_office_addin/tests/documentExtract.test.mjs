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

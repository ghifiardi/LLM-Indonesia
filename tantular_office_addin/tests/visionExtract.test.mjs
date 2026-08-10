import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseOcrEngine,
  extractWithFallback,
  memoizeOcrProbe,
  ocrStatusLine
} from "../src/deck/visionExtract.js";

test("probe 200 apple-vision -> apple engine; 501 or network error -> model", () => {
  assert.equal(
    chooseOcrEngine({ probeStatus: { ok: true, engine: "apple-vision" } }),
    "apple-vision"
  );
  assert.equal(
    chooseOcrEngine({ probeStatus: { ok: false, error: "501" } }),
    "model"
  );
  assert.equal(chooseOcrEngine({ probeStatus: undefined }), "model");
  assert.equal(chooseOcrEngine({}), "model");
});

test("apple OCR mid-flight failure falls back to model and still returns text", async () => {
  const result = await extractWithFallback({
    probe: async () => ({ ok: true, engine: "apple-vision" }),
    ocrCall: async () => {
      throw new Error("Vision request gagal di tengah jalan.");
    },
    modelCall: async () => "Teks dari model vision."
  });
  assert.equal(result.engine, "model");
  assert.equal(result.text, "Teks dari model vision.");
});

test("Windows/no-doc-server path: probe rejects -> model engine used (fallback coverage)", async () => {
  const result = await extractWithFallback({
    probe: async () => {
      throw new Error("fetch failed (no doc-server on this host)");
    },
    ocrCall: async () => {
      throw new Error("should never be called — probe failed");
    },
    modelCall: async () => "Hasil model vision di Windows."
  });
  assert.equal(result.engine, "model");
  assert.equal(result.text, "Hasil model vision di Windows.");
});

test("probe 501 (no Apple Vision) -> model engine, ocrCall never invoked", async () => {
  let ocrCallInvoked = false;
  const result = await extractWithFallback({
    probe: async () => ({ ok: false, error: "Apple Vision tidak tersedia (bukan macOS)." }),
    ocrCall: async () => {
      ocrCallInvoked = true;
      return "should not happen";
    },
    modelCall: async () => "Hasil model vision."
  });
  assert.equal(result.engine, "model");
  assert.equal(ocrCallInvoked, false);
  assert.equal(result.text, "Hasil model vision.");
});

test("apple engine succeeds end-to-end without touching modelCall", async () => {
  let modelCallInvoked = false;
  const result = await extractWithFallback({
    probe: async () => ({ ok: true, engine: "apple-vision" }),
    ocrCall: async () => "Teks hasil Apple Vision OCR.",
    modelCall: async () => {
      modelCallInvoked = true;
      return "should not happen";
    }
  });
  assert.equal(result.engine, "apple-vision");
  assert.equal(result.text, "Teks hasil Apple Vision OCR.");
  assert.equal(modelCallInvoked, false);
});

test("engine name surfaces in the result meta for the status line", async () => {
  const appleResult = await extractWithFallback({
    probe: async () => ({ ok: true, engine: "apple-vision" }),
    ocrCall: async () => "Teks A.",
    modelCall: async () => "Teks B."
  });
  assert.equal(ocrStatusLine(appleResult.engine), "Ekstraksi teks: Apple Vision");

  const modelResult = await extractWithFallback({
    probe: async () => ({ ok: false }),
    ocrCall: async () => "unused",
    modelCall: async () => "Teks B."
  });
  assert.equal(ocrStatusLine(modelResult.engine), "Ekstraksi teks: model vision");
});

test("probe memoization: underlying probe function runs only once across repeated calls", async () => {
  let callCount = 0;
  const rawProbe = async () => {
    callCount += 1;
    return { ok: true, engine: "apple-vision" };
  };
  const memoized = memoizeOcrProbe(rawProbe);

  const [first, second, third] = await Promise.all([memoized(), memoized(), memoized()]);
  assert.deepEqual(first, { ok: true, engine: "apple-vision" });
  assert.deepEqual(second, { ok: true, engine: "apple-vision" });
  assert.deepEqual(third, { ok: true, engine: "apple-vision" });
  assert.equal(callCount, 1);

  await memoized();
  assert.equal(callCount, 1, "a later call after resolution must not re-invoke the probe");
});

test("probe memoization: a failed probe is retried on next call (not permanently cached as a throw)", async () => {
  let callCount = 0;
  const rawProbe = async () => {
    callCount += 1;
    throw new Error("network error");
  };
  const memoized = memoizeOcrProbe(rawProbe);

  await assert.rejects(() => memoized());
  assert.equal(callCount, 1);
});

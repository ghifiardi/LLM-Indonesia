import test from "node:test";
import assert from "node:assert/strict";
import { planWorkbook } from "../src/workbook/workbookPlanner.js";

// Verified fix: a user's Cancel click must stop the workflow, not degrade
// into a fallback workbook that then gets built into a .xlsx and written
// into Excel anyway.
test("planWorkbook rejects (does not resolve to a fallback spec) once the signal is aborted", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      planWorkbook({
        brief: "Tracker anggaran singkat untuk diuji.",
        sheetCount: 2,
        signal: controller.signal
      }),
      "planWorkbook must reject after the caller's signal is aborted, not resolve to a fallback spec"
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

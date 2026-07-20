import test from "node:test";
import assert from "node:assert/strict";

test("runTantularStream converts pre-response AbortError to dihentikan contract", async () => {
  // Stub localStorage before importing the module
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {}
  };

  // Stub fetch to reject with AbortError during the fetch phase (before response)
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    throw err;
  };

  try {
    // Dynamic import after stubs are in place
    const { runTantularStream } = await import("../src/tantularClient.js");

    // Call runTantularStream and expect it to reject with the dihentikan contract
    await assert.rejects(
      () => runTantularStream({ system: "s", user: "u", onToken: () => {} }),
      (error) => {
        assert.equal(error.message, "dihentikan", `Expected message "dihentikan", got "${error.message}"`);
        assert.equal(error.partialText, "", `Expected partialText "", got "${error.partialText}"`);
        return true;
      }
    );
  } finally {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  }
});

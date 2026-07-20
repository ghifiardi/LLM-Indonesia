import test from "node:test";
import assert from "node:assert/strict";

test("runTantular (non-streaming callChat) sends reasoning_effort: none", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "UMUM" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u", maxTokens: 8 });
    assert.equal(out, "UMUM");
    assert.equal(capturedBody.reasoning_effort, "none");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runTantular retries once without reasoning_effort if the server rejects the field", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning_effort) {
      return { ok: false, status: 400, text: async () => "unknown parameter: reasoning_effort" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "UMUM" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u", maxTokens: 8 });
    assert.equal(out, "UMUM");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning_effort, "none");
    assert.equal(bodies[1].reasoning_effort, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runTantularStream sends reasoning_effort: none", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            }
          };
        }
      },
      text: async () => ""
    };
  };
  try {
    const { runTantularStream } = await import("../src/tantularClient.js");
    let tokens = "";
    const out = await runTantularStream({ system: "s", user: "u", onToken: (t) => { tokens += t; } });
    assert.equal(out, "hi");
    assert.equal(tokens, "hi");
    assert.equal(capturedBody.reasoning_effort, "none");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

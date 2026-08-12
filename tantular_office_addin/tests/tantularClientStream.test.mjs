import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelList, buildChatHeaders, endpointErrorMessage } from "../src/tantularClient.js";

const GATEWAY = "https://openai.example.com/v1/chat/completions";

test("buildChatHeaders attaches Bearer only for a configured remote endpoint", () => {
  assert.deepEqual(buildChatHeaders(GATEWAY, "sk-abc"), {
    "Content-Type": "application/json",
    Authorization: "Bearer sk-abc"
  });
  // No key configured: plain local Ollama, nothing to send.
  assert.deepEqual(buildChatHeaders(GATEWAY, ""), { "Content-Type": "application/json" });
  assert.deepEqual(buildChatHeaders(GATEWAY, "   "), { "Content-Type": "application/json" });
  // The bundled companion proxy talks to local Ollama; never hand it a key.
  assert.deepEqual(buildChatHeaders("/api/chat-completions", "sk-abc"), {
    "Content-Type": "application/json"
  });
});

test("endpointErrorMessage distinguishes bad key (401) from model-scoped key (403)", () => {
  assert.match(endpointErrorMessage(401, "invalid key"), /API key.*401/s);
  const forbidden = endpointErrorMessage(403, "key not allowed to access model", "muse-glimmer");
  assert.match(forbidden, /403/);
  assert.match(forbidden, /muse-glimmer/);
  assert.match(endpointErrorMessage(500, "boom"), /Model endpoint gagal \(500\)/);
});

test("runTantular sends the stored API key to a remote endpoint", async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ endpoint: GATEWAY, apiKey: "sk-secret" }),
    setItem: () => {}
  };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let capturedHeaders = null;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "UMUM" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    assert.equal(await runTantular({ system: "s", user: "u", maxTokens: 8 }), "UMUM");
    assert.equal(capturedHeaders.Authorization, "Bearer sk-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a keyed remote endpoint does NOT silently fall back to the local companion", async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ endpoint: GATEWAY, apiKey: "sk-secret" }),
    setItem: () => {}
  };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    throw new TypeError("Load failed");
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    await assert.rejects(() => runTantular({ system: "s", user: "u", maxTokens: 8 }));
    // Exactly one attempt, against the gateway — never a retry at the local proxy,
    // which would answer from a different model while looking like success.
    assert.deepEqual(urls, [GATEWAY]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unkeyed custom endpoint still falls back to the local companion", async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ endpoint: GATEWAY }),
    setItem: () => {}
  };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url === GATEWAY) throw new TypeError("Load failed");
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "LOKAL" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    assert.equal(await runTantular({ system: "s", user: "u", maxTokens: 8 }), "LOKAL");
    assert.deepEqual(urls, [GATEWAY, "/api/chat-completions"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes Ollama model list with Tantular models first", () => {
  assert.deepEqual(
    normalizeModelList({
      models: [
        { name: "qwen3.5:9b" },
        { name: "tantular-office:0.4-9b" },
        { model: "tantular:0.2-id-3b-lora" },
        { name: "qwen3.5:9b" }
      ]
    }),
    ["tantular-office:0.4-9b", "tantular:0.2-id-3b-lora", "qwen3.5:9b"]
  );
});

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

test("runTantular deck JSON mode sends response_format", async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ deckModel: "qwen3.5:9b" }),
    setItem: () => {}
  };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u", task: "deck", jsonMode: true });
    assert.equal(out, "{\"ok\":true}");
    assert.deepEqual(capturedBody.response_format, { type: "json_object" });
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

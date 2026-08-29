import test from "node:test";
import assert from "node:assert/strict";
import gatewayHandler from "../workshop/api/chat-completions.js";
import {
  normalizeModelList,
  buildChatHeaders,
  endpointErrorMessage,
  reasoningControlFor
} from "../src/tantularClient.js";

test("reasoning control is chosen per model family", () => {
  // Qwen honours the request field — unchanged behaviour.
  assert.equal(reasoningControlFor("qwen3.5:9b"), "request_field");
  assert.equal(reasoningControlFor("tantular-office:0.4-9b"), "request_field");
  assert.equal(reasoningControlFor("qwen3.5:4b"), "request_field");
  // Harmony-format models ignore reasoning_effort; their control is a chat
  // template variable.
  assert.equal(reasoningControlFor("muse-glimmer:30b"), "chat_template");
  assert.equal(reasoningControlFor("ollama/muse-glimmer-30b"), "chat_template");
  assert.equal(reasoningControlFor("gpt-oss:20b"), "chat_template");
  // Unknown models keep the existing path rather than guessing.
  assert.equal(reasoningControlFor("llama3.1:8b"), "request_field");
  assert.equal(reasoningControlFor(""), "request_field");
});

// REGRESSION: the intent router runs on a 4-token budget. If thinking is not
// actually disabled, reasoning consumes the whole budget and the router gets an
// empty string — the failure is silent, because the request itself succeeds.
// A harmony model ignores reasoning_effort entirely, so sending only that field
// would reintroduce the bug for any such model.
test("router receives a non-empty answer with reasoning disabled (Qwen path)", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    // Stand in for a server that only silences thinking when asked correctly.
    const silenced = body.reasoning_effort === "none";
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: silenced ? "EDIT_TEKS" : "" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "route", user: "perbaiki ini", maxTokens: 4 });
    assert.equal(out, "EDIT_TEKS", "router must get a usable label, not an empty string");
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.chat_template_kwargs, undefined, "Qwen path must be unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("router receives a non-empty answer with reasoning disabled (harmony path)", async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ model: "muse-glimmer:30b" }),
    setItem: () => {}
  };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    // A harmony model ignores reasoning_effort. Only the template variable
    // silences it — exactly the bug this test pins.
    const silenced = body.chat_template_kwargs?.reasoning_strength
      && body.chat_template_kwargs.reasoning_strength !== "high";
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: silenced ? "EDIT_TEKS" : "" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "route", user: "perbaiki ini", maxTokens: 4 });
    assert.equal(out, "EDIT_TEKS", "harmony model must also yield a usable router label");
    assert.equal(body.chat_template_kwargs.reasoning_strength, "low");
    assert.equal(body.reasoning_effort, undefined, "reasoning_effort is a no-op here");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

// REGRESSION: EDIT_TEKS on a large selection asks the local model for one
// JSON edit per sentence — long structured output on possibly slow hardware,
// same shape of problem Studio tasks already get 480s for. The plain-chat
// budget (90s) was measured too short for that even on a capable machine,
// timing out before the model finished. task: "edit" must get real headroom
// without silently falling back to the deck/document/workbook model.
test("runTantular gives task 'edit' a longer timeout than plain chat, on the chat model", async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ model: "tantular-office:lite", deckModel: "tantular-office:0.5-9b" }),
    setItem: () => {}
  };
  const capturedDelays = [];
  globalThis.window = {
    setTimeout: (fn, ms) => { capturedDelays.push(ms); return setTimeout(fn, ms); },
    clearTimeout: (...a) => clearTimeout(...a)
  };
  const originalFetch = globalThis.fetch;
  let capturedModel = null;
  globalThis.fetch = async (_url, init) => {
    capturedModel = JSON.parse(init.body).model;
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    await runTantular({ system: "s", user: "u", task: "edit" });
    assert.equal(capturedDelays[0], 240_000);
    assert.equal(capturedModel, "tantular-office:lite", "task 'edit' must stay on the chat model, not deckModel");

    capturedDelays.length = 0;
    await runTantular({ system: "s", user: "u" }); // default task: "general"
    assert.equal(capturedDelays[0], 90_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// REGRESSION: a RAM-constrained install only ever builds "tantular-office:lite"
// — it never pulls the 9B chat default OR its qwen3.5:9b fallback. If settings
// ever point back at that default (a settings reset, a fresh profile, a
// cleared site data — none of which touch what's actually installed), BOTH
// the primary model and request.fallbackModel 404 with "model not found", and
// the raw error used to reach the user with no way to recover short of
// manually reconfiguring — "keep saying the same error, no matter what I did".
test("runTantular auto-downgrades a missing chat model to an installed lite one, and persists it", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const savedSettings = [];
  globalThis.localStorage.setItem = (_key, value) => savedSettings.push(JSON.parse(value));
  const attemptedModels = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/models")) {
      return {
        ok: true, status: 200,
        json: async () => ({ models: [{ name: "tantular-office:lite" }] }),
        text: async () => ""
      };
    }
    const model = JSON.parse(init.body).model;
    attemptedModels.push(model);
    if (model === "tantular-office:lite") {
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: "Halo!" } }] }),
        text: async () => ""
      };
    }
    // Neither the configured default nor its qwen3.5:9b fallback is installed
    // on this machine — exactly Ollama's real 404 shape.
    return {
      ok: false, status: 404,
      json: async () => ({ error: `model '${model}' not found` }),
      text: async () => JSON.stringify({ error: `model '${model}' not found` })
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u" }); // default task: "general"
    assert.equal(out, "Halo!");
    assert.deepEqual(attemptedModels, ["tantular-office:0.5-9b", "qwen3.5:9b", "tantular-office:lite"],
      "must try the configured default, its built-in fallback, then the auto-downgrade — in that order");
    const persisted = savedSettings.at(-1);
    assert.equal(persisted.model, "tantular-office:lite", "must persist to the CHAT model field, not deckModel");
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

// --- gateway streaming end to end -------------------------------------------

// Drive the REAL gateway handler, capture the REAL body it produces, and feed exactly
// that to the REAL client streaming function. No hand-written SSE fixture: a fixture
// would have hidden this bug, because the fixture is what the client always agreed with
// — it was the gateway that disagreed.
async function gatewayBodyFor(content) {
  const captured = { statusCode: null, body: null, headers: {} };
  captured.status = (code) => { captured.statusCode = code; return captured; };
  captured.json = (payload) => { captured.body = payload; return captured; };
  captured.send = (text) => { captured.body = text; return captured; };
  captured.setHeader = (name, value) => { captured.headers[name] = value; };
  captured.end = () => captured;

  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.TANTULAR_UPSTREAM_URL;
  const originalKey = process.env.TANTULAR_UPSTREAM_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      id: "cmpl-1",
      model: "Qwen/Qwen3.5-9B",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }
    })
  });
  process.env.TANTULAR_UPSTREAM_URL = "https://upstream.example/v1/chat";
  process.env.TANTULAR_UPSTREAM_KEY = "k";
  try {
    await gatewayHandler(
      { method: "POST", body: { messages: [{ role: "user", content: "hai" }], stream: true } },
      captured
    );
    return captured.body;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.TANTULAR_UPSTREAM_URL;
    else process.env.TANTULAR_UPSTREAM_URL = originalUrl;
    if (originalKey === undefined) delete process.env.TANTULAR_UPSTREAM_KEY;
    else process.env.TANTULAR_UPSTREAM_KEY = originalKey;
  }
}

function responseStreamingBytes(text) {
  const bytes = new TextEncoder().encode(text);
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
}

// REGRESSION (Cloud Mode, all seven streaming pipelines: UMUM, RINGKAS, UBAH_NADA,
// TERJEMAH, CEK_AMAN, DRAFT_TEKS, TANYA_DOKUMEN). Before the gateway shim, the body it
// returned was plain JSON with no `data:` lines, so the accumulator yielded nothing,
// `full` stayed empty, and this threw "Model tidak mengembalikan teks." on every
// ordinary chat message in the cloud.
test("runTantularStream returns text when driven by the real gateway's own body", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const gatewayBody = await gatewayBodyFor("Halo dunia");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseStreamingBytes(gatewayBody);
  try {
    const { runTantularStream } = await import("../src/tantularClient.js");
    let streamed = "";
    const out = await runTantularStream({ system: "s", user: "u", onToken: (t) => { streamed += t; } });
    assert.equal(out, "Halo dunia");
    assert.equal(streamed, "Halo dunia", "the pane's incremental callback must also receive the text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- companion timeout -------------------------------------------------------
test("listLocalModels aborts instead of hanging when the companion never answers", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  // A companion that accepts the connection and never responds. Without a
  // deadline this await never settles, the dropdown stays on "Memuat daftar
  // model..." forever, and the user is told to reinstall models they have.
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  try {
    const { listLocalModels } = await import("../src/tantularClient.js");
    await assert.rejects(() => listLocalModels(), (error) => {
      assert.match(error.message, /tidak menjawab|Companion/i,
        "must name the companion, not blame the model install");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

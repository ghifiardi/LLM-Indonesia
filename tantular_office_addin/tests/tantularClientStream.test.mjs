import test from "node:test";
import assert from "node:assert/strict";
import gatewayHandler from "../workshop/api/chat-completions.js";
import {
  normalizeModelList,
  buildChatHeaders,
  endpointErrorMessage,
  reasoningControlFor,
  runTantular,
  consumeLastInferenceMetrics
} from "../src/tantularClient.js";
import { documentWireSchema } from "../src/document/documentPlanner.js";

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

// --- JSON Schema structured output (2026-08-31 reliability follow-up) ------
// json_object mode ("format":"json" on Ollama) only asks for well-formed
// JSON; it does not stop the model from omitting a closing bracket, which a
// live itemizable-fixture test reproduced. json_schema ("format":<schema
// object>) makes Ollama enforce the grammar server-side instead.

test("a caller that passes jsonSchema gets response_format:json_schema, not json_object", async () => {
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
      json: async () => ({ choices: [{ message: { content: "{\"t\":\"x\",\"s\":[]}" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const schema = documentWireSchema(6);
    await runTantular({ system: "s", user: "u", task: "document", jsonMode: true, jsonSchema: schema });
    assert.equal(capturedBody.response_format.type, "json_schema");
    assert.deepEqual(capturedBody.response_format.json_schema.schema, schema);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("documentWireSchema uses the requested section count for s.minItems/maxItems and caps b at 2", () => {
  const schema = documentWireSchema(6);
  assert.equal(schema.properties.s.minItems, 6);
  assert.equal(schema.properties.s.maxItems, 6);
  assert.equal(schema.properties.s.items.properties.b.maxItems, 2);
  // "b" itself is not in "required" — a narrative section may omit it entirely.
  assert.ok(!schema.properties.s.items.required.includes("b"));
  assert.equal(schema.additionalProperties, false);
});

test("a malformed/undefined jsonSchema is never sent as response_format.json_schema.schema", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
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
    // jsonMode true but no schema supplied: falls back to plain json_object,
    // never sends a broken/empty schema.
    await runTantular({ system: "s", user: "u", jsonMode: true });
    assert.deepEqual(capturedBody.response_format, { type: "json_object" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("schema rejection downgrades exactly once to json_object, not straight to no JSON mode", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.response_format?.type === "json_schema") {
      return { ok: false, status: 400, text: async () => "unsupported: response_format.json_schema" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u", jsonMode: true, jsonSchema: documentWireSchema(3) });
    assert.equal(out, "{\"ok\":true}");
    assert.equal(bodies.length, 2, "one rejected schema attempt, one successful json_object retry");
    assert.equal(bodies[0].response_format.type, "json_schema");
    assert.equal(bodies[1].response_format.type, "json_object");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("json_object rejection after a schema downgrade follows the existing no-JSON-mode behavior", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.response_format) {
      return { ok: false, status: 400, text: async () => "unsupported: response_format" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "plain text" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u", jsonMode: true, jsonSchema: documentWireSchema(3) });
    assert.equal(out, "plain text");
    assert.equal(bodies.length, 3, "schema rejected, json_object rejected, final attempt has no response_format");
    assert.equal(bodies[0].response_format.type, "json_schema");
    assert.equal(bodies[1].response_format.type, "json_object");
    assert.equal(bodies[2].response_format, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reasoning-control retries preserve the JSON schema (both rejections handled independently)", async () => {
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
      json: async () => ({ choices: [{ message: { content: "{\"t\":\"x\",\"s\":[]}" } }] }),
      text: async () => ""
    };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const schema = documentWireSchema(3);
    await runTantular({ system: "s", user: "u", jsonMode: true, jsonSchema: schema });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].response_format.type, "json_schema");
    assert.equal(bodies[1].response_format.type, "json_schema",
      "dropping reasoning_effort must not also drop the schema — they are independent rejections");
    assert.equal(bodies[1].reasoning_effort, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Structured-mode telemetry (2026-08-31 fail-closed follow-up) ----------
// An earlier reliability gate ran against a stale Companion process that
// still had the pre-schema bridge loaded — nothing in the client-visible
// result said so, and the gate's own conclusion ("Ollama ignores nested
// minItems/maxItems") turned out to be unsupported once that was caught by
// timestamp inspection. These fields exist so that mistake is visible from
// the metrics themselves, not just from manually diffing file mtimes against
// a process start time.

test("structured telemetry: schema used successfully — no downgrade, correct requested/used labels", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: "{\"t\":\"x\",\"s\":[]}" }, finish_reason: "stop" }],
      tantular_metrics: { promptTokens: 40, completionTokens: 300 },
      tantular_structured_mode: "schema"
    }),
    text: async () => ""
  });
  try {
    let metrics = null;
    await runTantular({
      system: "s", user: "u", maxTokens: 4000, task: "document",
      jsonMode: true, jsonSchema: documentWireSchema(3), onMetrics: (m) => { metrics = m; }
    });
    assert.equal(metrics.structuredModeRequested, "schema");
    assert.equal(metrics.structuredModeUsed, "schema");
    assert.equal(metrics.structuredModeDowngraded, false);
    assert.equal(metrics.structuredDowngradeReason, null);
    assert.equal(metrics.finishReason, "stop");
    assert.equal(metrics.completionTokens, 300);
    assert.equal(metrics.requestedMaxTokens, 4000);
    assert.equal(metrics.nearTokenCap, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured telemetry: server-reported mode is trusted over the client's own request when both are present", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      // The client asked for schema, but the Companion (e.g. a stale bridge
      // process) actually sent plain json_object — this is exactly the class
      // of bug that invalidated an earlier reliability gate.
      choices: [{ message: { content: "{\"t\":\"x\",\"s\":[]}" }, finish_reason: "stop" }],
      tantular_metrics: { promptTokens: 40, completionTokens: 300 },
      tantular_structured_mode: "json_object"
    }),
    text: async () => ""
  });
  try {
    let metrics = null;
    await runTantular({
      system: "s", user: "u", maxTokens: 4000, task: "document",
      jsonMode: true, jsonSchema: documentWireSchema(3), onMetrics: (m) => { metrics = m; }
    });
    assert.equal(metrics.structuredModeRequested, "schema");
    assert.equal(metrics.structuredModeUsed, "json_object",
      "the server-confirmed mode must win over what the client merely asked for");
    assert.equal(metrics.structuredModeDowngraded, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured telemetry: schema rejected -> json_object downgrade is reported with a reason", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.response_format?.type === "json_schema") {
      return { ok: false, status: 400, text: async () => "unsupported: response_format.json_schema" };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: "{\"t\":\"x\",\"s\":[]}" }, finish_reason: "stop" }],
        tantular_metrics: { promptTokens: 40, completionTokens: 300 }
        // No tantular_structured_mode here — simulates a hosted gateway that
        // doesn't run this Companion; the client's own tracked mode must be
        // used as the fallback.
      }),
      text: async () => ""
    };
  };
  try {
    let metrics = null;
    await runTantular({
      system: "s", user: "u", maxTokens: 4000, task: "document",
      jsonMode: true, jsonSchema: documentWireSchema(3), onMetrics: (m) => { metrics = m; }
    });
    assert.equal(metrics.structuredModeRequested, "schema");
    assert.equal(metrics.structuredModeUsed, "json_object");
    assert.equal(metrics.structuredModeDowngraded, true);
    assert.equal(metrics.structuredDowngradeReason, "schema_rejected_by_endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured telemetry: json_object rejected -> none is reported with a reason", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.response_format) {
      return { ok: false, status: 400, text: async () => "unsupported: response_format" };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: "plain text" }, finish_reason: "stop" }],
        tantular_metrics: { promptTokens: 40, completionTokens: 5 }
      }),
      text: async () => ""
    };
  };
  try {
    let metrics = null;
    await runTantular({
      system: "s", user: "u", maxTokens: 4000, task: "document",
      jsonMode: true, jsonSchema: documentWireSchema(3), onMetrics: (m) => { metrics = m; }
    });
    assert.equal(metrics.structuredModeRequested, "schema");
    assert.equal(metrics.structuredModeUsed, "none");
    assert.equal(metrics.structuredModeDowngraded, true);
    assert.equal(metrics.structuredDowngradeReason, "json_object_rejected_by_endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured telemetry: cancellation never reaches the point of reporting a downgrade", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
  try {
    const controller = new AbortController();
    const promise = runTantular({
      system: "s", user: "u", task: "document", jsonMode: true, jsonSchema: documentWireSchema(3), signal: controller.signal
    });
    controller.abort();
    await assert.rejects(() => promise);
    // consumeLastInferenceMetrics must not carry stale telemetry from a
    // cancelled attempt into whatever call reads it next.
    assert.equal(consumeLastInferenceMetrics(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured telemetry: finishReason 'length' and nearTokenCap both reflect a completion at the token ceiling", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: "{\"t\":\"x\",\"s\":[]}" }, finish_reason: "length" }],
      tantular_metrics: { promptTokens: 40, completionTokens: 3960 },
      tantular_structured_mode: "schema"
    }),
    text: async () => ""
  });
  try {
    let metrics = null;
    await runTantular({
      system: "s", user: "u", maxTokens: 4000, task: "document",
      jsonMode: true, jsonSchema: documentWireSchema(3), onMetrics: (m) => { metrics = m; }
    });
    assert.equal(metrics.finishReason, "length");
    assert.equal(metrics.nearTokenCap, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured telemetry: a plain chat call with no JSON mode gets no structured-mode fields at all", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: "Halo!" }, finish_reason: "stop" }],
      tantular_metrics: { promptTokens: 10, completionTokens: 5 }
    }),
    text: async () => ""
  });
  try {
    let metrics = null;
    await runTantular({ system: "s", user: "u", onMetrics: (m) => { metrics = m; } });
    assert.equal(metrics.structuredModeRequested, undefined);
    assert.equal(metrics.structuredModeUsed, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancellation during a schema-mode request performs no downgrade or retry", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    if (init.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const controller = new AbortController();
    const promise = runTantular({
      system: "s", user: "u", jsonMode: true, jsonSchema: documentWireSchema(3), signal: controller.signal
    });
    controller.abort();
    await assert.rejects(() => promise);
    assert.equal(calls, 1, "an aborted request must not retry with a downgraded JSON mode");
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

// --- modelFallbackPolicy (2026-08-31 benchmark-contamination follow-up) ----
// A 10-run itemizable reliability gate asked for Q8 and got a silent
// mid-run downgrade to Lite after a Studio timeout — the row still reported
// "success" and inflated its own wall-clock past 15 minutes hiding what
// actually happened. A benchmark/gate must be able to say "never substitute
// a different model for me" and have a timeout reported as a timeout.

// A window whose setTimeout fires immediately makes callChat's own 480s
// watchdog abort every later real request instantly too if it leaks into
// another test — always restore it in `finally`, the same way `fetch` is
// restored, not just reassign it and move on.
const REAL_WINDOW = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };

test("modelFallbackPolicy 'none': a Studio timeout is reported as a timeout, never tries Lite, never persists settings", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const savedSettings = [];
  globalThis.localStorage.setItem = (_key, value) => savedSettings.push(JSON.parse(value));
  // Firing the timeout callback immediately (instead of waiting the real
  // 480s) simulates the timeout deterministically.
  globalThis.window = {
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {}
  };
  const originalFetch = globalThis.fetch;
  const attemptedModels = [];
  globalThis.fetch = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    attemptedModels.push(model);
    if (init.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Promise(() => {}); // never resolves — the timeout is what ends this
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    await assert.rejects(
      () => runTantular({ system: "s", user: "u", task: "document", modelFallbackPolicy: "none" }),
      /terlalu lama/i
    );
    assert.deepEqual(attemptedModels, ["tantular-office:0.5-9b"],
      "exactly one model attempt — no Lite retry");
    assert.equal(savedSettings.length, 0, "a policy of 'none' must never persist a different Studio model");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = REAL_WINDOW;
  }
});

test("modelFallbackPolicy 'missing-model-only': a Studio timeout still fails as a timeout, but a missing model still downgrades", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const savedSettings = [];
  globalThis.localStorage.setItem = (_key, value) => savedSettings.push(JSON.parse(value));
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (init.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Promise(() => {});
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    await assert.rejects(
      () => runTantular({ system: "s", user: "u", task: "document", modelFallbackPolicy: "missing-model-only" }),
      /terlalu lama/i
    );
    assert.equal(savedSettings.length, 0, "a timeout must not trigger the missing-model downgrade path");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = REAL_WINDOW;
  }

  // Missing-model case: this path IS still allowed under "missing-model-only".
  const attemptedModels = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/models")) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "tantular-office:lite" }] }), text: async () => "" };
    }
    const model = JSON.parse(init.body).model;
    attemptedModels.push(model);
    if (model === "tantular-office:lite") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "model not found" };
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const out = await runTantular({ system: "s", user: "u", modelFallbackPolicy: "missing-model-only" });
    assert.equal(out, "ok");
    assert.ok(attemptedModels.includes("tantular-office:lite"), "a missing model must still downgrade under 'missing-model-only'");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = REAL_WINDOW;
  }
});

test("modelFallbackPolicy default ('timeout-and-missing') preserves the existing downgrade-on-timeout behavior", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.localStorage.setItem = () => {};
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {} };
  const originalFetch = globalThis.fetch;
  const attemptedModels = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/models")) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "tantular-office:lite" }] }), text: async () => "" };
    }
    const model = JSON.parse(init.body).model;
    attemptedModels.push(model);
    if (model === "tantular-office:lite") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }), text: async () => "" };
    }
    if (init.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Promise(() => {});
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    // No modelFallbackPolicy passed — must behave exactly as before this change.
    const out = await runTantular({ system: "s", user: "u", task: "document" });
    assert.equal(out, "ok");
    assert.ok(attemptedModels.includes("tantular-office:lite"), "unchanged default: a Studio timeout still downgrades to Lite");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = REAL_WINDOW;
  }
});

test("cancellation performs no fallback regardless of modelFallbackPolicy", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = REAL_WINDOW;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  try {
    const { runTantular } = await import("../src/tantularClient.js");
    const controller = new AbortController();
    const promise = runTantular({
      system: "s", user: "u", task: "document", modelFallbackPolicy: "timeout-and-missing", signal: controller.signal
    });
    controller.abort();
    await assert.rejects(() => promise);
    assert.equal(calls, 1, "a cancelled request must not retry with a different model, no matter the policy");
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

// --- Inference telemetry (verified fix follow-up) ---------------------------
// consumeLastInferenceMetrics() is the one place a future benchmarking pass
// (or a diagnostics panel) reads real Ollama timing/token counts instead of
// guessing. It must reflect the MOST RECENT local-model call and must not be
// visible again once consumed.

test("consumeLastInferenceMetrics returns the most recent local call's real Ollama timing, one-shot", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "Jawaban." } }],
      tantular_metrics: {
        promptTokens: 80,
        completionTokens: 300,
        loadDurationMs: 120,
        promptEvalDurationMs: 300,
        evalDurationMs: 15000,
        totalDurationMs: 15420,
        tokensPerSecond: 20
      }
    }),
    text: async () => ""
  });

  try {
    consumeLastInferenceMetrics(); // drain any state left by an earlier test
    const out = await runTantular({ system: "s", user: "u", maxTokens: 50 });
    assert.equal(out, "Jawaban.");

    const metrics = consumeLastInferenceMetrics();
    assert.ok(metrics, "metrics must be captured after a call that returned tantular_metrics");
    assert.equal(metrics.completionTokens, 300);
    assert.equal(metrics.tokensPerSecond, 20);
    assert.ok(metrics.model, "the metrics must record which model produced them");

    assert.equal(consumeLastInferenceMetrics(), null,
      "one-shot: a second consume before any new call must return nothing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consumeLastInferenceMetrics stays null when the response carries no metrics (e.g. Cloud Mode/portal)", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "Jawaban dari cloud." } }] }),
    text: async () => ""
  });

  try {
    consumeLastInferenceMetrics();
    await runTantular({ system: "s", user: "u", maxTokens: 50 });
    assert.equal(consumeLastInferenceMetrics(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Stale metrics (verified fix follow-up) ---------------------------------
// The old code only assigned lastInferenceMetrics when a response carried
// tantular_metrics, so a request that came back WITHOUT metrics — or never
// came back at all — silently left a prior successful local call's numbers
// sitting in the slot for the next unrelated consumeLastInferenceMetrics()
// caller to mistake for its own.

test("stale metrics: an unconsumed local result does not leak into a later Cloud response with no metrics", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      // Local call WITH metrics — deliberately never consumed.
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: "Lokal." } }],
          tantular_metrics: { promptTokens: 10, completionTokens: 20, tokensPerSecond: 5 }
        }),
        text: async () => ""
      };
    }
    // "Cloud" call with no metrics field at all.
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "Dari cloud." } }] }),
      text: async () => ""
    };
  };
  try {
    await runTantular({ system: "s", user: "u", maxTokens: 8 }); // local, metrics NOT consumed
    await runTantular({ system: "s", user: "u", maxTokens: 8 }); // "cloud", no metrics
    assert.equal(consumeLastInferenceMetrics(), null,
      "the cloud call's absence of metrics must win — the stale local metrics must not surface here");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale metrics: an unconsumed local result does not leak into a later failed request", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: "Lokal." } }],
          tantular_metrics: { promptTokens: 10, completionTokens: 20, tokensPerSecond: 5 }
        }),
        text: async () => ""
      };
    }
    return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
  };
  try {
    await runTantular({ system: "s", user: "u", maxTokens: 8 }); // local, metrics NOT consumed
    await assert.rejects(runTantular({ system: "s", user: "u", maxTokens: 8 })); // fails outright
    assert.equal(consumeLastInferenceMetrics(), null,
      "a failed request must not leave a prior call's metrics behind for the next consumer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale metrics: an unconsumed local result does not leak into a later cancelled request", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    call += 1;
    if (call === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: "Lokal." } }],
          tantular_metrics: { promptTokens: 10, completionTokens: 20, tokensPerSecond: 5 }
        }),
        text: async () => ""
      };
    }
    return new Promise((_resolve, reject) => {
      // The signal reaching fetch is often ALREADY aborted by the time this
      // runs (runTantular's controller aborts synchronously on entry when
      // the caller's signal is pre-aborted) — the "abort" event only fires
      // once, at the moment .abort() is called, so a listener attached
      // after that point would wait forever without this check.
      if (init?.signal?.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  try {
    await runTantular({ system: "s", user: "u", maxTokens: 8 }); // local, metrics NOT consumed
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runTantular({ system: "s", user: "u", maxTokens: 8, signal: controller.signal }));
    assert.equal(consumeLastInferenceMetrics(), null,
      "a cancelled request must not leave a prior call's metrics behind for the next consumer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("onMetrics is invoked with THIS call's own metrics, independent of the shared module slot", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: "Jawaban." } }],
      tantular_metrics: { promptTokens: 1, completionTokens: 2, tokensPerSecond: 3 }
    }),
    text: async () => ""
  });
  try {
    let received = "unset";
    await runTantular({
      system: "s", user: "u", maxTokens: 8,
      onMetrics: (metrics) => { received = metrics; }
    });
    assert.notEqual(received, "unset", "onMetrics must be called");
    assert.equal(received.completionTokens, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("metrics.model reflects the response's own reported model, not just the requested one", async () => {
  globalThis.localStorage = { getItem: () => JSON.stringify({ deckModel: "model-a" }), setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      model: "model-b", // the server answered with a different model than requested
      choices: [{ message: { content: "Jawaban." } }],
      tantular_metrics: { promptTokens: 5, completionTokens: 10, tokensPerSecond: 2 }
    }),
    text: async () => ""
  });
  try {
    let received = null;
    await runTantular({
      system: "s", user: "u", maxTokens: 8, task: "document",
      onMetrics: (m) => { received = m; }
    });
    assert.equal(received.model, "model-b", "onMetrics must report the RESPONSE's model, not the request's");
    const stale = consumeLastInferenceMetrics();
    assert.equal(stale.model, "model-b");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

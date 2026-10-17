import test from "node:test";
import assert from "node:assert/strict";
import {
  ollamaLineToOpenAiEvent,
  ollamaInferenceMetrics,
  openAiToOllamaBody,
  parseOllamaResponse,
  BRIDGE_CAPABILITIES,
  structuredModeFromNativeFormat
} from "../src/chat/ollamaBridge.js";

test("structuredModeFromNativeFormat classifies the exact native.format value actually sent to Ollama", () => {
  assert.equal(structuredModeFromNativeFormat({ type: "object", properties: {} }), "schema");
  assert.equal(structuredModeFromNativeFormat("json"), "json_object");
  assert.equal(structuredModeFromNativeFormat(undefined), "none");
  assert.equal(structuredModeFromNativeFormat(null), "none");
});

test("BRIDGE_CAPABILITIES advertises jsonSchema so a stale Companion (old bridge) is detectable via /api/diagnostics", () => {
  assert.equal(BRIDGE_CAPABILITIES.jsonSchema, true);
  assert.equal(BRIDGE_CAPABILITIES.disconnectCancellation, true);
  assert.equal(BRIDGE_CAPABILITIES.inferenceMetrics, true);
});

test("local bridge disables Ollama thinking and preserves generation options", () => {
  const body = openAiToOllamaBody({
    model: "tantular-office:0.4-9b",
    messages: [{ role: "user", content: "Ringkas dokumen." }],
    temperature: 0.1,
    max_tokens: 512,
    reasoning_effort: "none",
    stream: false
  });
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0.1, num_predict: 512 });
  assert.equal(body.reasoning_effort, undefined);
});

test("local bridge converts JSON mode and multimodal content for Ollama", () => {
  const body = openAiToOllamaBody({
    model: "llama3.2-vision",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Apa isi gambar?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }
      ]
    }],
    response_format: { type: "json_object" }
  });
  assert.equal(body.format, "json");
  assert.deepEqual(body.messages, [{
    role: "user",
    content: "Apa isi gambar?",
    images: ["QUJD"]
  }]);
});

test("local bridge passes a JSON Schema straight through to Ollama's native format field", () => {
  const schema = { type: "object", required: ["t"], properties: { t: { type: "string" } } };
  const body = openAiToOllamaBody({
    model: "tantular-office:0.5-9b",
    messages: [{ role: "user", content: "Susun dokumen." }],
    response_format: { type: "json_schema", json_schema: { name: "tantular_document", strict: true, schema } }
  });
  assert.deepEqual(body.format, schema, "the schema object must reach Ollama unchanged, not the string \"json\"");
});

test("json_schema takes priority if json_object is somehow also present", () => {
  const schema = { type: "object" };
  const body = openAiToOllamaBody({
    model: "m",
    messages: [],
    response_format: { type: "json_schema", json_schema: { schema } }
  });
  assert.deepEqual(body.format, schema);
});

test("native Ollama response is returned in the client response shape", () => {
  const response = parseOllamaResponse(JSON.stringify({
    model: "tantular-office:0.4-9b",
    created_at: "2026-08-21T00:00:00Z",
    message: { role: "assistant", content: "Jawaban langsung." },
    done: true,
    done_reason: "stop"
  }), 200);
  assert.equal(response.choices[0].message.content, "Jawaban langsung.");
  assert.equal(response.choices[0].finish_reason, "stop");
});

test("parseOllamaResponse echoes tantular_structured_mode when the caller supplies it, omits it otherwise", () => {
  const withMode = parseOllamaResponse(JSON.stringify({
    model: "tantular-office:0.5-9b",
    message: { role: "assistant", content: "{}" },
    done: true
  }), 200, "schema");
  assert.equal(withMode.tantular_structured_mode, "schema");

  const withoutMode = parseOllamaResponse(JSON.stringify({
    model: "tantular-office:0.5-9b",
    message: { role: "assistant", content: "hi" },
    done: true
  }), 200);
  assert.equal(withoutMode.tantular_structured_mode, undefined);
});

test("native Ollama stream becomes an OpenAI SSE content event", () => {
  const event = ollamaLineToOpenAiEvent(JSON.stringify({
    message: { role: "assistant", content: "langsung" }
  }));
  assert.deepEqual(JSON.parse(event.slice(6).trim()), {
    choices: [{ delta: { content: "langsung" } }]
  });
  assert.equal(ollamaLineToOpenAiEvent("not json"), "");
});

// --- Inference telemetry (verified fix follow-up: preserve real Ollama
// timing/token metadata so a future benchmarking pass has measured numbers
// instead of guesses). Metrics only ever come from token counts and
// durations — never prompt or response text.

test("ollamaInferenceMetrics converts nanosecond durations to ms and computes tokens/sec", () => {
  const metrics = ollamaInferenceMetrics({
    prompt_eval_count: 120,
    eval_count: 400,
    load_duration: 250_000_000,        // 250ms
    prompt_eval_duration: 900_000_000, // 900ms
    eval_duration: 20_000_000_000,     // 20s
    total_duration: 21_200_000_000     // 21.2s
  });
  assert.deepEqual(metrics, {
    promptTokens: 120,
    completionTokens: 400,
    loadDurationMs: 250,
    promptEvalDurationMs: 900,
    evalDurationMs: 20000,
    totalDurationMs: 21200,
    tokensPerSecond: 20 // 400 tokens / 20s
  });
});

test("ollamaInferenceMetrics returns null when Ollama sent no metrics fields at all", () => {
  assert.equal(ollamaInferenceMetrics({ message: { content: "hi" }, done: true }), null);
  assert.equal(ollamaInferenceMetrics(null), null);
  assert.equal(ollamaInferenceMetrics(undefined), null);
});

test("parseOllamaResponse attaches tantular_metrics on success and omits it on error", () => {
  const ok = parseOllamaResponse(JSON.stringify({
    model: "tantular-office:0.5-9b",
    message: { role: "assistant", content: "Jawaban." },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 50,
    eval_count: 200,
    eval_duration: 10_000_000_000
  }), 200);
  assert.ok(ok.tantular_metrics, "a successful response must carry metrics");
  assert.equal(ok.tantular_metrics.completionTokens, 200);
  assert.equal(ok.tantular_metrics.tokensPerSecond, 20);

  const errored = parseOllamaResponse(JSON.stringify({ error: "model not found" }), 404);
  assert.equal(errored.tantular_metrics, undefined, "an error response must not carry a metrics field");
});

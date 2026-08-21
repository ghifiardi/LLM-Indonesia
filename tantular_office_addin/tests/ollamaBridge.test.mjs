import test from "node:test";
import assert from "node:assert/strict";
import {
  ollamaLineToOpenAiEvent,
  openAiToOllamaBody,
  parseOllamaResponse
} from "../src/chat/ollamaBridge.js";

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

test("native Ollama stream becomes an OpenAI SSE content event", () => {
  const event = ollamaLineToOpenAiEvent(JSON.stringify({
    message: { role: "assistant", content: "langsung" }
  }));
  assert.deepEqual(JSON.parse(event.slice(6).trim()), {
    choices: [{ delta: { content: "langsung" } }]
  });
  assert.equal(ollamaLineToOpenAiEvent("not json"), "");
});

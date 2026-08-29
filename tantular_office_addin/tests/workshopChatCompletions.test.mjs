import test from "node:test";
import assert from "node:assert/strict";
import handler from "../workshop/api/chat-completions.js";
import { createSseAccumulator } from "../src/chat/sse.js";

function mockResponse() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.send = (text) => { res.body = text; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = () => res;
  return res;
}

function withEnv(vars, fn) {
  const original = {};
  for (const key of Object.keys(vars)) original[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(vars)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

// REGRESSION: this deployment's upstream rejects reasoning_effort with a 400
// — confirmed by reproducing it directly against the live endpoint — but the
// client's own retry-without-reasoning_effort logic (tantularClient.js) never
// gets to run, because this handler replaces the upstream's real error body
// (which would contain the word "reasoning") with a generic message before
// it reaches the client. That made EVERY Cloud Mode request fail on its one
// and only attempt. The fix is to never forward the field at all — this
// deployment already disables thinking its own way via
// chat_template_kwargs.enable_thinking.
test("chat-completions strips reasoning_effort before forwarding upstream", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] })
    };
  };
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const request = {
        method: "POST",
        body: {
          model: "tantular-office:lite",
          messages: [{ role: "user", content: "hai" }],
          reasoning_effort: "none"
        }
      };
      const response = mockResponse();
      await handler(request, response);
      assert.equal(response.statusCode, 200);
      assert.equal(capturedBody.reasoning_effort, undefined, "reasoning_effort must never reach the upstream");
      assert.equal(capturedBody.chat_template_kwargs.enable_thinking, false,
        "thinking must still be disabled via the mechanism this upstream actually accepts");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat-completions pins the server-side model regardless of the client's request", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
  };
  try {
    await withEnv(
      { TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k", TANTULAR_UPSTREAM_MODEL: "" },
      async () => {
        const request = {
          method: "POST",
          body: { model: "some-arbitrary-model", messages: [{ role: "user", content: "hai" }] }
        };
        const response = mockResponse();
        await handler(request, response);
        assert.equal(capturedBody.model, "Qwen/Qwen3.5-9B");
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// REGRESSION: every structured pipeline (EDIT_TEKS's strict "reply with
// ONLY JSON" contract, Deck/Document/Workbook Studio's schemas) depends on
// ITS OWN system prompt to get a parseable response — confirmed by
// reproducing this directly against the live endpoint: with the generic
// prompt substituted in, the model ignored the JSON-only instruction and
// answered in prose instead, breaking every structured feature in Cloud
// Mode, not just producing worse output but failing to parse at all.
test("chat-completions forwards the CLIENT's task-specific system prompt, not a generic one", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
  };
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const request = {
        method: "POST",
        body: {
          messages: [
            { role: "system", content: "Balas HANYA JSON valid dengan bentuk {\"edits\":[...]}." },
            { role: "user", content: "Perbaiki bahasa teks ini." }
          ]
        }
      };
      const response = mockResponse();
      await handler(request, response);
      assert.equal(capturedBody.messages[0].role, "system");
      assert.match(capturedBody.messages[0].content, /HANYA JSON/,
        "the pipeline's own system prompt must reach the model, not a generic substitute");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat-completions falls back to the generic system prompt when the client sends none", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
  };
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const request = { method: "POST", body: { messages: [{ role: "user", content: "hai" }] } };
      const response = mockResponse();
      await handler(request, response);
      assert.equal(capturedBody.messages[0].role, "system");
      assert.match(capturedBody.messages[0].content, /Tantular Office/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat-completions never leaks the raw upstream error body to the client", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: "reasoning_effort is not a supported parameter", account_id: "acct_secret_123" })
  });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const request = { method: "POST", body: { messages: [{ role: "user", content: "hai" }] } };
      const response = mockResponse();
      await handler(request, response);
      assert.equal(response.statusCode, 400);
      const text = JSON.stringify(response.body);
      assert.ok(!text.includes("acct_secret_123"), "must not leak upstream account detail");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat-completions refuses when upstream env vars are not configured", async () => {
  await withEnv({ TANTULAR_UPSTREAM_URL: "", TANTULAR_UPSTREAM_KEY: "" }, async () => {
    const request = { method: "POST", body: { messages: [{ role: "user", content: "hai" }] } };
    const response = mockResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
  });
});

test("chat-completions rejects a body without a messages array", async () => {
  await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
    const request = { method: "POST", body: { foo: "bar" } };
    const response = mockResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
  });
});

test("chat-completions rejects non-POST methods", async () => {
  const request = { method: "GET", body: {} };
  const response = mockResponse();
  await handler(request, response);
  assert.equal(response.statusCode, 405);
});

// The upstream reply the gateway will be converting, shaped like a real
// OpenAI-compatible non-streaming completion.
function upstreamCompletion(content) {
  return JSON.stringify({
    id: "cmpl-1",
    model: "Qwen/Qwen3.5-9B",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }
  });
}

// Collect every `data:` payload from an SSE body using the client's own parser.
function parseFrames(sseBody) {
  const acc = createSseAccumulator();
  return acc.push(sseBody).map((payload) => JSON.parse(payload));
}

// REGRESSION: seven of the eight chat pipelines go through streamedAnswer ->
// runTantularStream, which sends stream:true and reads SSE `data:` frames
// (src/chat/sse.js). The gateway forces stream:false and returned a plain JSON
// body, so no `data:` line ever appeared, the accumulated text stayed empty and
// runTantularStream threw "Model tidak mengembalikan teks." — i.e. ordinary
// chat was dead in Cloud Mode while the non-streaming structured pipelines
// worked fine, which is why it went unnoticed.
test("chat-completions re-emits a streamed request as SSE the client's parser understands", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => upstreamCompletion("Halo dunia") });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const request = {
        method: "POST",
        body: { messages: [{ role: "user", content: "hai" }], stream: true }
      };
      const response = mockResponse();
      await handler(request, response);

      assert.equal(response.statusCode, 200);
      assert.match(response.headers["Content-Type"], /text\/event-stream/);
      assert.ok(response.body.endsWith("data: [DONE]\n\n"), "stream must terminate with [DONE]");

      const frames = parseFrames(response.body);
      assert.equal(frames.length, 2, "one content frame and one final frame, before [DONE]");
      assert.equal(frames[0].choices[0].delta.content, "Halo dunia");
      assert.equal(frames[1].choices[0].finish_reason, "stop");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The shim exists so the meter never has to parse a stream (spec 4.4/4.9):
// usage must survive the conversion rather than being dropped with the
// non-streaming envelope.
test("chat-completions keeps upstream usage in the final SSE frame", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => upstreamCompletion("Halo") });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const response = mockResponse();
      await handler({ method: "POST", body: { messages: [{ role: "user", content: "hai" }], stream: true } }, response);
      const frames = parseFrames(response.body);
      assert.deepEqual(frames.at(-1).usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// runTantular (EDIT_TEKS, the intent router, Deck/Document/Workbook Studio)
// does NOT stream. Those paths work today and must keep getting plain JSON.
test("chat-completions still returns plain JSON when the client did not ask to stream", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => upstreamCompletion("Halo") });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const response = mockResponse();
      await handler({ method: "POST", body: { messages: [{ role: "user", content: "hai" }] } }, response);
      assert.equal(response.headers["Content-Type"], "application/json");
      assert.equal(JSON.parse(response.body).choices[0].message.content, "Halo");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The upstream is still called non-streaming whatever the client asked for:
// that is what keeps `usage` in-band and the meter simple.
test("chat-completions never forwards stream:true to the upstream", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, text: async () => upstreamCompletion("Halo") };
  };
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const response = mockResponse();
      await handler({ method: "POST", body: { messages: [{ role: "user", content: "hai" }], stream: true } }, response);
      assert.equal(capturedBody.stream, false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

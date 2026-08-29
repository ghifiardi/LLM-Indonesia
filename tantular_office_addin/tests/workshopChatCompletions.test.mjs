import test from "node:test";
import assert from "node:assert/strict";
import handler from "../workshop/api/chat-completions.js";

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

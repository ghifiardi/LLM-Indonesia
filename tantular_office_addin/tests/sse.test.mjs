import test from "node:test";
import assert from "node:assert/strict";
import { createSseAccumulator } from "../src/chat/sse.js";

test("parses complete data lines", () => {
  const acc = createSseAccumulator();
  const out = acc.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test("buffers payload split across chunks", () => {
  const acc = createSseAccumulator();
  assert.deepEqual(acc.push('data: {"choices":[{"del'), []);
  assert.deepEqual(acc.push('ta":{"content":"ha"}}]}\n\n'), ['{"choices":[{"delta":{"content":"ha"}}]}']);
});

test("swallows [DONE] and non-data lines", () => {
  const acc = createSseAccumulator();
  const out = acc.push(': keepalive\n\ndata: {"x":1}\n\ndata: [DONE]\n\n');
  assert.deepEqual(out, ['{"x":1}']);
});

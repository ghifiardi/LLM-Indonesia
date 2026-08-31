// The LOCAL model route must go to Ollama's native /api/chat.
//
// ollamaBridge.test.mjs proves the translation is right — think:false,
// num_predict, JSON mode, SSE. None of that helps if dev-server stops CALLING
// the native endpoint: the bridge would keep passing while the product went
// back through /v1/chat/completions, which ignores every thinking control.
//
// That is not hypothetical. On 2026-08-21 the shipped profile returned nothing
// on 7 of 10 Office edit tasks through the OpenAI-compatible path — 21,808
// characters of reasoning and an empty answer after 512 seconds — while every
// capability gate passed. The defect ran for four days.
//
// This asserts the wiring, which the module tests cannot see. It reads the
// source rather than starting a server, because dev-server binds a port at
// import time and the sandboxed suite cannot bind.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../tools/dev-server.mjs"), "utf8");

test("the local model route targets Ollama native /api/chat", () => {
  assert.match(source, /path:\s*"\/api\/chat"/,
    "dev-server must proxy the local model route to /api/chat; " +
    "/v1/chat/completions ignores think:false and the model reasons forever");
  // The literal port is now a named, overridable constant (so a cancellation
  // integration test can point it at a fake Ollama instead of colliding with
  // a real one on the dev machine) — assert its DEFAULT is still 11434, and
  // that the chat proxy actually uses that constant, not a fresh literal.
  assert.match(source, /const OLLAMA_PORT = Number\(process\.env\.TANTULAR_OLLAMA_PORT \|\| 11434\)/,
    "the Ollama upstream port must default to 11434");
  assert.match(source, /port:\s*OLLAMA_PORT/, "the local upstream must use the OLLAMA_PORT constant");
});

test("the local route does not use the OpenAI-compatible chat path", () => {
  // The string may legitimately appear in comments or in remote-gateway
  // handling; it must not appear as the local proxy's request path.
  assert.doesNotMatch(source, /path:\s*"\/v1\/chat\/completions"/,
    "a local request sent to /v1/chat/completions cannot disable thinking");
});

test("requests are translated before being sent upstream", () => {
  assert.match(source, /openAiToOllamaBody\(/,
    "the OpenAI-shaped body must be translated; sending it raw to /api/chat " +
    "would drop max_tokens and think:false");
});

// Translate the add-in's OpenAI-compatible local request into Ollama's native
// chat protocol. Ollama's /v1 endpoint accepts the request but ignores the
// thinking controls, so the local companion must use /api/chat to make
// think:false authoritative.

// 2026-08-31: a stale Companion process (started before a bridge change was
// saved to disk) silently keeps running the OLD in-memory copy of this
// module — Node does not hot-reload ES module imports. A benchmark/gate that
// assumes its just-edited bridge is live can then "prove" something about
// Ollama's behavior that was never actually exercised. Exporting the
// capability set FROM this module (rather than hardcoding a duplicate claim
// in dev-server.mjs) means /api/diagnostics always reflects whatever bridge
// implementation the running process actually has loaded, not what the
// source file on disk currently says.
export const BRIDGE_CAPABILITIES = Object.freeze({
  jsonSchema: true,
  structuredModeEcho: true,
  disconnectCancellation: true,
  inferenceMetrics: true
});

// A companionBootId alone only identifies a process instance — it says
// nothing about whether that instance predates the source code currently on
// disk (the exact ambiguity that produced one invalid reliability gate
// already). BRIDGE_REVISION is a plain string a caller can diff against the
// revision it imports from its OWN copy of this file; a mismatch means the
// running process has not loaded today's changes, full stop. Bump this any
// time this module's request/response shape changes in a way a reliability
// gate would care about.
export const BRIDGE_REVISION = "2026-08-31-structured-telemetry-v1";

export function openAiToOllamaBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages.map(openAiToOllamaMessage) : [];
  const options = {};
  if (Number.isFinite(body?.temperature)) options.temperature = body.temperature;
  if (Number.isFinite(body?.max_tokens)) options.num_predict = body.max_tokens;
  const native = {
    model: String(body?.model || "").trim(),
    messages,
    stream: Boolean(body?.stream),
    think: false,
    options
  };
  // "json_schema" carries the actual JSON Schema object straight through as
  // Ollama's native `format` — Ollama enforces the grammar itself rather than
  // merely asking for well-formed JSON, which is what "json_object" ("json")
  // does. Schema takes priority when both are somehow present.
  if (body?.response_format?.type === "json_schema") {
    native.format = body.response_format.json_schema?.schema;
  } else if (body?.response_format?.type === "json_object") {
    native.format = "json";
  }
  return native;
}

// 2026-08-31 telemetry follow-up: the client can only report what it ASKED
// for; whether Ollama actually received a schema (vs. a stale bridge process
// silently downgrading to plain "json" mode — the exact bug that invalidated
// an earlier reliability gate) is only knowable from the request the
// Companion genuinely built. dev-server.mjs calls this on the SAME
// `native.format` value it sends to Ollama, so the client-facing
// tantular_structured_mode field always reflects the real outbound request,
// not an assumption about it.
export function structuredModeFromNativeFormat(format) {
  if (format && typeof format === "object") return "schema";
  if (format === "json") return "json_object";
  return "none";
}

export function openAiToOllamaMessage(message) {
  if (!Array.isArray(message?.content)) return message;
  const text = [];
  const images = [];
  for (const part of message.content) {
    if (part?.type === "text") text.push(String(part.text || ""));
    if (part?.type === "image_url") {
      const url = String(part.image_url?.url || "");
      const comma = url.indexOf(",");
      if (url.startsWith("data:") && comma >= 0) images.push(url.slice(comma + 1));
    }
  }
  return { role: message.role, content: text.join("\n"), ...(images.length ? { images } : {}) };
}

// Ollama's non-streaming /api/chat response carries real inference timing on
// its final object — prompt/output token counts and four durations, all in
// nanoseconds — which the OpenAI-shaped response below used to just discard.
// Preserved so a future benchmarking pass has real numbers instead of
// guesses; this function only ever sees token counts and durations, never
// prompt/response text, so there is nothing sensitive to strip.
export function ollamaInferenceMetrics(data) {
  if (!data || typeof data !== "object") return null;
  const has = (key) => Number.isFinite(data[key]);
  if (!has("prompt_eval_count") && !has("eval_count") && !has("total_duration")) return null;
  const nsToMs = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : undefined);
  const evalSeconds = has("eval_duration") ? data.eval_duration / 1e9 : 0;
  return {
    promptTokens: has("prompt_eval_count") ? data.prompt_eval_count : undefined,
    completionTokens: has("eval_count") ? data.eval_count : undefined,
    loadDurationMs: nsToMs(data.load_duration),
    promptEvalDurationMs: nsToMs(data.prompt_eval_duration),
    evalDurationMs: nsToMs(data.eval_duration),
    totalDurationMs: nsToMs(data.total_duration),
    tokensPerSecond: (has("eval_count") && evalSeconds > 0)
      ? Number((data.eval_count / evalSeconds).toFixed(1))
      : undefined
  };
}

export function parseOllamaResponse(raw, status, structuredModeUsed = null) {
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return { error: { message: `Ollama mengembalikan respons tidak valid (${status}).` } };
  }
  if (status >= 400) return data;
  const metrics = ollamaInferenceMetrics(data);
  return {
    model: data.model,
    created: data.created_at,
    choices: [{
      index: 0,
      message: {
        role: data.message?.role || "assistant",
        content: data.message?.content || ""
      },
      finish_reason: data.done_reason || "stop"
    }],
    done: data.done,
    ...(metrics ? { tantular_metrics: metrics } : {}),
    ...(structuredModeUsed ? { tantular_structured_mode: structuredModeUsed } : {})
  };
}

export function ollamaLineToOpenAiEvent(line) {
  if (!line.trim()) return "";
  try {
    const data = JSON.parse(line);
    const content = data.message?.content || "";
    return content ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` : "";
  } catch {
    return "";
  }
}

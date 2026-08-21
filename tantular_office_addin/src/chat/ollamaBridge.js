// Translate the add-in's OpenAI-compatible local request into Ollama's native
// chat protocol. Ollama's /v1 endpoint accepts the request but ignores the
// thinking controls, so the local companion must use /api/chat to make
// think:false authoritative.

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
  if (body?.response_format?.type === "json_object") native.format = "json";
  return native;
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

export function parseOllamaResponse(raw, status) {
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return { error: { message: `Ollama mengembalikan respons tidak valid (${status}).` } };
  }
  if (status >= 400) return data;
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
    done: data.done
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

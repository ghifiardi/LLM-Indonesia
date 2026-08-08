// Accumulates raw SSE text from an OpenAI-compatible /v1/chat/completions
// stream and yields complete `data:` payloads. Payloads may arrive split
// across network chunks, so we buffer until a newline terminates the line.
export function createSseAccumulator() {
  let buffer = "";
  return {
    push(chunkText) {
      buffer += chunkText;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const payloads = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload && payload !== "[DONE]") payloads.push(payload);
      }
      return payloads;
    }
  };
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
const DEFAULT_MODEL = "tantular:0.2-id-3b-lora";
const DEFAULT_VISION_MODEL = "llama3.2-vision";
const SETTINGS_KEY = "tantular.office.settings.v1";

export function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      endpoint: parsed.endpoint || DEFAULT_ENDPOINT,
      model: parsed.model || DEFAULT_MODEL,
      visionModel: parsed.visionModel || DEFAULT_VISION_MODEL
    };
  } catch {
    return { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, visionModel: DEFAULT_VISION_MODEL };
  }
}

export function saveSettings(settings) {
  const current = loadSettings();
  const next = {
    endpoint: String(settings.endpoint ?? current.endpoint ?? DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
    model: String(settings.model ?? current.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    visionModel: String(settings.visionModel ?? current.visionModel ?? DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function runTantular({ system, user, maxTokens = 512, temperature = 0.1 }) {
  const { endpoint, model } = loadSettings();
  return callChat({
    endpoint,
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    maxTokens,
    temperature,
    timeoutMs: 90_000
  });
}

// Vision call: sends an image (data URL) plus a text prompt to an
// OpenAI-compatible multimodal endpoint (e.g. Ollama with llama3.2-vision,
// qwen2.5vl, or llava). Uses the standard image_url content-part format.
export async function runTantularVision({ prompt, dataUrl, maxTokens = 1400, temperature = 0.1 }) {
  const { endpoint, visionModel } = loadSettings();
  if (!dataUrl) throw new Error("Tidak ada gambar untuk dianalisis.");
  return callChat({
    endpoint,
    model: visionModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    maxTokens,
    temperature,
    timeoutMs: 180_000,
    visionModelName: visionModel
  });
}

async function callChat({ endpoint, model, messages, maxTokens, temperature, timeoutMs, visionModelName }) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (visionModelName && (response.status === 404 || /not found|no such model|try pulling/i.test(body))) {
        throw new Error(`Model vision "${visionModelName}" belum ada di Ollama. Jalankan: ollama pull ${visionModelName}`);
      }
      throw new Error(`Model endpoint gagal (${response.status}). ${body.slice(0, 240)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.message?.content ?? data?.response;
    if (!content || !String(content).trim()) {
      throw new Error("Model tidak mengembalikan teks.");
    }
    return String(content).trim();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Permintaan terlalu lama. Coba gambar lebih kecil atau model vision yang lebih ringan.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

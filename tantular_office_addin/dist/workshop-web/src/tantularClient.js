import { createSseAccumulator } from "./chat/sse.js";
import { companionUrl } from "./companionUrl.js";

const DEFAULT_ENDPOINT = companionUrl("/api/chat-completions");
const DEFAULT_MODEL = "qwen3.5:9b";
const DEFAULT_DECK_MODEL = "tantular-office:0.4-9b";
const DECK_MODEL_FALLBACK = "qwen3.5:9b";
const DEFAULT_VISION_MODEL = "llama3.2-vision";
const SETTINGS_KEY = "tantular.office.settings.v1";
const LEGACY_LOCAL_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):11434\/v1\/chat\/completions\/?$/i;

export function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      endpoint: normalizeEndpoint(parsed.endpoint),
      model: parsed.model || DEFAULT_MODEL,
      deckModel: parsed.deckModel || DEFAULT_DECK_MODEL,
      visionModel: parsed.visionModel || DEFAULT_VISION_MODEL
    };
  } catch {
    return {
      endpoint: DEFAULT_ENDPOINT,
      model: DEFAULT_MODEL,
      deckModel: DEFAULT_DECK_MODEL,
      visionModel: DEFAULT_VISION_MODEL
    };
  }
}

export function saveSettings(settings) {
  const current = loadSettings();
  const next = {
    endpoint: normalizeEndpoint(settings.endpoint ?? current.endpoint ?? DEFAULT_ENDPOINT),
    model: String(settings.model ?? current.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    deckModel: String(settings.deckModel ?? current.deckModel ?? DEFAULT_DECK_MODEL).trim() || DEFAULT_DECK_MODEL,
    visionModel: String(settings.visionModel ?? current.visionModel ?? DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function listLocalModels() {
  const response = await fetch(companionUrl("/api/models"), {
    method: "GET",
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Tidak dapat membaca daftar model Ollama (${response.status}). ${body.slice(0, 180)}`);
  }
  return normalizeModelList(await response.json());
}

export function normalizeModelList(payload) {
  const names = Array.isArray(payload?.models)
    ? payload.models.map((model) => String(model?.name || model?.model || "").trim()).filter(Boolean)
    : [];
  return [...new Set(names)].sort((a, b) => {
    const aTantular = /^tantular/i.test(a) ? 0 : 1;
    const bTantular = /^tantular/i.test(b) ? 0 : 1;
    return aTantular - bTantular || a.localeCompare(b);
  });
}

export async function testLocalModel(modelName) {
  const model = String(modelName || "").trim();
  if (!model) throw new Error("Pilih model terlebih dahulu.");
  const { endpoint } = loadSettings();
  const startedAt = Date.now();
  const text = await callChat({
    endpoint,
    model,
    messages: [
      { role: "system", content: "Anda sedang menjalankan pemeriksaan koneksi. Ikuti format pengguna secara persis." },
      { role: "user", content: "Balas persis: TANTULAR AKTIF" }
    ],
    maxTokens: 32,
    temperature: 0,
    timeoutMs: 180_000
  });
  return { model, text, latencyMs: Date.now() - startedAt };
}

// Lighter models to auto-downgrade to (in preference order) when the Studio
// model times out — typically a low-RAM machine swapping on a 9B model.
const LITE_MODEL_CANDIDATES = [
  "tantular-office:lite", "qwen3.5:4b", "qwen3:4b", "qwen2.5:3b", "llama3.2:3b", "gemma3:4b", "llama3.2:1b"
];

let autoSwitchNote = "";
// One-shot: the next UI status render consumes and clears the note.
export function consumeAutoSwitchNote() {
  const note = autoSwitchNote;
  autoSwitchNote = "";
  return note;
}

async function findInstalledLiteModel(excludeModel) {
  try {
    const names = await listLocalModels();
    return LITE_MODEL_CANDIDATES.find((name) => name !== excludeModel && names.includes(name)) || "";
  } catch {
    return "";
  }
}

export async function runTantular({
  system,
  user,
  maxTokens = 512,
  temperature = 0.1,
  signal,
  task = "general",
  jsonMode = false
}) {
  const settings = loadSettings();
  const usesOfficeModel = task === "deck" || task === "document" || task === "workbook";
  const model = usesOfficeModel ? settings.deckModel : settings.model;
  const request = {
    endpoint: settings.endpoint,
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    maxTokens,
    temperature,
    // Studio planning uses a larger local model (9B) plus long JSON output and can
    // cold-start slowly, so give it a much larger budget than short chat calls.
    // 8 minutes accommodates slow CPU-only laptops (~5-8 tok/s) on compact plans.
    timeoutMs: usesOfficeModel ? 480_000 : 90_000,
    signal,
    fallbackModel: usesOfficeModel && model === DEFAULT_DECK_MODEL ? DECK_MODEL_FALLBACK : "",
    jsonMode
  };
  try {
    return await callChat(request);
  } catch (error) {
    // Auto-downgrade: a timeout on a Studio task usually means the machine
    // cannot hold the model in RAM. Retry once with an installed lighter
    // model and persist it so every later call is fast too.
    const timedOut = /terlalu lama/i.test(String(error?.message || ""));
    if (!usesOfficeModel || !timedOut || signal?.aborted) throw error;
    const lite = await findInstalledLiteModel(model);
    if (!lite) throw error;
    const text = await callChat({ ...request, model: lite, fallbackModel: "" });
    saveSettings({ deckModel: lite });
    autoSwitchNote = `Model "${model}" terlalu lambat di perangkat ini; otomatis beralih ke "${lite}" dan disimpan sebagai Model Studio.`;
    console.warn(`[Tantular] ${autoSwitchNote}`);
    return text;
  }
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

// Ollama enables "thinking" by default for Qwen3 models on the
// OpenAI-compatible endpoint, and thinking consumes output tokens — this can
// exhaust a small max_tokens budget (e.g. the 8-token router) before any
// content lands in message.content. reasoning_effort: "none" turns thinking
// off. Some models/Ollama versions reject the field, so we build the body
// with/without it and retry once if the server complains about it.
function buildChatRequestBody({
  model,
  messages,
  temperature,
  maxTokens,
  stream,
  includeReasoning,
  includeJsonMode
}) {
  const body = { model, messages, temperature, max_tokens: maxTokens, stream };
  if (includeReasoning) body.reasoning_effort = "none";
  if (includeJsonMode) body.response_format = { type: "json_object" };
  return body;
}

function looksLikeReasoningRejection(status, bodyText) {
  return status >= 400 && status < 500 && /reasoning|think/i.test(String(bodyText ?? ""));
}

function looksLikeJsonModeRejection(status, bodyText) {
  return status >= 400 && status < 500 && /response_format|json.?object|json mode/i.test(String(bodyText ?? ""));
}

// Fetches a chat completion, retrying ONCE without reasoning_effort if the
// server rejects the field (400-level error whose body mentions
// "reasoning"/"think"). Returns { response, errorText } — errorText is set
// only when the final response is not ok (its body has already been read).
async function fetchChatCompletion(endpoint, signal, bodyParams) {
  const attempt = async (includeReasoning, includeJsonMode) => {
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildChatRequestBody({
        ...bodyParams,
        includeReasoning,
        includeJsonMode
      }))
    });
    if (response.ok) return { response, errorText: null };
    const errorText = await response.text().catch(() => "");
    return { response, errorText };
  };

  let includeReasoning = true;
  let includeJsonMode = Boolean(bodyParams.jsonMode);
  let result = await attempt(includeReasoning, includeJsonMode);
  for (let retries = 0; !result.response.ok && retries < 2; retries += 1) {
    if (includeReasoning && looksLikeReasoningRejection(result.response.status, result.errorText)) {
      includeReasoning = false;
      result = await attempt(includeReasoning, includeJsonMode);
      continue;
    }
    if (includeJsonMode && looksLikeJsonModeRejection(result.response.status, result.errorText)) {
      includeJsonMode = false;
      result = await attempt(includeReasoning, includeJsonMode);
      continue;
    }
    break;
  }
  return result;
}

async function callChat({
  endpoint,
  model,
  messages,
  maxTokens,
  temperature,
  timeoutMs,
  visionModelName,
  signal,
  fallbackModel = "",
  jsonMode = false
}) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { response, errorText } = await fetchChatCompletion(endpoint, controller.signal, {
      model, messages, temperature, maxTokens, stream: false, jsonMode
    });

    if (!response.ok) {
      const body = errorText ?? "";
      if (fallbackModel && fallbackModel !== model && looksLikeMissingModel(response.status, body)) {
        return callChat({
          endpoint,
          model: fallbackModel,
          messages,
          maxTokens,
          temperature,
          timeoutMs,
          visionModelName,
          signal,
          jsonMode
        });
      }
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
      if (visionModelName) {
        throw new Error("Permintaan vision terlalu lama. Coba gambar lebih kecil atau model vision yang lebih ringan.");
      }
      throw new Error("Permintaan model lokal terlalu lama. Coba lagi setelah model selesai dimuat, atau pilih model yang lebih cepat.");
    }
    if (endpoint !== DEFAULT_ENDPOINT && isNetworkLoadFailure(error)) {
      return callChat({
        endpoint: DEFAULT_ENDPOINT,
        model,
        messages,
        maxTokens,
        temperature,
        timeoutMs,
        visionModelName,
        signal,
        fallbackModel,
        jsonMode
      });
    }
    if (isNetworkLoadFailure(error)) {
      throw new Error("Load failed: Tantular tidak bisa menghubungi model lokal melalui dev server. Pastikan `npm run dev` dan Ollama masih berjalan, lalu coba lagi.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function looksLikeMissingModel(status, bodyText) {
  return status === 404 || /model.+(?:not found|does not exist)|no such model|try pulling/i.test(String(bodyText || ""));
}

export async function runTantularStream({ system, user, messages, maxTokens = 1024, temperature = 0.3, onToken, signal }) {
  const { endpoint, model } = loadSettings();
  const bodyParams = {
    model,
    messages: messages ?? [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature,
    maxTokens,
    stream: true
  };
  let response, errorText;
  try {
    ({ response, errorText } = await fetchChatCompletion(endpoint, signal, bodyParams));
  } catch (error) {
    if (error?.name === "AbortError") {
      const stopped = new Error("dihentikan");
      stopped.partialText = "";
      throw stopped;
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    const text = errorText ?? await response.text().catch(() => "");
    throw new Error(`Model endpoint gagal (${response.status}). ${text.slice(0, 240)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const acc = createSseAccumulator();
  let full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of acc.push(decoder.decode(value, { stream: true }))) {
        let delta = "";
        try {
          delta = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? "";
        } catch { /* partial junk from server; skip */ }
        if (delta) {
          full += delta;
          onToken?.(delta);
        }
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      const stopped = new Error("dihentikan");
      stopped.partialText = full;
      throw stopped;
    }
    throw error;
  }
  if (!full.trim()) throw new Error("Model tidak mengembalikan teks.");
  return full.trim();
}

function normalizeEndpoint(value) {
  const endpoint = String(value ?? "").trim();
  if (!endpoint || LEGACY_LOCAL_ENDPOINT_RE.test(endpoint)) return DEFAULT_ENDPOINT;
  return endpoint;
}

function isNetworkLoadFailure(error) {
  const message = String(error?.message || error || "");
  return error instanceof TypeError || /load failed|failed to fetch|networkerror|network request failed/i.test(message);
}

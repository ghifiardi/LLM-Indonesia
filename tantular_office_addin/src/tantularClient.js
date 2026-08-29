import { createSseAccumulator } from "./chat/sse.js";
import {
  assertCompanionAvailable,
  companionUrl,
  insideOffice,
  loadMode,
  saveMode
} from "./companionUrl.js";

// Resolved LAZILY, never at module load. Office.js sets Office.context.host
// only after onReady, and this module is imported long before that — so a
// constant evaluated here would look like "not inside Office" even inside
// PowerPoint, and would default every installed user to the hosted portal
// gateway. That would send their document text off-machine while the product
// still claimed to run locally. Call it, do not cache it.
function defaultEndpoint() {
  return companionUrl("/api/chat-completions");
}
// Chat defaults to the Tantular profile, like Studio does. This was
// "qwen3.5:9b" — the raw base model, carrying none of the Tantular system
// prompt — so every fresh install answered as stock Qwen while the product
// said Tantular, and on a machine without that base model pulled it failed
// outright with Ollama's "model 'qwen3.5:9b' not found".
const DEFAULT_MODEL = "tantular-office:0.5-9b";
// Used when the Tantular profile is not installed on this machine. Studio has
// always had this; chat did not, so a missing model surfaced as a raw 404.
const CHAT_MODEL_FALLBACK = "qwen3.5:9b";
// Q8_0 profile, published as ghifidanukusumo/tantular:latest and installed
// under this alias. The 0.4 alias was Q4_K_M, which scores 37/40 on the voice
// gate against a 0.95 bar; Q8 scores 38/40 and matches bf16. Existing installs
// keep working — 0.4 stays in the preference list below the new default.
const DEFAULT_DECK_MODEL = "tantular-office:0.5-9b";
const DECK_MODEL_FALLBACK = "qwen3.5:9b";
const DEFAULT_VISION_MODEL = "llama3.2-vision";
const SETTINGS_KEY = "tantular.office.settings.v1";
const LEGACY_LOCAL_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):11434\/v1\/chat\/completions\/?$/i;
const LOCAL_COMPANION_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):3000\//i;
// Saved settings from earlier installs point at retired default models and
// would otherwise silently keep users on them forever. Only EXACT old defaults
// migrate — a deliberately chosen custom model is never touched.
const RETIRED_MODEL_DEFAULTS = new Map([
  ["tantular-office:0.3-8b", DEFAULT_DECK_MODEL],
  ["qwen3:8b", DEFAULT_MODEL],
  // The previous chat default. Nobody picked stock Qwen for a Tantular
  // product on purpose; it was simply what shipped.
  ["qwen3.5:9b", DEFAULT_MODEL],
  // Old low-RAM quick-fix value: keep those machines on the lite alias, never
  // auto-upgrade them to a 9B they can't run.
  ["qwen3:4b", "tantular-office:lite"]
]);

function migrateRetiredModel(value, fallback) {
  const model = String(value || "").trim();
  if (!model) return fallback;
  return RETIRED_MODEL_DEFAULTS.get(model) || model;
}

export function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      // Read from its own key, never from the settings blob — see loadMode().
      mode: loadMode(),
      endpoint: normalizeEndpoint(parsed.endpoint),
      model: migrateRetiredModel(parsed.model, DEFAULT_MODEL),
      deckModel: migrateRetiredModel(parsed.deckModel, DEFAULT_DECK_MODEL),
      visionModel: parsed.visionModel || DEFAULT_VISION_MODEL,
      apiKey: String(parsed.apiKey || "").trim()
    };
  } catch {
    return {
      mode: loadMode(),
      endpoint: defaultEndpoint(),
      model: DEFAULT_MODEL,
      deckModel: DEFAULT_DECK_MODEL,
      visionModel: DEFAULT_VISION_MODEL,
      apiKey: ""
    };
  }
}

export function saveSettings(settings) {
  // Mode is persisted FIRST and separately: defaultEndpoint()/normalizeEndpoint()
  // below both resolve against the active mode, so a mode change has to be in
  // effect before the endpoint is re-derived. Switching mode therefore heals a
  // stale endpoint in either direction instead of stranding the pane on the
  // wrong one.
  const mode = settings.mode === undefined ? loadMode() : saveMode(settings.mode);
  const current = loadSettings();
  const next = {
    endpoint: normalizeEndpoint(settings.endpoint ?? current.endpoint ?? defaultEndpoint()),
    model: String(settings.model ?? current.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    deckModel: String(settings.deckModel ?? current.deckModel ?? DEFAULT_DECK_MODEL).trim() || DEFAULT_DECK_MODEL,
    visionModel: String(settings.visionModel ?? current.visionModel ?? DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL,
    // Empty string is a meaningful value here (clears the key), so only fall
    // back to the stored one when the caller omits the field entirely.
    apiKey: String(settings.apiKey ?? current.apiKey ?? "").trim()
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  // Deliberately NOT stored in the settings blob — see loadMode(). Returned so
  // callers can render the active mode without a second read.
  return { ...next, mode };
}

export async function listLocalModels() {
  // Companion-only: the hosted gateway has no /api/models to enumerate.
  assertCompanionAvailable("Daftar model Ollama");
  // A companion that accepts the connection but never answers leaves this
  // awaiting forever: the dropdown stays on "Memuat daftar model..." with no
  // error, the catch that would show the real models never runs, and the user
  // is then told to run `npm run model:office` for models that are installed.
  // Observed exactly that in PowerPoint on Mac. Never fetch the companion
  // without a deadline.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response;
  try {
    response = await fetch(companionUrl("/api/models"), {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        "Companion tidak menjawab dalam 12 detik. Pastikan jendela Tantular Companion "
        + "masih terbuka (npm start), lalu klik Refresh."
      );
    }
    throw new Error(
      `Tidak dapat menghubungi Companion: ${error?.message || error}. `
      + "Pastikan Tantular Companion berjalan (npm start)."
    );
  } finally {
    clearTimeout(timeout);
  }
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
  const { endpoint, apiKey } = loadSettings();
  const startedAt = Date.now();
  const text = await callChat({
    endpoint,
    apiKey,
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
    apiKey: settings.apiKey,
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
    //
    // task "edit" (EDIT_TEKS, e.g. "Perbaiki bahasa" on a large selection)
    // stays on the small/fast chat model even on constrained machines — that
    // is the point of "lite" — but it still has to produce one JSON edit per
    // sentence in the selection, so a big selection is long structured output
    // on possibly slow hardware, same shape of problem as Studio, just with a
    // faster model. 90s was measured too short for that combination even on
    // a capable machine; give it real headroom without going all the way to
    // Studio's 8 minutes, since "lite" is chosen specifically to be fast.
    timeoutMs: usesOfficeModel ? 480_000 : task === "edit" ? 240_000 : 90_000,
    signal,
    fallbackModel: model === (usesOfficeModel ? DEFAULT_DECK_MODEL : DEFAULT_MODEL)
      ? (usesOfficeModel ? DECK_MODEL_FALLBACK : CHAT_MODEL_FALLBACK)
      : "",
    jsonMode
  };
  try {
    return await callChat(request);
  } catch (error) {
    // Auto-downgrade, two triggers:
    // - A timeout on a Studio task usually means the machine cannot hold that
    //   model in RAM.
    // - "model not found" means the configured model was never installed
    //   here at all — settings pointing at a default that a RAM-constrained
    //   install never pulled (that install only builds "lite"), a settings
    //   reset (e.g. cleared site data), or a fresh profile. This used to be
    //   a dead end for chat/edit tasks: request.fallbackModel retries with
    //   qwen3.5:9b, but a machine that only ever installed "lite" doesn't
    //   have THAT either, so the fallback 404s too and the raw error reached
    //   the user with no way to recover short of manually reconfiguring.
    // Either way: retry once with whatever Tantular model IS actually
    // installed, and persist it so every later call already has it right.
    const message = String(error?.message || "");
    const timedOut = /terlalu lama/i.test(message);
    const missingModel = /not found|no such model|try pulling/i.test(message);
    if (signal?.aborted || !((usesOfficeModel && timedOut) || missingModel)) throw error;
    const lite = await findInstalledLiteModel(model);
    if (!lite) throw error;
    const text = await callChat({ ...request, model: lite, fallbackModel: "" });
    if (usesOfficeModel) {
      saveSettings({ deckModel: lite });
      autoSwitchNote = missingModel
        ? `Model "${model}" tidak ditemukan di perangkat ini; otomatis beralih ke "${lite}" dan disimpan sebagai Model Studio.`
        : `Model "${model}" terlalu lambat di perangkat ini; otomatis beralih ke "${lite}" dan disimpan sebagai Model Studio.`;
    } else {
      saveSettings({ model: lite });
      autoSwitchNote = `Model "${model}" tidak ditemukan di perangkat ini; otomatis beralih ke "${lite}" dan disimpan sebagai Model umum/chat.`;
    }
    console.warn(`[Tantular] ${autoSwitchNote}`);
    return text;
  }
}

// Vision call: sends an image (data URL) plus a text prompt to an
// OpenAI-compatible multimodal endpoint (e.g. Ollama with llama3.2-vision,
// qwen2.5vl, or llava). Uses the standard image_url content-part format.
export async function runTantularVision({ prompt, dataUrl, maxTokens = 1400, temperature = 0.1 }) {
  const { endpoint, visionModel, apiKey } = loadSettings();
  if (!dataUrl) throw new Error("Tidak ada gambar untuk dianalisis.");
  return callChat({
    endpoint,
    apiKey,
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

// Models enable "thinking" by default and it consumes output tokens — that can
// exhaust a small max_tokens budget (e.g. the 4-token router) before any
// content lands in message.content, so every request asks for it off.
//
// HOW you ask differs by model family, and getting it wrong fails silently:
// the request succeeds, thinking stays on, and short-budget calls return empty.
//
//  - Qwen3/Qwen3.5 on Ollama honour the `reasoning_effort` request field.
//  - Harmony-format models (Muse Glimmer, gpt-oss) ignore it entirely. Their
//    thinking level is a CHAT TEMPLATE variable — `reasoning_strength`,
//    defaulting to "high" — so it has to travel in `chat_template_kwargs`.
//    Verified against muse-glimmer:30b: its chat_template.jinja reads
//    `set rs = reasoning_strength if reasoning_strength is defined ... else 'high'`,
//    and ~230 tokens go to reasoning before the first content token.
//
// Detection is by model name because that is all the client knows before the
// first request. An unknown model gets the Qwen path, which is the existing
// behaviour and is harmless where unsupported (the field is ignored, and the
// caller already retries without it if a server rejects it outright).
const HARMONY_MODEL_RE = /muse-glimmer|gpt-oss|harmony/i;

export function reasoningControlFor(model) {
  return HARMONY_MODEL_RE.test(String(model || "")) ? "chat_template" : "request_field";
}

function applyReasoningOff(body, model) {
  if (reasoningControlFor(model) === "chat_template") {
    // "low" rather than "none": the template interpolates this verbatim into
    // "Reasoning strength: {rs}.", and only the documented levels are safe to
    // assert. Low is the minimum that keeps the sentence meaningful.
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), reasoning_strength: "low" };
    return body;
  }
  body.reasoning_effort = "none";
  return body;
}

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
  if (includeReasoning) applyReasoningOff(body, model);
  if (includeJsonMode) body.response_format = { type: "json_object" };
  return body;
}

function looksLikeReasoningRejection(status, bodyText) {
  return status >= 400 && status < 500
    && /reasoning|think|chat_template_kwargs/i.test(String(bodyText ?? ""));
}

function looksLikeJsonModeRejection(status, bodyText) {
  return status >= 400 && status < 500 && /response_format|json.?object|json mode/i.test(String(bodyText ?? ""));
}

// Fetches a chat completion, retrying ONCE without reasoning_effort if the
// server rejects the field (400-level error whose body mentions
// "reasoning"/"think"). Returns { response, errorText } — errorText is set
// only when the final response is not ok (its body has already been read).
// Hosted OpenAI-compatible gateways (LiteLLM, vLLM, OpenRouter…) need a bearer
// token; a plain local Ollama does not. The key is only ever attached to an
// endpoint the user configured — never to the bundled local companion proxy,
// which talks to Ollama on this machine and has no use for a credential.
export function buildChatHeaders(endpoint, apiKey) {
  const headers = { "Content-Type": "application/json" };
  const key = String(apiKey || "").trim();
  if (key && endpoint !== defaultEndpoint()) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function fetchChatCompletion(endpoint, signal, bodyParams, apiKey = "") {
  const attempt = async (includeReasoning, includeJsonMode) => {
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: buildChatHeaders(endpoint, apiKey),
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
  jsonMode = false,
  apiKey = ""
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
    }, apiKey);

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
          jsonMode,
          apiKey
        });
      }
      if (visionModelName && (response.status === 404 || /not found|no such model|try pulling/i.test(body))) {
        throw new Error(`Model vision "${visionModelName}" belum ada di Ollama. Jalankan: ollama pull ${visionModelName}`);
      }
      throw new Error(endpointErrorMessage(response.status, body, model));
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
    // Falling back to the local companion is a kindness when a custom LOCAL
    // endpoint is down. But when an API key is set the user deliberately chose
    // a remote gateway, and silently answering from a local model instead
    // would look like success while coming from an entirely different model.
    // Fail loudly there instead.
    if (endpoint !== defaultEndpoint() && !apiKey && isNetworkLoadFailure(error)) {
      return callChat({
        endpoint: defaultEndpoint(),
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

// A bare "gagal (401)" tells the user nothing about which of the two auth
// mistakes they made, and both are common the first time the pane is pointed
// at a gateway: a wrong key, or a key that is fenced to other models.
export function endpointErrorMessage(status, bodyText, model = "") {
  const body = String(bodyText || "").slice(0, 160);
  if (status === 401) {
    return `Endpoint menolak API key (401). Periksa API key di Pengaturan. ${body}`.trim();
  }
  if (status === 403) {
    return `API key tidak diizinkan memakai model "${model}" (403). Minta admin gateway menambahkan model ini ke key Anda. ${body}`.trim();
  }
  return `Model endpoint gagal (${status}). ${String(bodyText || "").slice(0, 240)}`.trim();
}

function looksLikeMissingModel(status, bodyText) {
  return status === 404 || /model.+(?:not found|does not exist)|no such model|try pulling/i.test(String(bodyText || ""));
}

export async function runTantularStream({ system, user, messages, maxTokens = 1024, temperature = 0.3, onToken, signal }) {
  const { endpoint, model, apiKey } = loadSettings();
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
    ({ response, errorText } = await fetchChatCompletion(endpoint, signal, bodyParams, apiKey));
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
    throw new Error(endpointErrorMessage(response.status, text, model));
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
  if (!endpoint || LEGACY_LOCAL_ENDPOINT_RE.test(endpoint)) return defaultEndpoint();
  // The portal and the installed add-in are the SAME origin, so they share
  // localStorage. Someone who tries the portal saves a relative endpoint
  // ("/api/chat-completions" → the hosted gateway); opening the real add-in
  // later would restore that value and quietly send their document off-machine.
  // Inside Office a relative endpoint is never a legitimate saved choice — a
  // saved string is never treated as consent. The ONLY thing that can route an
  // Office session to the gateway is the mode record (loadMode), which portal
  // use cannot forge. So: drop the stored value and re-derive from the mode.
  // In local mode that yields the absolute localhost companion (guard intact);
  // in a deliberate cloud session it yields the same-origin gateway.
  if (insideOffice() && endpoint.startsWith("/")) return defaultEndpoint();
  // Mirror guard: a cloud session must not keep talking to a localhost
  // companion left over from local mode — nothing is listening there.
  if (insideOffice() && loadMode() === "cloud" && LOCAL_COMPANION_RE.test(endpoint)) {
    return defaultEndpoint();
  }
  return endpoint;
}

function isNetworkLoadFailure(error) {
  const message = String(error?.message || error || "");
  return error instanceof TypeError || /load failed|failed to fetch|networkerror|network request failed/i.test(message);
}

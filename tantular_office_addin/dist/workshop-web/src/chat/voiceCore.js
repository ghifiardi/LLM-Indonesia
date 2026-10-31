// Pure helpers for local push-to-talk in the Word chat. No DOM, no fetch — the
// pieces here decide WHERE voice traffic may go and shape the audio/text, so
// they are unit-tested directly (tests/voiceCore.test.mjs).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_COMPANION_ORIGIN = "https://localhost:3000";

function hostIsLocal(hostname) {
  return LOCAL_HOSTS.has(String(hostname || "").toLowerCase());
}

// Voice routes exist ONLY on the local companion. Unlike companionUrl(), this
// never returns a same-origin path on a hosted page: on the published pane a
// relative "/api/voice/..." would hit the cloud gateway, so audio would leave
// the Mac. Local page → same origin; any other page → the localhost companion.
export function voiceUrl(pathname, pageHostname = globalThis.location?.hostname) {
  const path = String(pathname || "").startsWith("/") ? String(pathname) : `/${pathname}`;
  return hostIsLocal(pageHostname) || !pageHostname ? path : `${LOCAL_COMPANION_ORIGIN}${path}`;
}

export function endpointIsLocal(endpoint, pageHostname = globalThis.location?.hostname) {
  const value = String(endpoint || "").trim();
  if (!value) return false;
  if (value.startsWith("/")) return !pageHostname || hostIsLocal(pageHostname);
  try {
    return hostIsLocal(new URL(value).hostname);
  } catch {
    return false;
  }
}

// The gate for every voice turn. The transcript is sent through the normal
// chat flow, so voice is local only if that flow's model endpoint is local
// too. Cloud mode, the browser portal, or a custom remote endpoint each block
// voice outright — there is no "send it anyway" path.
export function voiceBlockReason({ cloudSession, portal, endpoint, pageHostname = globalThis.location?.hostname }) {
  if (cloudSession) {
    return "Mode suara dimatikan karena sesi ini memakai Mode Cloud. Suara hanya berjalan lokal di Mac ini — beralih ke Mode Lokal di Pengaturan untuk memakainya.";
  }
  if (portal) return "Mode suara hanya tersedia di add-in Office dengan Tantular Companion lokal.";
  if (!endpointIsLocal(endpoint, pageHostname)) {
    return "Mode suara dimatikan karena endpoint model di Pengaturan bukan model lokal. Suara hanya dikirim ke model di komputer ini.";
  }
  return "";
}

export function downsample(samples, inputRate, outputRate = 16000) {
  if (outputRate >= inputRate) return Float32Array.from(samples);
  const ratio = inputRate / outputRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    // Box-filter average over the source window: cheap anti-aliasing that is
    // plenty for speech recognition.
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export function encodeWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

export function concatFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Markdown read aloud is noise ("bintang bintang", "pipa"). Keep the words,
// drop the markup; tables are summarized rather than read cell by cell.
const MAX_SPOKEN_CHARS = 1200;
export function speakableText(markdown, language = "id") {
  const lines = String(markdown || "").split(/\r?\n/);
  const out = [];
  let sawTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^---+$/.test(line)) continue;
    if (/^\|.*\|$/.test(line)) {
      if (!sawTable) out.push(language === "en" ? "The table is shown on screen." : "Tabelnya ada di layar.");
      sawTable = true;
      continue;
    }
    out.push(line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-•*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .trim());
  }
  let text = out.filter(Boolean).map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`)).join(" ");
  if (text.length > MAX_SPOKEN_CHARS) {
    const cut = text.slice(0, MAX_SPOKEN_CHARS);
    const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    text = `${sentenceEnd > 200 ? cut.slice(0, sentenceEnd + 1) : cut} ${language === "en" ? "The rest is on screen." : "Selengkapnya ada di layar."}`;
  }
  return text;
}

const ID_WORDS = new Set(["yang", "dan", "di", "ini", "itu", "dengan", "untuk", "tidak", "dari", "ke", "pada", "adalah", "saya", "anda", "akan", "bisa", "atau", "juga", "dalam", "sudah"]);
const EN_WORDS = new Set(["the", "and", "is", "this", "that", "with", "for", "not", "from", "to", "of", "are", "you", "will", "can", "or", "also", "in", "has", "have"]);

// The reply is voiced in the language it is written in, which can differ from
// the language the user spoke (the chat prompts are Indonesian-first).
export function replyLanguage(text, fallback = "id") {
  let id = 0;
  let en = 0;
  for (const word of String(text || "").toLowerCase().match(/[a-z]+/g) || []) {
    if (ID_WORDS.has(word)) id += 1;
    if (EN_WORDS.has(word)) en += 1;
  }
  if (id === en) return fallback === "en" ? "en" : "id";
  return id > en ? "id" : "en";
}

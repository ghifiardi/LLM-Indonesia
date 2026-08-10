// Tantular Deck Studio — image → structured text extraction (OCR/vision).
// Prefers Apple Vision OCR (via the local doc-server, macOS-only) for raw
// text fidelity, and falls back to the local multimodal model — the vision
// path — for structuring and on any platform where Apple Vision isn't
// available (this is the entire Windows story; that path is unchanged).

import { runTantularVision } from "../tantularClient.js";
import { companionUrl } from "../companionUrl.js";

const OCR_URL = companionUrl("/api/ocr");

// --- Pure, injectable decision/orchestration logic -------------------------
// Kept dependency-free (no DOM/network) so it is unit-testable in isolation
// per the mocked capability/failure coverage mandate.

// probeStatus is whatever the probe() call resolved to, e.g.
// { ok: true, engine: "apple-vision" } or { ok: false, error }.
export function chooseOcrEngine({ probeStatus } = {}) {
  return probeStatus && probeStatus.ok ? "apple-vision" : "model";
}

// probe/ocrCall/modelCall are injectable async functions so this can be
// exercised with stubs instead of real fetch/DOM. Always resolves — Apple
// Vision failures (probe-absent or mid-request) transparently fall back to
// the model-vision path, which must keep behaving exactly as it does today.
export async function extractWithFallback({ probe, ocrCall, modelCall }) {
  let probeStatus = { ok: false };
  try {
    probeStatus = await probe();
  } catch {
    probeStatus = { ok: false };
  }

  const engine = chooseOcrEngine({ probeStatus });
  if (engine === "apple-vision") {
    try {
      const text = await ocrCall();
      return { text: String(text || "").trim(), engine: "apple-vision" };
    } catch {
      // Apple Vision failed mid-request (server crashed, image rejected,
      // etc.) — fall through to the model path below.
    }
  }

  const text = await modelCall();
  return { text: String(text || "").trim(), engine: "model" };
}

// Wraps a probe function so it only ever runs once per session (memoized).
// A rejected/failed probe call is cached too (Windows/no-doc-server keeps
// resolving to "model" without re-probing on every image).
export function memoizeOcrProbe(probeFn) {
  let cached;
  let pending;
  return async function memoizedProbe(...args) {
    if (cached) return cached;
    if (!pending) {
      pending = Promise.resolve()
        .then(() => probeFn(...args))
        .then(
          (result) => {
            cached = result;
            pending = null;
            return result;
          },
          (err) => {
            pending = null;
            throw err;
          }
        );
    }
    return pending;
  };
}

// Status-line formatter for the engine actually used.
export function ocrStatusLine(engine) {
  return engine === "apple-vision" ? "Ekstraksi teks: Apple Vision" : "Ekstraksi teks: model vision";
}

let lastOcrEngine = null;
export function getLastOcrEngine() {
  return lastOcrEngine;
}

const EXTRACT_PROMPT = `Anda adalah Tantular Vision Extractor untuk produktivitas Office. Analisis gambar slide/diagram ini secara menyeluruh.
Mode aktif: EKSTRAKSI VISUAL / PRODUKTIVITAS PRESENTASI, bukan mode keamanan/fraud.

Tugas:
- Baca SEMUA teks yang terlihat (judul, subjudul, label grup, item, catatan kaki, legenda).
- Kenali struktur/pengelompokan (misalnya kolom, kotak domain, kategori).
- Jika ada legenda warna (misalnya hijau/teal, kuning, abu-abu), petakan warna ke status dan terapkan ke tiap item.
- Jangan mengarang item yang tidak ada di gambar.
- Jika teks kecil/tidak terbaca, tulis "TIDAK TERBACA" untuk bagian tersebut, bukan menebak.
- Jangan menilai gambar sebagai spam/scam/cyber/fraud kecuali teks gambar eksplisit meminta klasifikasi keamanan.
- Dilarang memakai konteks dari percakapan/prompt sebelumnya; hanya gunakan isi gambar.

Format keluaran (Bahasa Indonesia, teks biasa, tanpa markdown tabel):
JUDUL: <judul slide>
SUBJUDUL: <subjudul bila ada>
LEGENDA: <arti tiap warna bila ada>
GRUP:
- <Nama Grup>: <item1> (<status>), <item2> (<status>), ...
- <Nama Grup>: ...
CATATAN: <catatan kaki/keterangan bila ada>

Tulis selengkap mungkin dan akurat sesuai isi gambar.`;

// Raw capability probe — hits the local doc-server once; wrapped in
// memoizeOcrProbe below so it only ever runs once per session.
async function rawProbeOcrCapability() {
  const response = await fetch(OCR_URL, { method: "GET" });
  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload && payload.ok) {
    return { ok: true, engine: payload.engine || "apple-vision" };
  }
  return { ok: false, error: (payload && payload.error) || `OCR probe gagal (${response.status}).` };
}

const probeOcrCapability = memoizeOcrProbe(rawProbeOcrCapability);

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

// Calls the local doc-server's Apple Vision OCR endpoint and returns the
// recognized text (lines joined). Throws on any failure so extractWithFallback
// can catch it and fall back to the model-vision path.
async function runAppleVisionOcr(dataUrl) {
  const blob = await dataUrlToBlob(dataUrl);
  const form = new FormData();
  form.append("file", blob, "slide.png");
  const response = await fetch(OCR_URL, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error((payload && payload.error) || `Apple Vision OCR gagal (${response.status}).`);
  }
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const text = payload.text || lines.map((l) => l.text).join("\n");
  return String(text || "").trim();
}

export async function extractSlideFromImage(dataUrl, extraInstruction = "") {
  const prompt = extraInstruction
    ? `${EXTRACT_PROMPT}\n\nInstruksi tambahan: ${extraInstruction}`
    : EXTRACT_PROMPT;
  const result = await extractWithFallback({
    probe: () => probeOcrCapability(),
    ocrCall: () => runAppleVisionOcr(dataUrl),
    modelCall: () => runTantularVision({ prompt, dataUrl, maxTokens: 1600, temperature: 0.1 })
  });
  lastOcrEngine = result.engine;
  return result.text;
}

// Read a File/Blob into a data URL usable by the vision endpoint.
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error("Tidak ada file gambar.")); return; }
    if (!/^image\//i.test(file.type)) { reject(new Error("File harus berupa gambar (PNG/JPG).")); return; }
    if (file.size > 12 * 1024 * 1024) { reject(new Error("Gambar terlalu besar (maks 12 MB).")); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Gagal membaca file gambar."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

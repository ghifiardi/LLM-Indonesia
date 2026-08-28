// Tantular Deck Studio — planner.
// Turns a raw brief into a validated DeckSpec. The model proposes structure;
// this module extracts/repairs JSON and always returns a usable spec.

import { runTantular } from "../tantularClient.js";

export const SLIDE_TYPES = [
  "title",
  "agenda",
  "bullets",
  "cards",
  "columns",
  "metrics",
  "quote",
  "visualization",
  "closing"
];

const PLANNER_SYSTEM = `Anda adalah Tantular Deck Studio, perancang struktur presentasi yang privat dan Indonesian-first.
Tugas Anda: mengubah brief/teks/dokumen menjadi RENCANA DECK yang bermakna dan rapi.
Aturan:
- Jawab HANYA dengan satu objek JSON valid. Tanpa penjelasan, tanpa markdown, tanpa teks lain.
- Semua teks slide dalam Bahasa Indonesia yang jelas dan profesional (terjemahkan bila input Inggris).
- Buat alur cerita: pembuka, isi yang terstruktur, dan penutup dengan rekomendasi/next step.
- Jangan mengarang angka. Jika brief tidak punya data, hindari slide "metrics".
- Jika instruksi pengguna meminta visualisasi, gunakan slide type "visualization" dengan chartType yang sesuai.
- Jika instruksi pengguna meminta executive summary atau methodology notes, buat slide khusus untuk itu.
- Bullet singkat dan padat (maksimum ~14 kata).`;

function plannerUser({ brief, slideCount, tone, instruction }) {
  return `Buat rencana deck dari brief berikut.

Jumlah slide target: ${slideCount}.
Nuansa/tone: ${tone || "profesional, jelas, rapi"}.
Instruksi tambahan: ${instruction || "tidak ada"}.
Anggap instruksi tambahan sebagai PROJECT SPEC yang harus dipatuhi (style guide, output format, warna brand, chart preference, methodology, dan deliverables).

Skema JSON WAJIB:
{
  "title": "judul deck",
  "subtitle": "subjudul singkat",
  "slides": [
    { "type": "title", "headline": "...", "subhead": "..." },
    { "type": "agenda", "headline": "...", "bullets": ["...", "..."] },
    { "type": "bullets", "headline": "...", "bullets": ["...", "..."] },
    { "type": "cards", "headline": "...", "cards": [ { "title": "...", "desc": "..." } ] },
    { "type": "columns", "headline": "...", "columns": [ { "title": "...", "points": ["..."] } ] },
    { "type": "metrics", "headline": "...", "metrics": [ { "value": "...", "label": "..." } ] },
    { "type": "quote", "headline": "kutipan/pesan kunci", "subhead": "atribusi opsional" },
    { "type": "visualization", "headline": "...", "chartType": "bar|line|heatmap", "data": [ { "label": "...", "value": 0 } ], "bullets": ["insight 1"] },
    { "type": "closing", "headline": "...", "bullets": ["rekomendasi/next step"] }
  ]
}

Tipe slide yang boleh dipakai: ${SLIDE_TYPES.join(", ")}.
Slide pertama harus "title". Slide terakhir harus "closing".
Kembalikan HANYA JSON.

Brief:
"""${brief}"""`;
}

export async function planDeck({ brief, slideCount = 6, tone = "", instruction = "" }) {
  const count = clampCount(slideCount);
  let raw = "";
  try {
    raw = await runTantular({
      system: PLANNER_SYSTEM,
      user: plannerUser({ brief, slideCount: count, tone, instruction }),
      maxTokens: 1600,
      temperature: 0.25
    });
  } catch (error) {
    return { spec: fallbackDeck(brief, count), source: "fallback", error: error?.message || String(error) };
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { spec: fallbackDeck(brief, count), source: "fallback" };
  }
  return { spec: normalizeSpec(parsed, brief, count), source: "model" };
}

// --- JSON extraction / repair ------------------------------------------------

export function extractJsonObject(text) {
  const str = String(text || "");
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const start = str.indexOf("{");
  const end = str.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(str.slice(start, end + 1));
  candidates.push(str);

  for (const candidate of candidates) {
    const cleaned = candidate
      .replace(/^\uFEFF/, "")
      .replace(/,\s*([}\]])/g, "$1"); // tolerate trailing commas
    try {
      const value = JSON.parse(cleaned);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try next candidate
    }
    // Small models sometimes drop closing brackets or emit stray closers.
    const repaired = repairJsonStructure(candidate);
    if (repaired) {
      try {
        const value = JSON.parse(repaired);
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch {
        // give up on this candidate
      }
    }
  }
  return null;
}

// Tolerant structural repair: keep only balanced brackets/braces (string-aware),
// drop stray closers, and append any missing closers at the end.
export function repairJsonStructure(text) {
  const str = String(text || "");
  const start = str.indexOf("{");
  if (start === -1) return null;

  let out = "";
  const stack = [];
  let inStr = false;
  let esc = false;

  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); out += ch; continue; }
    if (ch === "}") {
      if (stack[stack.length - 1] === "{") { stack.pop(); out += ch; }
      continue; // drop stray closer
    }
    if (ch === "]") {
      if (stack[stack.length - 1] === "[") { stack.pop(); out += ch; }
      continue; // drop stray closer
    }
    out += ch;
  }

  out = out.replace(/,\s*$/, "");
  while (stack.length) {
    const open = stack.pop();
    out += open === "{" ? "}" : "]";
  }
  return out;
}

// --- Normalization -----------------------------------------------------------

function normalizeSpec(spec, brief, count) {
  const title = str(spec.title) || firstLine(brief) || "Presentasi Tantular";
  const subtitle = str(spec.subtitle) || "Dibuat dengan Tantular Deck Studio";

  let slides = Array.isArray(spec.slides) ? spec.slides.map(normalizeSlide).filter(Boolean) : [];
  if (!slides.length) return fallbackDeck(brief, count);

  // Ensure the deck opens with a title and closes with a closing slide.
  if (slides[0].type !== "title") {
    slides.unshift({ type: "title", headline: title, subhead: subtitle });
  } else {
    slides[0].headline = slides[0].headline || title;
    slides[0].subhead = slides[0].subhead || subtitle;
  }
  if (slides[slides.length - 1].type !== "closing") {
    slides.push({ type: "closing", headline: "Kesimpulan & Langkah Berikutnya", bullets: defaultClosing() });
  }

  // Cap slide count while keeping the closing slide.
  const max = clampCount(count);
  if (slides.length > max) {
    const closing = slides[slides.length - 1];
    slides = slides.slice(0, max - 1);
    slides.push(closing);
  }

  return { title, subtitle, slides };
}

function normalizeSlide(slide) {
  if (!slide || typeof slide !== "object") return null;
  let type = String(slide.type || "bullets").toLowerCase().trim();
  if (!SLIDE_TYPES.includes(type)) type = "bullets";

  const out = {
    type,
    headline: str(slide.headline) || str(slide.title) || "",
    subhead: str(slide.subhead) || ""
  };

  if (type === "bullets" || type === "agenda" || type === "closing") {
    out.bullets = toStringList(slide.bullets || slide.points).slice(0, 7);
    if (!out.bullets.length && type === "closing") out.bullets = defaultClosing();
    if (!out.bullets.length) out.bullets = ["(Isi poin di sini.)"];
  }

  if (type === "cards") {
    out.cards = toObjectList(slide.cards, "title", "desc").slice(0, 8);
    if (!out.cards.length) out.type = "bullets", out.bullets = ["(Tambahkan kartu konten.)"];
  }

  if (type === "columns") {
    out.columns = (Array.isArray(slide.columns) ? slide.columns : [])
      .map((col) => ({
        title: str(col?.title) || "",
        points: toStringList(col?.points || col?.bullets).slice(0, 6)
      }))
      .filter((col) => col.title || col.points.length)
      .slice(0, 3);
    if (!out.columns.length) out.type = "bullets", out.bullets = ["(Tambahkan kolom konten.)"];
  }

  if (type === "metrics") {
    out.metrics = toObjectList(slide.metrics, "value", "label").slice(0, 4);
    if (!out.metrics.length) out.type = "bullets", out.bullets = ["(Tambahkan metrik.)"];
  }

  if (type === "visualization") {
    out.chartType = str(slide.chartType || slide.kind || "bar").toLowerCase();
    out.data = normalizeChartData(slide.data || slide.values).slice(0, 8);
    out.bullets = toStringList(slide.bullets || slide.insights).slice(0, 5);
    if (!out.data.length) out.type = "bullets", out.bullets = out.bullets.length ? out.bullets : ["(Tambahkan data visualisasi.)"];
  }

  if (!out.headline) out.headline = titleForType(type);
  return out;
}

// --- Fallback deck (no model / bad JSON) ------------------------------------

export function fallbackDeck(brief, count) {
  const text = String(brief || "").trim();
  const title = firstLine(text) || "Presentasi Tantular";
  const chunks = splitIntoChunks(text);
  const bodyCount = Math.max(2, clampCount(count) - 2);

  const slides = [{ type: "title", headline: title, subhead: "Dibuat dengan Tantular Deck Studio" }];
  const perSlide = Math.ceil(Math.max(1, chunks.length) / bodyCount);
  for (let i = 0; i < bodyCount; i += 1) {
    const bullets = chunks.slice(i * perSlide, (i + 1) * perSlide);
    if (!bullets.length) break;
    slides.push({ type: "bullets", headline: `Bagian ${i + 1}`, bullets: bullets.slice(0, 6) });
  }
  slides.push({ type: "closing", headline: "Kesimpulan & Langkah Berikutnya", bullets: defaultClosing() });
  return { title, subtitle: "Dibuat dengan Tantular Deck Studio", slides };
}

// --- helpers -----------------------------------------------------------------

function clampCount(n) {
  const value = Number(n) || 6;
  return Math.min(12, Math.max(3, Math.round(value)));
}

function str(value) {
  return value == null ? "" : String(value).trim();
}

function toStringList(value) {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/\r?\n|•|- /).map((v) => str(v)).filter(Boolean);
  }
  return [];
}

function normalizeChartData(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === "object") {
      const label = str(item.label || item.name || item.category);
      const raw = String(item.value ?? item.score ?? item.amount ?? "").replace(/[^0-9.-]/g, "");
      const n = Number(raw);
      return label && Number.isFinite(n) ? { label, value: n } : null;
    }
    return null;
  }).filter(Boolean);
}

function toObjectList(value, keyA, keyB) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (item && typeof item === "object") {
        return { [keyA]: str(item[keyA]) || str(item.title) || str(item.name), [keyB]: str(item[keyB]) || str(item.text) || str(item.desc) };
      }
      return { [keyA]: str(item), [keyB]: "" };
    })
    .filter((item) => item[keyA] || item[keyB]);
}

function firstLine(text) {
  const line = String(text || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return "";
  return line.length > 90 ? line.slice(0, 87) + "..." : line;
}

function splitIntoChunks(text) {
  const parts = String(text || "")
    .split(/(?<=[.!?])\s+|\r?\n+|;\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
  return parts.map((p) => (p.length > 120 ? p.slice(0, 117) + "..." : p));
}

function defaultClosing() {
  return [
    "Ringkas poin utama dan dampaknya.",
    "Tentukan pemilik dan tenggat setiap aksi.",
    "Sepakati langkah tindak lanjut berikutnya."
  ];
}

function titleForType(type) {
  const map = {
    title: "Judul",
    agenda: "Agenda",
    bullets: "Poin Utama",
    cards: "Komponen Utama",
    columns: "Perbandingan",
    metrics: "Metrik Kunci",
    quote: "Pesan Kunci",
    visualization: "Visualisasi Data",
    closing: "Kesimpulan & Langkah Berikutnya"
  };
  return map[type] || "Slide";
}

const REVAMP_SYSTEM = `Anda adalah Tantular Slide Revamp Director, desainer presentasi eksekutif yang Indonesian-first.
Tugas Anda: merombak satu slide yang padat/kurang rapi menjadi slide baru atau mini-deck yang lebih bermakna, bersih, dan siap presentasi.
Aturan:
- Jawab HANYA dengan satu objek JSON valid. Tanpa markdown dan tanpa teks lain.
- Semua teks slide dalam Bahasa Indonesia profesional.
- Jangan hanya menyalin isi; ubah menjadi narasi eksekutif: konteks, struktur, insight, gap, dan rekomendasi.
- Untuk slide yang sangat padat, pecah menjadi 3-6 slide agar lebih mudah dipahami.
- Jangan mengarang angka/fakta baru. Jika status/detail tidak jelas, tulis sebagai area yang perlu divalidasi.
- Gunakan slide type cards/columns/bullets/closing untuk hasil yang visual.`;

function revampUser({ slideText, slideCount, tone, instruction, mode }) {
  const modeText = mode || "mini-deck eksekutif dari slide saat ini";
  return `Revamp slide berikut menjadi ${modeText}.

Jumlah slide target: ${slideCount}.
Nuansa/tone: ${tone || "eksekutif, rapi, jelas, visual"}.
Instruksi tambahan: ${instruction || "tidak ada"}.

Skema JSON WAJIB sama seperti DeckSpec:
{
  "title": "judul deck hasil revamp",
  "subtitle": "subjudul singkat",
  "slides": [
    { "type": "title", "headline": "...", "subhead": "..." },
    { "type": "agenda", "headline": "...", "bullets": ["...", "..."] },
    { "type": "cards", "headline": "...", "cards": [ { "title": "...", "desc": "..." } ] },
    { "type": "columns", "headline": "...", "columns": [ { "title": "...", "points": ["..."] } ] },
    { "type": "bullets", "headline": "...", "bullets": ["...", "..."] },
    { "type": "closing", "headline": "...", "bullets": ["..."] }
  ]
}

Tipe slide yang boleh dipakai: ${SLIDE_TYPES.join(", ")}.
Slide pertama harus "title". Slide terakhir harus "closing".
Kembalikan HANYA JSON.

Isi slide / deskripsi slide:
"""${slideText}"""`;
}

export async function planRevampSlide({ slideText, slideCount = 5, tone = "", instruction = "", mode = "" }) {
  const count = clampCount(slideCount);
  const source = String(slideText || "").trim();
  if (!source) {
    return {
      spec: revampFallbackDeck("Slide Revamp", "Isi slide tidak terbaca otomatis. Tempel teks/deskripsi slide lalu jalankan ulang.", count),
      source: "fallback",
      error: "Isi slide kosong."
    };
  }

  let raw = "";
  try {
    raw = await runTantular({
      system: REVAMP_SYSTEM,
      user: revampUser({ slideText: source, slideCount: count, tone, instruction, mode }),
      maxTokens: 1700,
      temperature: 0.28
    });
  } catch (error) {
    return { spec: revampFallbackDeck(firstLine(source) || "Slide Revamp", source, count), source: "fallback", error: error?.message || String(error) };
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { spec: revampFallbackDeck(firstLine(source) || "Slide Revamp", source, count), source: "fallback" };
  }
  return { spec: normalizeSpec(parsed, source, count), source: "model" };
}

export function revampFallbackDeck(title, sourceText, count) {
  const chunks = splitIntoChunks(sourceText);
  const slides = [
    { type: "title", headline: title || "Revamp Slide", subhead: "Versi desain ulang oleh Tantular Deck Studio" },
    {
      type: "cards",
      headline: "Struktur Konten Utama",
      cards: chunks.slice(0, 6).map((chunk, i) => ({ title: `Area ${i + 1}`, desc: chunk }))
    },
    {
      type: "columns",
      headline: "Dari Slide Padat ke Narasi Eksekutif",
      columns: [
        { title: "Masalah desain", points: ["Terlalu banyak detail dalam satu halaman", "Hierarki informasi sulit dibaca", "Perlu pemisahan insight dan aksi"] },
        { title: "Arah revamp", points: ["Kelompokkan domain utama", "Tampilkan status/gap secara ringkas", "Akhiri dengan rekomendasi prioritas"] }
      ]
    },
    { type: "closing", headline: "Rekomendasi Lanjutan", bullets: defaultClosing() }
  ];
  const max = clampCount(count);
  return { title: title || "Revamp Slide", subtitle: "Versi desain ulang", slides: slides.slice(0, max) };
}

// Deterministic single-slide redesign for "thin" input (e.g. only a header was
// readable because the slide is an image). Avoids turning a title into a
// meaningless multi-slide fallback deck.
export function buildTitleSlideSpec(text) {
  const lines = String(text || "")
    .split(/\r?\n|(?<=\S) - (?=\S)/)
    .map((l) => l.trim())
    .filter(Boolean);
  const headline = lines[0] || "Judul Slide";
  const subhead = lines.slice(1).join(" — ") || "Versi judul yang dirapikan oleh Tantular Deck Studio";
  return {
    title: headline,
    subtitle: subhead,
    slides: [{ type: "title", headline, subhead }]
  };
}

export function isThinContent(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const words = value.split(/\s+/).filter(Boolean);
  return value.length < 220 || lines.length <= 2 || words.length < 28;
}

// --- Optional section summarization (uses the local Tantular text model) ------

const SUMMARIZE_SYSTEM = `Anda adalah Tantular, peringkas bagian presentasi yang privat dan Indonesian-first.
Aturan:
- Ringkas isi menjadi 3-5 bullet Bahasa Indonesia yang padat dan jelas (maksimum ~16 kata per bullet).
- Pertahankan istilah teknis, angka, dan nama penting. Jangan menambah fakta baru.
- Format wajib: tiap baris diawali "- ". Tanpa JSON, tanpa penjelasan lain.`;

function summarizeUser(headline, bullets, tone, instruction) {
  const body = (bullets || []).map((b) => `- ${b}`).join("\n");
  return `Ringkas bagian "${headline}" berikut menjadi 3-5 bullet Bahasa Indonesia yang padat.
Tone: ${tone || "profesional, jelas"}.
${instruction ? `Instruksi tambahan: ${instruction}` : ""}

Isi bagian:
${body}`;
}

export async function summarizeSlideBullets(headline, bullets, tone = "", instruction = "") {
  if (!bullets || !bullets.length) return bullets || [];
  let raw;
  try {
    raw = await runTantular({
      system: SUMMARIZE_SYSTEM,
      user: summarizeUser(headline, bullets, tone, instruction),
      maxTokens: 400,
      temperature: 0.2
    });
  } catch {
    return bullets; // keep original on failure — reliability first
  }
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\d+[.)]\s*/, "").replace(/^(?:[-•*]\s*)+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
  // Reliability guard: only accept the summary if it produced at least two
  // reasonable bullets; otherwise keep the original extractive bullets.
  const usable = lines.filter((l) => l.length >= 12);
  return usable.length >= 2 ? usable : bullets;
}

export async function summarizeDeckSections(spec, tone = "", instruction = "", onProgress = () => {}) {
  if (!spec?.slides?.length) return spec;
  const targets = spec.slides.filter((s) => s.type === "bullets");
  let done = 0;
  const slides = [];
  for (const slide of spec.slides) {
    if (slide.type === "bullets") {
      // eslint-disable-next-line no-await-in-loop
      const bullets = await summarizeSlideBullets(slide.headline, slide.bullets, tone, instruction);
      slides.push({ ...slide, bullets });
      done += 1;
      onProgress(done, targets.length);
    } else {
      slides.push(slide);
    }
  }
  return { ...spec, slides };
}

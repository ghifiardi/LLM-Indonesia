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

const PLANNER_SYSTEM = `Anda adalah Tantular Deck Studio Productivity, perancang struktur presentasi yang privat dan Indonesian-first.
Mode aktif: PRODUKTIVITAS PRESENTASI, bukan mode keamanan/fraud.
Tugas Anda: mengubah brief/teks/dokumen menjadi RENCANA DECK yang bermakna dan rapi.
Aturan:
- Jawab HANYA dengan satu objek JSON valid. Tanpa penjelasan, tanpa markdown, tanpa teks lain.
- Semua teks slide dalam Bahasa Indonesia yang jelas dan profesional (terjemahkan bila input Inggris).
- Buat alur cerita: pembuka, isi yang terstruktur, dan penutup dengan rekomendasi/next step.
- Jangan mengarang angka. Jika brief tidak punya data, hindari slide "metrics".
- Jangan mengarang nama negara, organisasi, studi kasus, kutipan, sumber, atau benchmark yang tidak ada di brief. Jika contoh diminta tetapi tidak tersedia, tandai "perlu validasi" tanpa membuat fakta baru.
- Jika instruksi pengguna meminta visualisasi, gunakan slide type "visualization" dengan chartType yang sesuai.
- Jika instruksi pengguna meminta executive summary atau methodology notes, buat slide khusus untuk itu.
- Jangan menolak atau menilai brief sebagai di luar scope hanya karena bukan topik scam/spam/cybersecurity.
- Jangan mengubah deck umum menjadi deck keamanan/fraud/compliance kecuali brief atau instruksi eksplisit meminta analisis keamanan, risiko keamanan, fraud, scam, phishing, compliance, atau cyber.
- Jika brief berisi kata "risk/risiko" dalam konteks bisnis/proyek/operasional, perlakukan sebagai risiko domain tersebut, bukan otomatis cybersecurity.
- Bullet singkat dan padat (maksimum ~14 kata).
- Jumlah objek di array "slides" HARUS TEPAT sesuai target. Hitung sebelum menjawab.`;

// A brief that is itself an instruction ("Kamu adalah konsultan… Buatlah 20
// slide tentang…") must be EXECUTED, not summarized: without this, the planner
// (and especially the fallback) quotes the prompt back as slide content.
export function briefLooksLikeInstruction(brief) {
  const value = String(brief || "").trim();
  if (!value) return false;
  const persona = /^["'“”]?\s*(kamu|anda|you)\s+(adalah|bertindak|are|act)/i.test(value);
  const imperative = /\b(buat(?:lah|kan)?|susun(?:lah|kan)?|rancang(?:lah)?|create|make|design)\b[\s\S]{0,120}\b(slide|deck|presentasi|presentation)\b/i.test(value);
  return persona || imperative;
}

function plannerUser({ brief, slideCount, finalSlideCount, tone, instruction }) {
  const briefNote = briefLooksLikeInstruction(brief)
    ? `PENTING: "Brief" di bawah adalah INSTRUKSI/PERINTAH dari pengguna, bukan teks sumber.
JALANKAN instruksinya: karang isi slide yang diminta secara utuh dan substantif.
JANGAN mengutip, memparafrase, atau menampilkan kalimat instruksi itu di slide mana pun (termasuk judul).

`
    : "";
  return `${briefNote}SCOPE AKTIF: DECK / OFFICE PRODUCTIVITY.
Kerjakan sebagai pembuatan presentasi. Jangan mengalihkan ke scam/spam/cybersecurity kecuali brief atau instruksi eksplisit meminta analisis keamanan/fraud/cyber.
Jika kata risk/risiko muncul, gunakan konteks sumber; jangan otomatis menafsirkannya sebagai cybersecurity.

Buat rencana deck dari brief berikut.

Jumlah slide inti yang harus Anda keluarkan: TEPAT ${slideCount}. Array "slides" wajib berisi tepat ${slideCount} objek.
Target deck akhir: ${finalSlideCount}. Compiler lokal akan memecah slide inti yang padat sampai target akhir, jadi berikan 2-6 poin/card/kolom yang bermakna pada setiap slide isi.
Jika target besar, gunakan ruang itu untuk cakupan yang lebih kaya: lebih banyak subtopik, section, contoh, metodologi, risiko, rekomendasi, dan next step. Jangan memadatkan semua konten ke sedikit slide.
Nuansa/tone: ${tone || "profesional, jelas, rapi"}.
Instruksi tambahan: ${instruction || "tidak ada"}.
Anggap instruksi tambahan sebagai PROJECT SPEC yang harus dipatuhi (style guide, visual direction, output format, warna brand, chart preference, methodology, dan deliverables).

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
  // Small local models become slow and structurally fragile when asked to emit
  // 20-30 slide objects in one response. Ask for a dense 12-slide core, then
  // split its content deterministically to the exact requested count.
  const modelCount = Math.min(count, 12);
  const requestPlan = (coreCount) => runTantular({
    system: PLANNER_SYSTEM,
    user: plannerUser({
      brief,
      slideCount: coreCount,
      finalSlideCount: count,
      tone,
      instruction
    }),
    maxTokens: tokenBudgetForSlideCount(coreCount),
    temperature: 0.25,
    task: "deck",
    jsonMode: true
  });
  let raw = "";
  try {
    raw = await requestPlan(modelCount);
  } catch (error) {
    // Slow (CPU-only / low-RAM) machines can time out purely on output
    // length. Retry once with a compact core plan — roughly half the tokens;
    // the deterministic splitter still expands it to the requested count.
    const timedOut = /terlalu lama/i.test(String(error?.message || ""));
    const compactCount = Math.min(4, modelCount);
    if (!timedOut || compactCount >= modelCount) {
      return { spec: fallbackDeck(brief, count), source: "fallback", error: error?.message || String(error) };
    }
    try {
      raw = await requestPlan(compactCount);
    } catch (retryError) {
      return { spec: fallbackDeck(brief, count), source: "fallback", error: retryError?.message || String(retryError) };
    }
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

  slides = expandSlidesToCount(slides, max);
  return { title, subtitle, slides };
}

export function expandSlidesToCount(slides, targetCount) {
  const target = clampCount(targetCount);
  const result = Array.isArray(slides) ? slides.map((slide) => ({ ...slide })) : [];
  if (result.length > target) {
    const closing = result.at(-1);
    return closing?.type === "closing"
      ? [...result.slice(0, target - 1), closing]
      : result.slice(0, target);
  }
  if (result.length === target) return result;

  while (result.length < target) {
    let bestIndex = -1;
    let bestUnits = 1;
    for (let i = 1; i < result.length - 1; i += 1) {
      const units = slideUnitCount(result[i]);
      if (units > bestUnits) {
        bestUnits = units;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;
    const parts = splitSlide(result[bestIndex]);
    if (!parts) break;
    result.splice(bestIndex, 1, ...parts);
  }
  return result.slice(0, target);
}

function slideUnitCount(slide) {
  if (!slide || slide.type === "title" || slide.type === "closing" || slide.type === "quote") return 0;
  if (slide.type === "cards") return slide.cards?.length || 0;
  if (slide.type === "columns") return slide.columns?.length || 0;
  if (slide.type === "metrics") return slide.metrics?.length || 0;
  return slide.bullets?.length || 0;
}

function splitSlide(slide) {
  const type = slide?.type;
  const key = type === "cards"
    ? "cards"
    : type === "columns"
      ? "columns"
      : type === "metrics"
        ? "metrics"
        : "bullets";
  const items = Array.isArray(slide?.[key]) ? slide[key] : [];
  if (items.length < 2) return null;

  const cut = Math.ceil(items.length / 2);
  const firstItems = items.slice(0, cut);
  const secondItems = items.slice(cut);
  if (!secondItems.length) return null;

  const secondLabel = splitSlideLabel(type, secondItems);
  const secondType = type === "agenda" ? "bullets" : type;
  return [
    { ...slide, [key]: firstItems },
    {
      ...slide,
      type: secondType,
      headline: secondLabel || `${slide.headline || titleForType(type)} — Lanjutan`,
      subhead: slide.subhead ? `${slide.subhead} · lanjutan` : "",
      [key]: secondItems
    }
  ];
}

function splitSlideLabel(type, items) {
  if (type === "agenda") {
    const labels = items.map((item) => str(item)).filter(Boolean).slice(0, 2);
    if (labels.length) return labels.join(" & ");
  }
  if (type === "cards" || type === "columns") {
    const labels = items.map((item) => str(item?.title)).filter(Boolean).slice(0, 2);
    if (labels.length) return labels.join(" & ");
  }
  if (type === "metrics") {
    const labels = items.map((item) => str(item?.label)).filter(Boolean).slice(0, 2);
    if (labels.length) return labels.join(" & ");
  }
  return "";
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
    if (!out.data.length) {
      const cards = toObjectList(slide.cards, "title", "desc").slice(0, 8);
      const columns = (Array.isArray(slide.columns) ? slide.columns : [])
        .map((col) => ({
          title: str(col?.title) || "",
          points: toStringList(col?.points || col?.bullets).slice(0, 6)
        }))
        .filter((col) => col.title || col.points.length)
        .slice(0, 3);
      if (cards.length) {
        out.type = "cards";
        out.cards = cards;
      } else if (columns.length) {
        out.type = "columns";
        out.columns = columns;
      } else {
        out.type = "bullets";
        out.bullets = out.bullets.length ? out.bullets : ["(Tambahkan data visualisasi.)"];
      }
      delete out.data;
      delete out.chartType;
    }
  }

  if (!out.headline) out.headline = titleForType(type);
  return out;
}

// --- Fallback deck (no model / bad JSON) ------------------------------------

export function fallbackDeck(brief, count) {
  const text = String(brief || "").trim();
  // Chunking an instruction-style brief produces a deck that quotes the
  // user's prompt as slides. Be honest instead: this needs the model.
  if (briefLooksLikeInstruction(text)) {
    return {
      title: "Model Studio diperlukan",
      subtitle: "Brief berbentuk instruksi tidak bisa disusun tanpa model",
      slides: [
        {
          type: "title",
          headline: "Model Studio diperlukan",
          subhead: "Brief Anda berupa instruksi; penyusun sederhana tidak bisa mengarang isinya."
        },
        {
          type: "bullets",
          headline: "Cara memperbaiki",
          bullets: [
            "Pastikan aplikasi Ollama dan Tantular Companion berjalan.",
            "Buka Pengaturan model lokal, lalu klik Tes model terpilih.",
            "Setelah model merespons, klik Buat Deck lagi.",
            "Alternatif: tempel konten/materi (bukan perintah) di kotak Teks/seleksi."
          ]
        }
      ]
    };
  }
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
  return Math.min(30, Math.max(3, Math.round(value)));
}

function tokenBudgetForSlideCount(count) {
  return Math.min(6400, Math.max(1600, 900 + clampCount(count) * 220));
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
  if (looksLikePresentationBrief(value)) return false;
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const words = value.split(/\s+/).filter(Boolean);
  return value.length < 220 && (lines.length <= 2 || words.length < 28);
}

export function looksLikePresentationBrief(text) {
  const value = String(text || "").toLowerCase();
  const presentationSignal = /\b(deck|slide|slides|presentasi|powerpoint|pptx|keynote)\b/i.test(value);
  const creationSignal = /\b(buat|buatlah|susun|rancang|desain|design|create|prepare|generate|jadikan)\b/i.test(value);
  const specificationSignal = /\b(audiens|audience|tujuan|objective|tone|gaya|style|narasi|story|roadmap|agenda|speaker)\b/i.test(value);
  return presentationSignal && creationSignal && specificationSignal;
}

export function inferRequestedSlideCount(text) {
  const value = String(text || "").toLowerCase();
  const numeric = value.match(/\b(?:buat(?:lah)?|susun|rancang|create|prepare|generate)?[\s\S]{0,40}?(\d{1,2})\s*(?:slide|slides|halaman\s+presentasi)\b/i)
    || value.match(/\b(?:slide|slides)\s*(?:sebanyak|berjumlah|total|count|:)?\s*(\d{1,2})\b/i);
  if (numeric) return clampCount(Number(numeric[1]));

  const numberWords = new Map([
    ["tiga puluh", 30],
    ["dua puluh sembilan", 29],
    ["dua puluh delapan", 28],
    ["dua puluh tujuh", 27],
    ["dua puluh enam", 26],
    ["dua puluh lima", 25],
    ["dua puluh empat", 24],
    ["dua puluh tiga", 23],
    ["dua puluh dua", 22],
    ["dua puluh satu", 21],
    ["dua puluh", 20],
    ["sembilan belas", 19],
    ["delapan belas", 18],
    ["tujuh belas", 17],
    ["enam belas", 16],
    ["lima belas", 15],
    ["empat belas", 14],
    ["tiga belas", 13],
    ["dua belas", 12],
    ["sebelas", 11],
    ["sepuluh", 10],
    ["sembilan", 9],
    ["delapan", 8],
    ["tujuh", 7],
    ["enam", 6],
    ["lima", 5],
    ["empat", 4],
    ["tiga", 3]
  ]);
  for (const [words, count] of numberWords) {
    const pattern = new RegExp(`\\b${words.replace(/ /g, "\\s+")}\\s+(?:slide|slides|halaman\\s+presentasi)\\b`, "i");
    if (pattern.test(value)) return count;
  }
  return 0;
}

// --- Optional section summarization (uses the local Tantular text model) ------

const SUMMARIZE_SYSTEM = `Anda adalah Tantular Office Productivity, peringkas bagian presentasi yang privat dan Indonesian-first.
Mode aktif: PRODUKTIVITAS PRESENTASI, bukan mode keamanan/fraud.
Aturan:
- Ringkas isi menjadi 3-5 bullet Bahasa Indonesia yang padat dan jelas (maksimum ~16 kata per bullet).
- Pertahankan istilah teknis, angka, dan nama penting. Jangan menambah fakta baru.
- Jangan menolak atau mengalihkan ke scope keamanan/fraud kecuali teks bagian eksplisit meminta analisis keamanan/fraud.
- Format wajib: tiap baris diawali "- ". Tanpa JSON, tanpa penjelasan lain.`;

function summarizeUser(headline, bullets, tone, instruction) {
  const body = (bullets || []).map((b) => `- ${b}`).join("\n");
  return `SCOPE AKTIF: DECK / OFFICE PRODUCTIVITY.
Ringkas sebagai konten presentasi. Jangan mengalihkan ke analisis keamanan/fraud kecuali bagian ini eksplisit meminta itu.

Ringkas bagian "${headline}" berikut menjadi 3-5 bullet Bahasa Indonesia yang padat.
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
      temperature: 0.2,
      task: "deck"
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

// --- Improve Existing Deck --------------------------------------------------
// A single, grounded workflow for complex existing decks. It improves the
// selected slide without inventing facts, and returns a one-slide DeckSpec that
// can be inserted beside the original slide.

const IMPROVE_SLIDE_SYSTEM = `Anda adalah Tantular Deck Studio Productivity, editor slide eksekutif yang source-grounded.
Mode aktif: PRODUKTIVITAS PRESENTASI, bukan mode keamanan/fraud.
Tugas: memperbaiki SATU slide PowerPoint yang sudah ada agar lebih jelas, rapi, dan sesuai style guide.
Aturan kualitas WAJIB:
- SUMBER KONTEN HANYA teks slide sumber di bawah. Jangan mengambil ide/konten dari style guide, instruksi project, atau pengetahuan umum.
- Jangan menambah fakta, angka, benchmark, target, nama produk, istilah, atau kesimpulan yang tidak ada di teks slide sumber.
- Setiap bullet/card/kolom harus bisa ditelusuri ke kalimat/frasa di teks slide sumber. Jika ragu, buang.
- Style guide/instruksi project HANYA mengatur gaya visual & tone (warna, layout, nada bahasa), BUKAN menambah konten baru.
- Pertahankan topik dan subjek slide asli. Jangan mengganti judul menjadi topik lain.
- Jangan menilai slide sebagai di luar scope hanya karena bukan cyber/fraud/security.
- Jangan mengubah slide umum menjadi mitigasi keamanan/fraud/compliance kecuali teks slide sumber memang berisi itu.
- Jika user meminta perbandingan/benchmark tetapi datanya tidak ada, tulis sebagai kebutuhan data/validasi, bukan sebagai fakta.
- Gunakan chart/visualization HANYA jika teks slide berisi angka eksplisit yang bisa dipakai.
- Jika tidak ada angka eksplisit, gunakan bullets/cards/columns saja.
- Pertahankan istilah teknis dan angka asli.
- Jawab HANYA dengan satu objek JSON valid. Tanpa markdown/teks lain.

Skema:
{
  "title": "judul deck singkat",
  "slide": {
    "type": "bullets|cards|columns|visualization",
    "headline": "judul slide yang lebih kuat",
    "subhead": "opsional: catatan singkat bahwa versi ini berbasis sumber",
    "bullets": ["..."],
    "cards": [ { "title": "...", "desc": "..." } ],
    "columns": [ { "title": "...", "points": ["..."] } ],
    "chartType": "bar|line|heatmap",
    "data": [ { "label": "...", "value": 0 } ]
  }
}`;

export async function improveExistingSlide({ slideText, tone = "", instruction = "" }) {
  const source = String(slideText || "").trim();
  if (!source) return { spec: null, source: "empty" };

  let raw = "";
  try {
    raw = await runTantular({
      system: IMPROVE_SLIDE_SYSTEM,
      user: `SCOPE AKTIF: DECK / OFFICE PRODUCTIVITY.
Perbaiki slide sebagai slide presentasi. Jangan mengalihkan ke analisis keamanan/fraud/compliance kecuali teks slide sumber eksplisit berisi itu.
Jika kata risk/risiko muncul, gunakan konteks slide sumber; jangan otomatis menafsirkannya sebagai cybersecurity.

Perbaiki slide terpilih berikut menjadi SATU slide yang lebih jelas dan executive.
Tone: ${tone || "profesional, jelas, executive"}.
Style guide / instruksi project:
"""${instruction || "tidak ada"}"""

Jangan membuat data baru. Jika data tidak cukup untuk chart, gunakan bullet/cards/columns.

Teks slide sumber:
"""${source}"""`,
      maxTokens: 1200,
      temperature: 0.18,
      task: "deck",
      jsonMode: true
    });
  } catch (error) {
    return { spec: improveFallbackSpec(source), source: "fallback", error: error?.message || String(error) };
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) return { spec: improveFallbackSpec(source), source: "fallback" };

  const candidate = parsed.slide || parsed.slides?.[0] || parsed;
  let slide = normalizeSlide(candidate);
  slide = enforceSourceGrounding(slide, source);

  if (!slide || !hasSubstantiveSlideContent(slide)) {
    return { spec: improveFallbackSpec(source), source: "fallback-grounded" };
  }

  const title = keepGroundedText(str(parsed.title), extractNumbers(source), buildSourceLexicon(source)) || slide.headline || firstLine(source) || "Improved Slide";
  return {
    spec: {
      title,
      subtitle: "Improved from selected slide; source-grounded",
      slides: [slide]
    },
    source: "model-grounded"
  };
}

function improveFallbackSpec(source) {
  const riskSummary = riskSummaryByChannelFallback(source);
  if (riskSummary) return riskSummary;

  const headline = firstLine(source) || "Improved Slide";
  const bullets = splitIntoChunks(source)
    .filter((chunk) => chunk.length >= 8)
    .slice(0, 6);
  return {
    title: headline,
    subtitle: "Source-grounded fallback",
    slides: [{
      type: "bullets",
      headline,
      subhead: "Dirapikan dari teks slide asli; tanpa menambah fakta baru.",
      bullets: bullets.length ? bullets : ["Tambahkan teks slide yang lebih lengkap untuk perbaikan bermakna."]
    }]
  };
}

function riskSummaryByChannelFallback(source) {
  const lines = String(source || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const channelRe = /^(.+?)\s*::\s*((?:LOW|MEDIUM|HIGH)\s+RISK)$/i;
  const channels = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(channelRe);
    if (match) {
      current = { title: `${match[1].trim()} :: ${match[2].toUpperCase()}`, lines: [] };
      channels.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (channels.length < 2) return null;

  const columns = channels.slice(0, 3).map((channel) => ({
    title: channel.title,
    points: compactRiskPoints(channel.lines).slice(0, 6)
  })).filter((channel) => channel.title || channel.points.length);

  if (!columns.length) return null;
  const headline = lines.find((line) => !channelRe.test(line)) || "Risk Summary by Channel";
  return {
    title: "Risk Summary by Channel",
    subtitle: "Source-grounded fallback",
    slides: [{
      type: "columns",
      headline,
      subhead: "Disederhanakan dari teks slide asli; tanpa menambah fakta baru.",
      columns
    }]
  };
}

function compactRiskPoints(lines) {
  const statusRe = /^(OK|Risk|Low|Medium|High|Partial)\s*:\s*(.+)$/i;
  const points = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const direct = line.match(statusRe);
    if (direct) {
      points.push(line);
      continue;
    }
    const next = lines[i + 1]?.match(statusRe);
    if (next) {
      points.push(`${line}: ${lines[i + 1]}`);
      i += 1;
    }
  }
  return points.length ? points : lines.slice(0, 5);
}

function enforceSourceGrounding(slide, source) {
  if (!slide) return null;
  const sourceNumbers = extractNumbers(source);
  const sourceLexicon = buildSourceLexicon(source);
  const clean = { ...slide };
  const keepGroundedList = (items) => toStringList(items)
    .filter((item) => !hasUnsupportedNumber(item, sourceNumbers))
    .filter((item) => isSourceGroundedText(item, sourceLexicon))
    .slice(0, 6);

  clean.headline = keepGroundedText(clean.headline, sourceNumbers, sourceLexicon) || firstLine(source) || "Improved Slide";
  clean.subhead = keepGroundedText(clean.subhead, sourceNumbers, sourceLexicon);

  if (clean.type === "visualization") {
    // Visuals are allowed only when there are explicit source numbers and the
    // generated values reuse those numbers. This prevents fake benchmark charts.
    const data = Array.isArray(clean.data) ? clean.data : [];
    const groundedData = data.filter((item) => sourceNumbers.has(normalizeNumber(item?.value)));
    if (!sourceNumbers.size || groundedData.length < 2) {
      return {
        type: "bullets",
        headline: clean.headline,
        subhead: "Data numerik tidak cukup untuk chart yang valid.",
        bullets: [
          "Slide diperbaiki sebagai ringkasan, bukan visualisasi data.",
          "Tambahkan angka eksplisit di slide sumber jika ingin chart.",
          ...keepGroundedList(clean.bullets).slice(0, 3)
        ].slice(0, 5)
      };
    }
    clean.data = groundedData.slice(0, 8);
    clean.bullets = keepGroundedList(clean.bullets).slice(0, 4);
    return clean;
  }

  if (clean.type === "cards") {
    clean.cards = (Array.isArray(clean.cards) ? clean.cards : [])
      .map((card) => ({
        title: keepGroundedText(card?.title, sourceNumbers, sourceLexicon),
        desc: keepGroundedText(card?.desc, sourceNumbers, sourceLexicon)
      }))
      .filter((card) => card.title || card.desc)
      .slice(0, 6);
    if (!clean.cards.length) return improveFallbackSpec(source).slides[0];
    return clean;
  }

  if (clean.type === "columns") {
    clean.columns = (Array.isArray(clean.columns) ? clean.columns : [])
      .map((col) => ({
        title: keepGroundedText(col?.title, sourceNumbers, sourceLexicon),
        points: keepGroundedList(col?.points)
      }))
      .filter((col) => col.title || col.points.length)
      .slice(0, 3);
    if (!clean.columns.length) return improveFallbackSpec(source).slides[0];
    return clean;
  }

  clean.type = "bullets";
  clean.bullets = keepGroundedList(clean.bullets);
  if (!clean.bullets.length) return improveFallbackSpec(source).slides[0];
  return clean;
}

function hasSubstantiveSlideContent(slide) {
  if (!slide) return false;
  if (slide.type === "cards") return (slide.cards || []).length > 0;
  if (slide.type === "columns") return (slide.columns || []).some((c) => c.points?.length || c.title);
  if (slide.type === "visualization") return (slide.data || []).length >= 2;
  return (slide.bullets || []).length > 0;
}

function extractNumbers(text) {
  const matches = String(text || "").match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
  return new Set(matches.map(normalizeNumber).filter(Boolean));
}

function normalizeNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/\b\d+(?:[.,]\d+)?%?\b/);
  return match ? match[0].replace(",", ".").replace("%", "") : "";
}

function hasUnsupportedNumber(text, sourceNumbers) {
  const nums = extractNumbers(text);
  for (const n of nums) {
    if (!sourceNumbers.has(n)) return true;
  }
  return false;
}

function removeUnsupportedNumberText(text, sourceNumbers) {
  const value = str(text);
  return hasUnsupportedNumber(value, sourceNumbers) ? "" : value;
}

function keepGroundedText(text, sourceNumbers, sourceLexicon) {
  const value = removeUnsupportedNumberText(text, sourceNumbers);
  return isSourceGroundedText(value, sourceLexicon) ? value : "";
}

function buildSourceLexicon(source) {
  const tokens = new Set(significantTokens(source));
  const phrases = new Set();
  const lines = String(source || "")
    .split(/\r?\n+/)
    .map((line) => normalizeGroundingText(line))
    .filter(Boolean);
  for (const line of lines) {
    if (line.length >= 4) phrases.add(line);
    const parts = line.split(/\s*(?:::|:|;|,|•|\||-)\s*/).filter(Boolean);
    for (const part of parts) {
      if (part.length >= 4) phrases.add(part);
    }
  }
  return { tokens, phrases, normalized: normalizeGroundingText(source) };
}

function isSourceGroundedText(text, sourceLexicon) {
  const value = str(text);
  if (!value) return true;
  const normalized = normalizeGroundingText(value);
  if (!normalized) return true;
  if (sourceLexicon.normalized.includes(normalized)) return true;
  for (const phrase of sourceLexicon.phrases) {
    if (normalized.includes(phrase) || phrase.includes(normalized)) return true;
  }

  const tokens = significantTokens(value);
  // Short labels such as "Gallery", "Device", "High Risk", or "Others" are
  // grounded if every significant word appears in the source slide.
  if (tokens.length <= 3) return tokens.every((token) => sourceLexicon.tokens.has(token));
  if (!tokens.length) return true;

  const overlap = tokens.filter((token) => sourceLexicon.tokens.has(token)).length;
  const coverage = overlap / tokens.length;
  // Require high lexical overlap. This intentionally drops fluent but invented
  // phrases like "active liveness detection" when those words do not occur in
  // the selected slide.
  return coverage >= 0.82;
}

function significantTokens(text) {
  const stop = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "if", "in", "is", "it", "of", "on", "or", "the", "their", "this", "to", "via", "with",
    "ada", "agar", "akan", "atau", "dalam", "dan", "dari", "dengan", "di", "ini", "itu", "jika", "ke", "oleh", "pada", "sebagai", "untuk", "yang"
  ]);
  return normalizeGroundingText(text)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function normalizeGroundingText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

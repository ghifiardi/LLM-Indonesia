// Tantular Document Studio — brief/source text → normalized document spec.

import { runTantular } from "../tantularClient.js";

const DOCUMENT_SYSTEM = `Anda adalah Tantular Document Studio, perancang dokumen Word profesional yang privat dan Indonesian-first.
Mode aktif: PRODUKTIVITAS DOKUMEN, bukan keamanan/fraud.
Aturan:
- Jawab HANYA dengan satu objek JSON valid, tanpa markdown atau penjelasan.
- Tulis dalam Bahasa Indonesia profesional kecuali pengguna meminta bahasa lain.
- Pertahankan fakta, nama, angka, tanggal, dan istilah dari sumber.
- Jangan mengarang data, kutipan, sumber, regulasi, nama organisasi, atau benchmark.
- Jika informasi tidak tersedia, tulis sebagai hal yang perlu dilengkapi/divalidasi.
- Gunakan heading yang informatif, paragraf ringkas, dan bullet hanya ketika membantu keterbacaan.
- Jangan menyalin instruksi pengguna sebagai isi dokumen.
- Jangan mengubah tugas produktivitas menjadi analisis keamanan kecuali diminta eksplisit.`;

function documentUser({ brief, documentType, tone, sectionCount, instruction }) {
  return `Susun dokumen Word dari brief/sumber berikut.

Jenis dokumen: ${documentType || "laporan profesional"}.
Tone: ${tone || "profesional, jelas, ringkas"}.
Jumlah bagian utama: sekitar ${sectionCount}.
Instruksi tambahan: ${instruction || "tidak ada"}.

Skema JSON wajib:
{
  "title": "judul dokumen",
  "subtitle": "subjudul opsional",
  "author": "opsional; kosongkan jika tidak tersedia",
  "date": "opsional; jangan mengarang",
  "executiveSummary": ["3-5 poin ringkasan opsional"],
  "sections": [
    {
      "heading": "judul bagian",
      "level": 1,
      "paragraphs": ["paragraf 1", "paragraf 2"],
      "bullets": ["poin opsional"],
      "quote": "callout/kutipan opsional; hanya jika bersumber"
    }
  ],
  "closing": ["kesimpulan atau langkah berikutnya"]
}

Keluarkan sekitar ${sectionCount} bagian. Setiap paragraf 2-5 kalimat dan mudah dibaca.

Brief/sumber:
"""${brief}"""`;
}

export async function planDocument({
  brief,
  documentType = "Laporan profesional",
  tone = "",
  sectionCount = 6,
  instruction = ""
}) {
  const source = String(brief || "").trim();
  const count = clamp(sectionCount, 3, 12);
  if (!source) return { spec: null, source: "empty", error: "Sumber dokumen kosong." };

  try {
    const raw = await runTantular({
      system: DOCUMENT_SYSTEM,
      user: documentUser({ brief: source, documentType, tone, sectionCount: count, instruction }),
      maxTokens: Math.min(6000, 1200 + count * 450),
      temperature: 0.2,
      task: "document",
      jsonMode: true
    });
    const parsed = extractJson(raw);
    if (parsed) return { spec: normalizeDocumentSpec(parsed, source, count), source: "model" };
  } catch (error) {
    return {
      spec: fallbackDocumentSpec(source, documentType, count),
      source: "fallback",
      error: error?.message || String(error)
    };
  }
  return { spec: fallbackDocumentSpec(source, documentType, count), source: "fallback" };
}

export function normalizeDocumentSpec(value, sourceText = "", sectionCount = 6) {
  const source = String(sourceText || "").trim();
  const title = text(value?.title) || inferTitle(source) || "Dokumen Tantular";
  const sections = (Array.isArray(value?.sections) ? value.sections : [])
    .map((section, index) => normalizeSection(section, index))
    .filter((section) => section.heading || section.paragraphs.length || section.bullets.length)
    .slice(0, clamp(sectionCount, 3, 12));

  return {
    title,
    subtitle: text(value?.subtitle),
    author: groundedMetadata(value?.author, source),
    date: groundedMetadata(value?.date, source),
    executiveSummary: list(value?.executiveSummary).slice(0, 5),
    sections: sections.length ? sections : fallbackSections(source, sectionCount),
    closing: list(value?.closing).slice(0, 6)
  };
}

export function fallbackDocumentSpec(sourceText, documentType = "Dokumen", sectionCount = 6) {
  const source = String(sourceText || "").trim();
  const sections = fallbackSections(source, sectionCount);
  return {
    title: inferTitle(source) || documentType || "Dokumen Tantular",
    subtitle: documentType,
    author: "",
    date: "",
    executiveSummary: sections.slice(0, 4).map((section) => section.heading),
    sections,
    closing: [
      "Validasi isi terhadap sumber sebelum dokumen digunakan sebagai keputusan final.",
      "Lengkapi pemilik, tenggat, dan data pendukung bila diperlukan."
    ]
  };
}

function normalizeSection(section, index = 0) {
  return {
    heading: text(section?.heading || section?.title) || `Bagian ${index + 1}`,
    level: clamp(section?.level || 1, 1, 2),
    paragraphs: list(section?.paragraphs || section?.body).slice(0, 6),
    bullets: list(section?.bullets || section?.points).slice(0, 8),
    quote: text(section?.quote)
  };
}

function fallbackSections(source, count) {
  const paragraphs = String(source || "")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 20);
  const groups = Math.min(clamp(count, 3, 12), Math.max(1, paragraphs.length));
  const perGroup = Math.ceil(Math.max(1, paragraphs.length) / groups);
  const sections = [];
  for (let i = 0; i < paragraphs.length; i += perGroup) {
    const body = paragraphs.slice(i, i + perGroup);
    if (!body.length) continue;
    sections.push({
      heading: `Bagian ${sections.length + 1}`,
      level: 1,
      paragraphs: body.slice(0, 5),
      bullets: [],
      quote: ""
    });
  }
  return sections.length ? sections : [{
    heading: "Isi Utama",
    level: 1,
    paragraphs: [source || "Tambahkan brief atau sumber dokumen."],
    bullets: [],
    quote: ""
  }];
}

function extractJson(raw) {
  const value = String(raw || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? value.slice(start, end + 1) : value;
  try {
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return null;
  }
}

function inferTitle(source) {
  const line = String(source || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  if (/^(buat|buatlah|susun|tulis|create|write)\b/i.test(line)) {
    const topic = line.match(/\b(?:tentang|mengenai|untuk)\s+(.+?)(?:[.;]|$)/i)?.[1];
    if (topic) return headline(topic);
  }
  return line.length <= 100 ? line : "";
}

function headline(value) {
  const words = String(value || "").trim().split(/\s+/);
  return words.map((word, index) => (
    index === 0 || word.length > 3 ? word.charAt(0).toUpperCase() + word.slice(1) : word
  )).join(" ").slice(0, 100);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function groundedMetadata(value, source) {
  const candidate = text(value);
  if (!candidate) return "";
  const normalizedSource = String(source || "").toLowerCase().replace(/\s+/g, " ");
  return normalizedSource.includes(candidate.toLowerCase().replace(/\s+/g, " ")) ? candidate : "";
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/\r?\n|•|(?:^|\s)-\s+/).map(text).filter(Boolean);
  }
  return [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
}

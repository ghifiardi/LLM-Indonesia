// Elaborate the attached file into the document (2026-09-05): section by
// section, each model call grounded on that section's own text, assembled
// as headings + prose ready for the existing insert actions. Bounded by a
// cap (a 62-section book is 62 model calls) and cancellable between calls.
// The model call is injected; the planning is pure.

import { runTantular } from "../tantularClient.js";

const str = (v) => String(v ?? "").replace(/\r\n?/g, "\n");
export const DEFAULT_CAP = 12;

export const ELABORATION_SYSTEM = [
  "Anda adalah Tantular, penulis dokumen Bahasa Indonesia yang source-grounded.",
  "Tugas: menguraikan SATU bagian dari dokumen lampiran menjadi 2–5 paragraf prosa yang jelas dan runtut, siap dimasukkan ke dokumen Word.",
  "Gunakan hanya fakta dari teks bagian yang diberikan; jangan menambah fakta, angka, nama, atau kutipan yang tidak ada di teks itu.",
  "Pertahankan istilah teknis asli; jika teks berbahasa Inggris, jelaskan dalam Bahasa Indonesia dengan istilah aslinya dalam tanda kurung bila perlu.",
  "Tanpa heading (heading dibuat oleh sistem), tanpa bullet, tanpa tabel. Balas hanya prosa."
].join(" ");

function looksHeading(line) {
  const value = String(line || "").trim();
  return value.length >= 3 && value.length <= 120 && !/[.!?:;,]$/.test(value) && value.split(/\s+/).length <= 14;
}

export function splitAttachmentSections(text) {
  const lines = str(text).split("\n");
  const sections = [];
  let current = null;
  let page = null;
  for (const raw of lines) {
    const line = raw.trim();
    const mark = line.match(/^\[Page (\d+)\]$/);
    if (mark) { page = Number(mark[1]); continue; }
    if (!line) { if (current) current.text += "\n"; continue; }
    if (looksHeading(line) && (!current || current.body.trim())) {
      current = { heading: line, page, text: "", body: "" };
      sections.push(current);
      continue;
    }
    if (!current) { current = { heading: line.slice(0, 80), page, text: "", body: "" }; sections.push(current); continue; }
    current.text += `${line}\n`;
    current.body += `${line}\n`;
  }
  return sections.map((s) => ({ heading: s.heading, page: s.page, text: s.text.replace(/\n{3,}/g, "\n\n").trim() }))
    .filter((s) => s.text || s.heading);
}

const ELABORATE_RE = /\b(?:elaborasi|elaborate|uraikan|jabarkan|kembangkan|tuliskan|tulis(?:kan)?\s+ke\s+dokumen|masukkan\s+.*\s+ke\s+dokumen|expand|write (?:it |the [a-z]+ )?into the document)\b/i;
const ATTACH_RE = /\b(?:lampiran|dilampirkan|pdf|buku|book|file|dokumen yang (?:saya )?(?:unggah|lampirkan)|attached)\b/i;
export function wantsElaboration(message) {
  const m = String(message || "");
  return ELABORATE_RE.test(m) && ATTACH_RE.test(m);
}

const STOP = new Set(["yang", "dan", "dari", "ke", "dalam", "untuk", "dengan", "ini", "itu", "tentang", "bab", "bagian", "buku", "dokumen", "lampiran", "the", "into", "from", "about", "chapter", "section", "book", "document", "attached", "pdf", "uraikan", "elaborasi", "tuliskan", "jabarkan", "kembangkan", "expand", "seluruh", "semua", "isi"]);
const tokens = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
const stem = (w) => w.replace(/(ies|ied)$/, "y").replace(/(ing|ed|es|s|nya|kan|an)$/, "");

export function planElaboration(sections, instruction, { cap = DEFAULT_CAP } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const wantsAll = /\b(?:seluruh|semua|keseluruhan|entire|whole|all)\b/i.test(String(instruction || ""));
  if (wantsAll || !tokens(instruction).length) {
    return { scope: "all", sections: list.slice(0, cap), truncated: Math.max(0, list.length - cap) };
  }
  // Indonesian and English forms of a term share a prefix ("regresi" /
  // "regression", "statistik" / "statistics"): match on a common prefix of
  // at least five characters, not on exact stems.
  const want = tokens(instruction).map(stem);
  const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b.slice(0, 5)) && b.startsWith(a.slice(0, 5))));
  const matched = list.filter((s) => {
    const have = [...new Set(tokens(`${s.heading} ${s.text.slice(0, 400)}`).map(stem))];
    return want.some((w) => have.some((h) => same(w, h)));
  });
  if (!matched.length) return { scope: "none", sections: [], truncated: 0 };
  return { scope: "matched", sections: matched.slice(0, cap), truncated: Math.max(0, matched.length - cap) };
}

export async function elaborateSections({ sections, instruction = "", run = runTantular, onProgress = () => {}, signal } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const parts = [];
  let done = 0;
  for (const [i, section] of list.entries()) {
    if (signal?.aborted) return { text: parts.join("\n\n"), done, aborted: true };
    onProgress(`Menguraikan bagian ${i + 1}/${list.length}: ${section.heading}`);
    const prose = await run({
      system: ELABORATION_SYSTEM,
      user: `Permintaan pengguna: ${String(instruction || "uraikan bagian ini")}\nJudul bagian: ${section.heading}\n${section.page ? `Halaman: ${section.page}\n` : ""}\nTeks bagian:\n"""${section.text || section.heading}"""`,
      maxTokens: 900, temperature: 0.2, task: "document", signal
    });
    done += 1;
    const title = `## ${section.heading}${section.page ? ` (hal. ${section.page})` : ""}`;
    parts.push(`${title}\n\n${String(prose || "").trim()}`);
    if (signal?.aborted) return { text: parts.join("\n\n"), done, aborted: true };
  }
  return { text: parts.join("\n\n"), done, aborted: false };
}

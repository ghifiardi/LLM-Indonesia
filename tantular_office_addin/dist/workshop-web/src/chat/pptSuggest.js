// "Usulkan perbaikan slide ini": analyse ONE selected slide and offer concrete
// changes from a FIXED catalogue. Every item names the exact current text and
// the exact proposed text, the user ticks one or more, and only those are
// applied — in place, in the slide's own shapes, design untouched. Nothing is
// assumed on the user's behalf: an item the model cannot ground on the slide
// (unknown "before" text, a new number, a new name) is dropped before it is
// ever shown. Pure: no DOM, no Office; the model call is injected.

import { runTantular } from "../tantularClient.js";
import { extractJsonObject, detectSlideLanguage } from "../deck/deckPlanner.js";

export const SUGGEST_TYPES = ["sharpen_headline", "shorten_point", "merge_points", "split_point", "move_point"];

const LABELS = {
  sharpen_headline: "Pertajam judul",
  shorten_point: "Perpendek poin",
  merge_points: "Gabungkan 2 poin",
  split_point: "Pecah poin",
  move_point: "Pindahkan poin"
};

const WANTS_RE = /\b(usulkan|usulan|saran|sarankan|apa yang bisa diperbaiki|apa yang perlu diperbaiki|suggest|suggestions?|what (?:can|should) (?:be|i) improve)\b/i;

export function wantsSuggestions(message) {
  return WANTS_RE.test(String(message || ""));
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const norm = (v) => str(v).toLowerCase().replace(/\s+/g, " ");
const numbersIn = (text) => new Set((String(text || "").match(/\b\d+(?:[.,]\d+)?%?\b/g) || []).map((n) => n.replace(",", ".").replace("%", "")));

function hasNewNumber(text, sourceNumbers) {
  for (const n of numbersIn(text)) if (!sourceNumbers.has(n)) return true;
  return false;
}

// A capitalised word mid-text that the slide never uses is a new name or
// term — rejected even in a title-cased headline, so a headline can only be
// built from the slide's own words (inflections allowed, short words free).
const stem = (w) => w.replace(/(ies|ied)$/, "y").replace(/(ing|ed|es|s)$/, "");
function hasNewName(text, sourceWords) {
  const words = String(text || "").split(/\s+/);
  const known = (w) => sourceWords.has(w) || sourceWords.has(stem(w)) || [...sourceWords].some((sw) => stem(sw) === stem(w));
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i].replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (!/^[A-Z][a-z]{3,}$/.test(word)) continue;
    if (/[.!?:;—-]$/.test(words[i - 1])) continue;
    if (!known(word.toLowerCase())) return true;
  }
  return false;
}

function sourceOf(structure) {
  const blocks = Array.isArray(structure?.blocks) ? structure.blocks : [];
  const text = [structure?.title, ...(structure?.headings || []), ...blocks.flat()].map(str).filter(Boolean).join("\n");
  return {
    text,
    numbers: numbersIn(text),
    words: new Set(text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)),
    blocks
  };
}

// --- parse + validate --------------------------------------------------------

export function parseSuggestions(raw, structure) {
  const parsed = typeof raw === "string" ? extractJsonObject(raw) : raw;
  const items = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const source = sourceOf(structure);
  const findLine = (column, text) => {
    const block = source.blocks[column - 1];
    if (!block) return -1;
    return block.findIndex((line) => norm(line) === norm(text));
  };
  const factsOk = (text) => str(text) && !hasNewNumber(text, source.numbers) && !hasNewName(text, source.words);
  const out = [];

  for (const item of items) {
    const type = str(item?.type);
    if (!SUGGEST_TYPES.includes(type)) continue;
    const column = Number(item?.column) || 0;

    if (type === "sharpen_headline") {
      if (norm(item?.before) !== norm(structure?.title) || !factsOk(item?.after) || norm(item?.after) === norm(item?.before)) continue;
      out.push({ type, before: str(structure.title), after: str(item.after) });
      continue;
    }
    if (type === "shorten_point") {
      const at = findLine(column, item?.before);
      if (at < 0 || !factsOk(item?.after) || norm(item?.after) === norm(item?.before)) continue;
      out.push({ type, column, before: source.blocks[column - 1][at], after: str(item.after) });
      continue;
    }
    if (type === "merge_points") {
      const befores = Array.isArray(item?.before) ? item.before : [];
      if (befores.length !== 2 || !factsOk(item?.after)) continue;
      const found = befores.map((b) => findLine(column, b));
      if (found.some((at) => at < 0) || found[0] === found[1]) continue;
      out.push({ type, column, before: found.map((at) => source.blocks[column - 1][at]), after: str(item.after) });
      continue;
    }
    if (type === "split_point") {
      const at = findLine(column, item?.before);
      const afters = (Array.isArray(item?.after) ? item.after : []).map(str).filter(Boolean);
      if (at < 0 || afters.length !== 2 || !afters.every(factsOk)) continue;
      out.push({ type, column, before: source.blocks[column - 1][at], after: afters });
      continue;
    }
    if (type === "move_point") {
      const toColumn = Number(item?.toColumn) || 0;
      const at = findLine(column, item?.before);
      if (at < 0 || !source.blocks[toColumn - 1] || toColumn === column) continue;
      out.push({ type, column, toColumn, before: source.blocks[column - 1][at] });
    }
  }
  return out.slice(0, 8).map((s, i) => ({ id: `s${i + 1}`, ...s }));
}

export function describeSuggestion(s) {
  const q = (t) => `"${t}"`;
  const col = s.column ? ` (kolom ${s.column})` : "";
  if (s.type === "sharpen_headline") return `${LABELS[s.type]}: ${q(s.before)} → ${q(s.after)}`;
  if (s.type === "shorten_point") return `${LABELS[s.type]}${col}: ${q(s.before)} → ${q(s.after)}`;
  if (s.type === "merge_points") return `${LABELS[s.type]}${col}: ${q(s.before[0])} + ${q(s.before[1])} → ${q(s.after)}`;
  if (s.type === "split_point") return `${LABELS[s.type]}${col}: ${q(s.before)} → ${q(s.after[0])} + ${q(s.after[1])}`;
  if (s.type === "move_point") return `Pindahkan poin dari kolom ${s.column} ke kolom ${s.toColumn}: ${q(s.before)}`;
  return `${s.type}`;
}

// --- apply ---------------------------------------------------------------------

export function applySuggestions(structure, suggestions, selectedIds) {
  const chosen = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  let title = str(structure?.title);
  const blocks = (Array.isArray(structure?.blocks) ? structure.blocks : []).map((b) => b.slice());
  const indexOf = (column, text) => (blocks[column - 1] || []).findIndex((line) => norm(line) === norm(text));

  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!chosen.has(s.id)) continue;
    if (s.type === "sharpen_headline") { title = s.after; continue; }
    if (s.type === "shorten_point") {
      const at = indexOf(s.column, s.before);
      if (at >= 0) blocks[s.column - 1][at] = s.after;
      continue;
    }
    if (s.type === "merge_points") {
      const first = indexOf(s.column, s.before[0]);
      const second = indexOf(s.column, s.before[1]);
      if (first < 0 || second < 0) continue;
      const keep = Math.min(first, second);
      const drop = Math.max(first, second);
      blocks[s.column - 1].splice(drop, 1);
      blocks[s.column - 1][keep] = s.after;
      continue;
    }
    if (s.type === "split_point") {
      const at = indexOf(s.column, s.before);
      if (at >= 0) blocks[s.column - 1].splice(at, 1, s.after[0], s.after[1]);
      continue;
    }
    if (s.type === "move_point") {
      const at = indexOf(s.column, s.before);
      if (at < 0 || !blocks[s.toColumn - 1]) continue;
      const [line] = blocks[s.column - 1].splice(at, 1);
      blocks[s.toColumn - 1].push(line);
    }
  }
  return { title, blocks };
}

// The in-place writer (officeClient.planInPlaceWrites) takes a slide shape.
export function suggestionsToSlide(structure, applied) {
  const headline = str(applied?.title) || str(structure?.title);
  const blocks = Array.isArray(applied?.blocks) ? applied.blocks : [];
  if (blocks.length <= 1) return { type: "bullets", headline, bullets: blocks[0] || [] };
  const headings = Array.isArray(structure?.headings) ? structure.headings : [];
  return { type: "columns", headline, columns: blocks.map((points, i) => ({ title: str(headings[i]), points })) };
}

// --- the model call ------------------------------------------------------------

const SUGGEST_SYSTEM = `Anda adalah Tantular, editor slide yang source-grounded.
Tugas: menganalisis SATU slide dan mengusulkan perbaikan KONKRET dari katalog tetap. Anda TIDAK mengubah slide; pengguna yang memilih.
Balas HANYA satu objek JSON: {"suggestions":[...]} (maksimal 6 item, urutkan dari yang paling berdampak).
Tipe yang diizinkan (hanya ini):
- {"type":"sharpen_headline","before":"<judul persis>","after":"<judul baru>"}
- {"type":"shorten_point","column":1,"before":"<poin persis>","after":"<poin lebih pendek/tajam>"}
- {"type":"merge_points","column":2,"before":["<poin A persis>","<poin B persis>"],"after":"<satu poin gabungan>"}
- {"type":"split_point","column":1,"before":"<poin panjang persis>","after":["<bagian 1>","<bagian 2>"]}
- {"type":"move_point","column":1,"toColumn":2,"before":"<poin persis>"}
Aturan WAJIB:
- "before" HARUS disalin persis dari teks slide (kata demi kata). Kalau tidak persis, item dibuang.
- "after" hanya boleh memakai fakta, angka, nama, dan istilah yang sudah ada di slide. Jangan menambah fakta baru.
- Jangan mengusulkan menghapus poin. Jangan mengusulkan tipe di luar katalog.
- Kolom dinomori dari 1 sesuai urutan di slide.`;

export async function requestSuggestions({ structure, tone = "", instruction = "", signal, run = runTantular } = {}) {
  const source = sourceOf(structure);
  const language = detectSlideLanguage(source.text) === "en"
    ? "BAHASA OUTPUT: English. Slide berbahasa Inggris — semua \"after\" dalam bahasa Inggris; jangan menerjemahkan."
    : "BAHASA OUTPUT: Bahasa Indonesia.";
  const columns = source.blocks.map((block, i) => {
    const heading = str(structure?.headings?.[i]);
    return `Kolom ${i + 1}${heading ? ` — "${heading}"` : ""}:\n${block.map((line) => `- ${line}`).join("\n")}`;
  }).join("\n\n");
  const raw = await run({
    system: SUGGEST_SYSTEM,
    user: `${language}\nTone: ${tone || "profesional, jelas, executive"}.\nStyle guide / instruksi project:\n"""${instruction || "tidak ada"}"""\n\n`
      + `Judul slide: "${str(structure?.title)}"\n\n${columns}\n\nUsulkan perbaikan dari katalog. JSON saja.`,
    maxTokens: 1400,
    temperature: 0.2,
    task: "deck",
    jsonMode: true,
    signal
  });
  return parseSuggestions(raw, structure);
}

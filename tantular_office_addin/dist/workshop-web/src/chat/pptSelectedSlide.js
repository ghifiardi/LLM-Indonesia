// Chat as the primary entry point for improving ONE selected slide.
//
// "Perbaiki slide ini" has no slide number in it, and the planner model can
// only target numbers it sees in the snapshot. The live PowerPoint selection
// (officeClient.getSelectedSlideTextContext) knows which slide the user means,
// so this module turns that selection into an explicit slide number BEFORE the
// planner runs, and pins whatever the planner emits back onto that slide
// afterwards — a weak local model must not be able to drift to slide 1.
//
// Everything here is pure (no DOM, no Office, no model). The write path is
// unchanged: pptTools.executePptActions plans, the user confirms, and only
// executeConfirmedPptPlan writes.

import { extractRequestedSlideIndex } from "./pptTools.js";

export const SELECT_ONE_SLIDE_MESSAGE = "Pilih satu slide terlebih dahulu, lalu coba lagi.";
export const DECK_SETTINGS_NOTE = "Menggunakan pengaturan Deck Studio.";

// "slide ini" / "slide terpilih" / "slide yang dipilih" / "this slide" /
// "selected slide". Word-bounded so "slideshow" never matches.
const SELECTED_SLIDE_RE = /\b(?:slide\s+(?:ini|terpilih|yang\s+dipilih)|(?:this|the\s+selected|selected)\s+slide)\b/i;

export function mentionsSelectedSlide(message) {
  const text = String(message || "");
  if (!text.trim()) return false;
  if (extractRequestedSlideIndex(text) > 0) return false;
  return SELECTED_SLIDE_RE.test(text);
}

// Exactly one distinct 1-based slide position is usable. Ids alone are not
// enough: the planner and the snapshot speak in positions.
export function resolveSelectedSlideIndex(selected) {
  const indexes = [...new Set(
    (Array.isArray(selected?.slideIndexes) ? selected.slideIndexes : [])
      .map((value) => Number(value) || 0)
      .filter((value) => value > 0)
  )];
  const ids = new Set((Array.isArray(selected?.slideIds) ? selected.slideIds : []).filter(Boolean));
  if (indexes.length === 1 && ids.size <= 1) return { ok: true, index: indexes[0] };
  return { ok: false, index: 0, reason: SELECT_ONE_SLIDE_MESSAGE };
}

// The planner already handles "perbaiki slide 4"; give it exactly that.
export function rewriteSelectedSlideMessage(message, index) {
  return String(message || "").replace(SELECTED_SLIDE_RE, `slide ${index}`);
}

// After sanitisation, every content-changing action is forced onto the slide
// the user selected. Inserts and deletes are not what "perbaiki slide ini"
// asks for, so they are dropped with a visible note rather than applied to a
// slide the user never pointed at.
export function pinActionsToSlide(actions, index) {
  const list = Array.isArray(actions) ? actions : [];
  const pinned = [];
  const rejected = [];
  for (const action of list) {
    if (action?.op === "improve_slide" || action?.op === "replace_slide") {
      pinned.push({ ...action, slideIndex: index });
      continue;
    }
    rejected.push(`Aksi ${action?.op || "(kosong)"} diabaikan: permintaan ini hanya untuk slide terpilih (slide ${index}).`);
  }
  return { actions: pinned, rejected };
}

// --- visual preference as instruction text, never a new schema --------------

const PREFERENCE_PATTERNS = [
  ["visual", /\b(?:visual|chart|grafik|diagram|graph)\b/i],
  // A table is not a slide type the builder has; two-to-three columns is the
  // closest honest shape, and it keeps the request on the grounded path.
  ["columns", /\b(?:kolom|columns?|compare|comparison|bandingkan|perbandingan|vs\.?|tabel|table|terstruktur)\b/i],
  ["cards", /\b(?:kartu|cards?)\b/i],
  ["bullets", /\b(?:ringkas|padat|padatkan|simplify|simplified|singkat|concise|daftar poin|bullet(?: point)?s?)\b/i]
];

// "2 kolom tidak diperlukan", "jangan pakai kartu": a negated shape word is
// not a request for that shape. Strip negated clauses before matching.
const NEGATED_RE = /\b(?:tidak|bukan|jangan|tanpa)\b[^.,;]{0,40}?\b(?:kartu|cards?|kolom|columns?|chart|grafik|diagram|visual)\b[^.,;]*|\b(?:kartu|cards?|kolom|columns?|chart|grafik|diagram|visual)\b[^.,;]{0,40}?\b(?:tidak|bukan|jangan)\s+(?:diperlukan|perlu|usah|dipakai|digunakan)\b/gi;

// "warna kartu", "font kartu": a property of an existing shape, not a request
// for that shape.
const PROPERTY_OF_RE = /\b(?:warna|font|huruf|ukuran|posisi)\s+(?:kartu|cards?|kolom|columns?|chart|grafik|diagram)\b/gi;

export function visualPreferenceFor(text) {
  const value = String(text || "").replace(NEGATED_RE, " ").replace(PROPERTY_OF_RE, " ");
  for (const [pref, re] of PREFERENCE_PATTERNS) {
    if (re.test(value)) return pref;
  }
  return "";
}

const PREFERENCE_INSTRUCTIONS = {
  bullets: 'Bentuk slide: prioritaskan type "bullets" yang ringkas — perpendek kalimat tanpa menghapus poin.',
  cards: 'Bentuk slide: prioritaskan type "cards" (satu kartu per gagasan dari teks sumber).',
  columns: 'Bentuk slide: prioritaskan type "columns" (minimal 2 kolom, judul kolom berasal dari sumber).',
  visual: 'Bentuk slide: buat lebih visual. HANYA jika teks sumber memuat angka eksplisit yang cukup, '
    + 'gunakan type "visualization" dengan data numerik yang identik dengan sumber. '
    + 'Jika tidak ada angka, gunakan "cards" atau "columns". '
    + 'Jangan membuat angka, nilai nol, persentase, benchmark, tanggal, label data, atau hubungan sebab-akibat baru.'
};

export function visualPreferenceInstruction(preference) {
  return PREFERENCE_INSTRUCTIONS[String(preference || "")] || "";
}

// The Lanjutan card's <select id="refine-visual-mode"> values. They are only
// ever converted to the instruction text above — the same channel chat uses.
export const REFINE_VISUAL_MODES = {
  auto: "",
  concise: "bullets",
  cards: "cards",
  columns: "columns",
  chart: "visual"
};

export function refineVisualModeInstruction(mode) {
  const pref = REFINE_VISUAL_MODES[String(mode || "")];
  return pref ? visualPreferenceInstruction(pref) : "";
}

// --- chips ------------------------------------------------------------------
// The question chips stay read-only (fill the box, do not send). The two
// improve chips DO send, because sending only produces a plan: the existing
// confirmation gate still stands between the plan and the deck.
const QUESTION_CHIPS = [
  "Apa isi deck ini?",
  "Apa pesan utama deck ini?",
  "Apa yang kurang dari deck ini?"
].map((message) => ({ label: message, message, submit: false }));

const IMPROVE_CHIPS = [
  // Sends a request for OPTIONS: the reply is a checklist, and nothing is
  // written until the user ticks items and clicks apply.
  { label: "🔍 Usulkan perbaikan slide ini", message: "Usulkan perbaikan untuk slide terpilih.", submit: true },
  { label: "🛠 Perbaiki slide terpilih", message: "Perbaiki slide terpilih.", submit: true },
  { label: "✨ Tata ulang slide ini", message: "Tata ulang slide terpilih.", submit: true },
  { label: "▥ Buat slide lebih visual", message: "Buat slide terpilih lebih visual.", submit: true }
];

export function pptQuickChips(host) {
  if (String(host || "") !== "PowerPoint") return [];
  return [...IMPROVE_CHIPS, ...QUESTION_CHIPS];
}

// --- planner intent must be the user's, not the prompt's example ----------
// Traced live (2026-09-03): "Perbaiki slide terpilih." became instruction
// "perbaiki slide supaya lebih ringkas" — the example from the planner's own
// prompt. An intent is kept only when its content words appear in the user's
// message; otherwise the user's message is the intent.
const INTENT_STOP = new Set(["slide", "ini", "itu", "yang", "dan", "untuk", "supaya", "agar", "jadi", "buat", "the", "this", "that", "make", "it"]);
function intentTokens(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !INTENT_STOP.has(t));
}

export function groundActionIntent(plannerIntent, userMessage) {
  const message = String(userMessage || "").trim();
  const intent = String(plannerIntent || "").trim();
  if (!intent) return message;
  const tokens = intentTokens(intent);
  if (!tokens.length) return message;
  const have = new Set(intentTokens(message));
  const covered = tokens.filter((t) => have.has(t) || [...have].some((h) => h.startsWith(t) || t.startsWith(h))).length;
  // Half the content words, or the same layout ask ("jadikan kartu" for
  // "ubah ... menjadi kartu"), is enough; falling back to the message is harmless.
  const sameShape = visualPreferenceFor(intent) && visualPreferenceFor(intent) === visualPreferenceFor(message);
  return covered / tokens.length >= 0.5 || sameShape ? intent : message;
}

// "Rapikan tata letak" / "teks tumpang tindih": a geometry repair, not a
// text rewrite. Deterministic — the model never sees layout.
const LAYOUT_RE = /\b(?:tata ulang|susun ulang|desain ulang|tata letak|tumpang tindih|bertumpuk|tumpang-tindih|overlap(?:ping)?|layout (?:fix|repair)|rapikan (?:posisi|kotak))\b/i;
export function wantsLayoutTidy(message) {
  return LAYOUT_RE.test(String(message || ""));
}

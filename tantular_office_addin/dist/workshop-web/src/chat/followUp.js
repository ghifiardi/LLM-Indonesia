// Follow-ups like "buat lebih singkat" after an approved edit. Once the
// document changes, old chat turns are dropped, so the referent must come from
// a verified span of the CURRENT document, or we ask. Never guess.
import { bodyRevision } from "./contextBuilder.js";

export const ASK_REFERENT_MESSAGE =
  "Bagian mana yang Anda maksud? Saya tidak bisa memastikan teks yang dimaksud di dokumen versi terbaru. Blok teksnya di Word lalu kirim ulang permintaannya.";

const ANAPHORA = /\b(itu|tadi|tersebut|barusan|sebelumnya|keduanya|semuanya|it|that|both|previous|above)\b/i;
// A sentence opener ("sekarang", "lalu") alone never makes a request a
// follow-up: "Sekarang ringkas dokumen ini" is self-contained. It only counts
// in front of a bare comparative with no object ("sekarang buat lebih singkat").
const OPENER = "(?:(?:sekarang|lalu|kemudian|selanjutnya|now|then|next)\\s*,?\\s+)?";
const BARE_COMPARATIVE = new RegExp(
  `^\\s*${OPENER}(?:(?:buat(?:lah)?|jadikan|ubah|make)\\s+)?(?:nya\\s+)?(?:lebih|more|less|shorter|longer)\\b`, "i");
const ALL_TARGETS = /\b(keduanya|semuanya|semua|both|all of them)\b/i;

export function isAnaphoricFollowUp(message) {
  const text = String(message ?? "");
  return ANAPHORA.test(text) || BARE_COMPARATIVE.test(text);
}

function occursOnce(body, text) {
  const i = body.indexOf(text);
  return i !== -1 && body.indexOf(text, i + 1) === -1;
}

// Remember what an approved edit produced, but only spans that are present
// exactly once in the document as it now stands.
export function deriveReferent(appliedEdits, bodyAfter) {
  const texts = [...new Set(appliedEdits.map((e) => e?.replace).filter((t) => typeof t === "string" && t.trim()))]
    .filter((t) => occursOnce(bodyAfter, t));
  return texts.length ? { texts } : null;
}

const preview = (t) => (t.length > 60 ? `${t.slice(0, 57)}…` : t);

export function askWhichMessage(texts) {
  return `Ada ${texts.length} bagian yang baru diedit: ${texts.map((t, i) => `(${i + 1}) "${preview(t)}"`).join("; ")}. `
    + "Bagian mana yang Anda maksud? Sebutkan atau blok teksnya di Word, atau tulis \"keduanya\" jika semuanya.";
}

// Returns { text, revision } for a verified referent, { ambiguous: texts } when
// several spans qualify and the user did not pick one, or null.
export function verifyReferent(referent, body, message = "") {
  if (!referent?.texts?.length) return null;
  if (!referent.texts.every((t) => occursOnce(body, t))) return null;
  const revision = bodyRevision(body);
  const { texts } = referent;
  if (texts.length === 1) return { text: texts[0], revision };
  if (ALL_TARGETS.test(message)) return { text: texts.join("\n\n"), revision };
  const named = texts.filter((t) => message.includes(t));
  if (named.length === 1) return { text: named[0], revision };
  return { ambiguous: texts };
}

const ORDINALS = { pertama: 0, satu: 0, kesatu: 0, first: 0, kedua: 1, dua: 1, second: 1,
  ketiga: 2, tiga: 2, third: 2, keempat: 3, empat: 3, fourth: 3 };
const FILLER = new Set(["yang", "nomor", "no", "bagian", "opsi", "pilihan", "number", "the", "one", "saja", "aja", "deh", "ya", "yg"]);

// Interpret a short reply to "which one?" as an index into the listed spans,
// "all", or null (not a choice -- treat as an ordinary message).
export function parseChoice(message, count) {
  const text = String(message ?? "").trim().toLowerCase();
  if (!text || text.length > 30) return null;
  const tokens = text.replace(/[().,!?"'#]/g, " ").split(/\s+/).filter((t) => t && !FILLER.has(t));
  if (tokens.length !== 1) return null;
  const [t] = tokens;
  if (/^(keduanya|semuanya|both|all)$/.test(t)) return count > 1 ? "all" : null;
  const index = /^\d+$/.test(t) ? Number(t) - 1 : ORDINALS[t];
  return Number.isInteger(index) && index >= 0 && index < count ? index : null;
}

// Resolve a pending choice against the CURRENT body; null if any span no
// longer appears exactly once.
export function pickReferent(referent, body, choice) {
  if (!referent?.texts?.length || !referent.texts.every((t) => occursOnce(body, t))) return null;
  const revision = bodyRevision(body);
  if (choice === "all") return { text: referent.texts.join("\n\n"), revision };
  const text = referent.texts[choice];
  return text === undefined ? null : { text, revision };
}

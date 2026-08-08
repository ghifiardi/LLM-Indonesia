import { runTantular } from "../tantularClient.js";

// Router taxonomy + prompt live ONLY here — this exact contract is the
// future Tinker SFT target. Do not duplicate elsewhere.
export const INTENTS = Object.freeze([
  "TANYA_DOKUMEN", "EDIT_TEKS", "DRAFT_TEKS", "TERJEMAH",
  "RINGKAS", "UBAH_NADA", "CEK_AMAN", "UMUM"
]);

export const ROUTER_SYSTEM = [
  "Anda router intent untuk asisten dokumen Word Bahasa Indonesia.",
  "Balas HANYA satu kata tanpa tanda baca, salah satu dari:",
  "TANYA_DOKUMEN (bertanya tentang isi dokumen),",
  "EDIT_TEKS (merevisi/memperbaiki teks yang sudah ada),",
  "DRAFT_TEKS (menulis konten baru untuk disisipkan),",
  "TERJEMAH (menerjemahkan),",
  "RINGKAS (meringkas),",
  "UBAH_NADA (mengubah nada formal/santai),",
  "CEK_AMAN (cek penipuan/keamanan),",
  "UMUM (lainnya, obrolan biasa).",
  "Jika ragu, jawab UMUM."
].join(" ");

export function parseIntent(raw) {
  const value = String(raw ?? "").toUpperCase();
  // Longest-first so overlapping names can never mis-match.
  const byLength = [...INTENTS].sort((a, b) => b.length - a.length);
  for (const intent of byLength) {
    if (value.includes(intent)) return intent;
  }
  return "UMUM";
}

export function routeIntentHeuristic(message) {
  const value = String(message ?? "").toLowerCase();
  // "Turn this into a table/bullets/chart" (ID or EN) is a content transform
  // answered from context — never generic chat, which may refuse to read the
  // document. Route deterministically; small local routers miss these.
  const formatTarget = /\b(tabel|table|bagan|chart|diagram|grafik|bullet|butir|poin|list|ringkasan)\b/i.test(value);
  const transformVerb = /\b(buat(?:kan)?|ubah|jadikan|konversi|susun(?:\s+ulang)?|tampilkan|sajikan|transform|convert|create|make|turn|render|reformat)\b/i.test(value);
  if (formatTarget && transformVerb) return "TANYA_DOKUMEN";
  const documentTarget = /\b(dokumen|document|bagian|sub[- ]?section|subbagian|section|paragraf|paragraph|judul|heading)\b/i.test(value);
  // Only route to document mutation when the user explicitly asks to change,
  // insert, replace, or apply text. "Can you elaborate/explain this section?"
  // is conversational QA unless the user says to put the change in the doc.
  const mutationVerb = /\b(tambahkan|sisipkan|gantikan|ganti|rewrite|revisi|ubah|perbaiki|edit|terapkan|apply|insert|replace)\b/i.test(value);
  const elaborationIntoDocument = /\b((?:di)?elaborasi(?:kan)?|(?:di)?kembangkan|(?:di)?perluas|expand)\b[\s\S]{0,80}\b(ke|dalam)\s+(dokumen|document|naskah)\b/i.test(value);
  if (documentTarget && (mutationVerb || elaborationIntoDocument)) return "EDIT_TEKS";

  const documentQuestion = /\b(apa|apakah|mengapa|kenapa|bagaimana|jelaskan|terangkan|elaborasi|elaborate|kembangkan|perluas|where|what|why|how|explain|compare|bandingkan|cari|temukan)\b/i.test(value);
  if (documentTarget && documentQuestion) return "TANYA_DOKUMEN";
  return null;
}

export async function routeIntent(message, { signal } = {}) {
  const deterministic = routeIntentHeuristic(message);
  if (deterministic) return deterministic;
  try {
    const raw = await runTantular({
      system: ROUTER_SYSTEM,
      user: String(message ?? "").slice(0, 2000),
      maxTokens: 8,
      temperature: 0,
      signal
    });
    return parseIntent(raw);
  } catch (error) {
    // Cancellation must propagate — only genuine router failures fall back
    // to UMUM. callChat converts a timeout abort into its own Error, so we
    // distinguish by checking the external signal, not error.name.
    if (signal?.aborted) throw error;
    return "UMUM"; // router must never hard-fail
  }
}

// A message that explicitly talks about "the text I selected" should be
// answered against the live selection, whatever the intent's default is.
export function prefersSelectionContext(message) {
  return /\b(yang saya pilih|saya pilih|yang dipilih|dipilih|terpilih|seleksi(?:nya)?|selection|selected|highlighted?|disorot|ditandai)\b/i
    .test(String(message ?? ""));
}

export function defaultContextFor(intent, hasSelection) {
  switch (intent) {
    case "TANYA_DOKUMEN": return "document";
    case "EDIT_TEKS": return hasSelection ? "selection" : "document";
    case "RINGKAS": return hasSelection ? "selection" : "document";
    case "DRAFT_TEKS": return "none";
    case "TERJEMAH":
    case "UBAH_NADA":
    case "CEK_AMAN": return hasSelection ? "selection" : "none";
    // Spec: UMUM (incl. parse fallback) must never auto-read the main body.
    default: return hasSelection ? "selection" : "none";
  }
}

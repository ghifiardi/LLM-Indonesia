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

export async function routeIntent(message) {
  try {
    const raw = await runTantular({
      system: ROUTER_SYSTEM,
      user: String(message ?? "").slice(0, 2000),
      maxTokens: 8,
      temperature: 0
    });
    return parseIntent(raw);
  } catch {
    return "UMUM"; // router must never hard-fail
  }
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

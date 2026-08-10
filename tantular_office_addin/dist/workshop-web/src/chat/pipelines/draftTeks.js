import { streamedAnswer } from "./index.js";

export const DRAFT_TEKS_SYSTEM = [
  "Anda penulis dokumen Bahasa Indonesia yang jelas dan profesional.",
  "Tulis konten baru sesuai permintaan: surat, memo, paragraf, kerangka, dan sejenisnya.",
  "Jangan mengarang fakta spesifik (nama, angka, tanggal) yang tidak diberikan; gunakan placeholder seperti [NAMA] bila perlu.",
  "Balas hanya draf teksnya."
].join(" ");

export function runDraftTeks({ instruction, contextText, history, emit, signal }) {
  const user = contextText
    ? `${instruction}\n\nGunakan konteks berikut bila relevan:\n"""${contextText.slice(0, 6000)}"""`
    : instruction;
  return streamedAnswer({ system: DRAFT_TEKS_SYSTEM, userText: user, history, emit, signal, maxTokens: 1536 });
}

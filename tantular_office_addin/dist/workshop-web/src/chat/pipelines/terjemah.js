import { streamedAnswer } from "./index.js";

const SYSTEM = [
  "Anda penerjemah profesional Indonesia-Inggris dua arah.",
  "Terjemahkan akurat, natural, pertahankan nama, angka, dan istilah teknis.",
  "Balas hanya hasil terjemahan tanpa penjelasan kecuali diminta."
].join(" ");

export function runTerjemah({ instruction, contextText, history, emit, signal }) {
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin diterjemahkan terlebih dahulu." });
  const user = `Terjemahkan teks berikut. ${instruction || "Jika teks berbahasa Indonesia, terjemahkan ke Inggris; jika berbahasa Inggris, ke Indonesia."}\n\nTeks:\n"""${contextText.slice(0, 8000)}"""`;
  return streamedAnswer({ system: SYSTEM, userText: user, history, emit, signal });
}

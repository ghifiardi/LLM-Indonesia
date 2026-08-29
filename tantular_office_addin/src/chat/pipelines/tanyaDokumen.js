import { streamedAnswer } from "./index.js";

const SYSTEM = [
  "Anda adalah Tantular, asisten dokumen Word privat Bahasa Indonesia.",
  "Jawab pertanyaan HANYA berdasarkan konteks dokumen yang diberikan.",
  "Konteks berasal dari isi utama dokumen (tanpa header/footer/kotak teks).",
  "Jika jawaban tidak ada di konteks, katakan tidak ditemukan di isi utama dokumen. Jangan mengarang."
].join(" ");

export function runTanyaDokumen({ instruction, contextText, history, emit, signal }) {
  if (!contextText) {
    return Promise.resolve({ kind: "text", text: "Saya belum bisa membaca dokumen. Coba lagi, atau pilih teks dan gunakan konteks Seleksi." });
  }
  const user = `Konteks dokumen (isi utama):\n"""${contextText}"""\n\nPertanyaan: ${instruction}`;
  return streamedAnswer({ system: SYSTEM, userText: user, history, emit, signal });
}

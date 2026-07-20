import { streamedAnswer, withContext } from "./index.js";

const SYSTEM = [
  "Anda adalah Tantular, asisten dokumen Word privat Bahasa Indonesia.",
  "Jawab jelas, singkat, dan bermanfaat dalam Bahasa Indonesia.",
  "Jangan mengarang isi dokumen: jika konteks tidak diberikan, katakan bahwa Anda tidak membaca dokumen dan sarankan memilih teks atau mengubah pil konteks.",
  "Jangan gunakan JSON kecuali diminta."
].join(" ");

export function runUmum({ instruction, contextText, history, emit, signal }) {
  return streamedAnswer({
    system: SYSTEM,
    userText: withContext(instruction, contextText, "Konteks (seleksi pengguna)"),
    history, emit, signal
  });
}

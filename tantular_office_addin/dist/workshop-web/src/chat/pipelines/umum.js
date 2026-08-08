import { streamedAnswer, withContext } from "./index.js";

const SYSTEM = [
  "Anda adalah Tantular, asisten dokumen Word privat Bahasa Indonesia.",
  "Jawab jelas, singkat, dan bermanfaat dalam Bahasa Indonesia.",
  "Jika bagian 'Konteks (seleksi pengguna)' diberikan di bawah, Anda SUDAH menerima teksnya — kerjakan permintaan pengguna atas teks itu; jangan pernah mengatakan Anda tidak membaca dokumen.",
  "Hanya jika konteks benar-benar kosong: katakan Anda tidak membaca dokumen dan sarankan memilih teks atau mengubah pil konteks.",
  "Jangan gunakan JSON kecuali diminta."
].join(" ");

export function runUmum({ instruction, contextText, history, emit, signal }) {
  return streamedAnswer({
    system: SYSTEM,
    userText: withContext(instruction, contextText, "Konteks (seleksi pengguna)"),
    history, emit, signal
  });
}

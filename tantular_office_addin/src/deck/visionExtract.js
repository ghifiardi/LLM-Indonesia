// Tantular Deck Studio — image → structured text extraction (OCR/vision).
// Sends a slide screenshot/photo to a local multimodal model and returns a
// clean, structured Indonesian description that Deck Studio can revamp.

import { runTantularVision } from "../tantularClient.js";

const EXTRACT_PROMPT = `Anda adalah Tantular Vision Extractor untuk produktivitas Office. Analisis gambar slide/diagram ini secara menyeluruh.
Mode aktif: EKSTRAKSI VISUAL / PRODUKTIVITAS PRESENTASI, bukan mode keamanan/fraud.

Tugas:
- Baca SEMUA teks yang terlihat (judul, subjudul, label grup, item, catatan kaki, legenda).
- Kenali struktur/pengelompokan (misalnya kolom, kotak domain, kategori).
- Jika ada legenda warna (misalnya hijau/teal, kuning, abu-abu), petakan warna ke status dan terapkan ke tiap item.
- Jangan mengarang item yang tidak ada di gambar.
- Jika teks kecil/tidak terbaca, tulis "TIDAK TERBACA" untuk bagian tersebut, bukan menebak.
- Jangan menilai gambar sebagai spam/scam/cyber/fraud kecuali teks gambar eksplisit meminta klasifikasi keamanan.
- Dilarang memakai konteks dari percakapan/prompt sebelumnya; hanya gunakan isi gambar.

Format keluaran (Bahasa Indonesia, teks biasa, tanpa markdown tabel):
JUDUL: <judul slide>
SUBJUDUL: <subjudul bila ada>
LEGENDA: <arti tiap warna bila ada>
GRUP:
- <Nama Grup>: <item1> (<status>), <item2> (<status>), ...
- <Nama Grup>: ...
CATATAN: <catatan kaki/keterangan bila ada>

Tulis selengkap mungkin dan akurat sesuai isi gambar.`;

export async function extractSlideFromImage(dataUrl, extraInstruction = "") {
  const prompt = extraInstruction
    ? `${EXTRACT_PROMPT}\n\nInstruksi tambahan: ${extraInstruction}`
    : EXTRACT_PROMPT;
  const text = await runTantularVision({ prompt, dataUrl, maxTokens: 1600, temperature: 0.1 });
  return String(text || "").trim();
}

// Read a File/Blob into a data URL usable by the vision endpoint.
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error("Tidak ada file gambar.")); return; }
    if (!/^image\//i.test(file.type)) { reject(new Error("File harus berupa gambar (PNG/JPG).")); return; }
    if (file.size > 12 * 1024 * 1024) { reject(new Error("Gambar terlalu besar (maks 12 MB).")); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Gagal membaca file gambar."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

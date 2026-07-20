import { runTantular } from "../tantularClient.js";
import { getDocumentBodyText } from "../officeClient.js";

const RAW_LIMIT = 6000;
const HARD_CAP = 60000;
const CHUNK_SIZE = 3000;

export function chunkText(text, { chunkSize = CHUNK_SIZE } = {}) {
  const paragraphs = String(text ?? "").split("\n");
  const chunks = [];
  let current = "";
  const flush = () => { if (current) { chunks.push(current); current = ""; } };
  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      flush();
      for (let i = 0; i < para.length; i += chunkSize) chunks.push(para.slice(i, i + chunkSize));
      continue;
    }
    if (current.length + para.length + 1 > chunkSize) flush();
    current = current ? `${current}\n${para}` : para;
  }
  flush();
  return chunks.length ? chunks : [""];
}

export function hashText(text) {
  let h = 5381;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Cache shaped for future per-chunk invalidation (spec): v1 invalidates
// wholesale when the body hash (docKey) changes.
let cache = null; // { docKey, chunks: [{ hash, summary }] }

const SUMMARY_SYSTEM = "Anda peringkas dokumen Bahasa Indonesia. Ringkas bagian dokumen berikut menjadi 2-4 kalimat padat yang mempertahankan fakta, nama, dan angka. Balas hanya ringkasannya.";

export async function buildDocumentContext({ emitProgress, signal } = {}) {
  const body = await getDocumentBodyText();
  if (body.length > HARD_CAP) {
    throw new Error(`Dokumen terlalu panjang (${body.length} karakter; batas ${HARD_CAP}). Pilih bagian yang relevan lalu gunakan konteks Seleksi.`);
  }
  if (body.length <= RAW_LIMIT) return body;

  const docKey = hashText(body);
  if (cache?.docKey === docKey) {
    return cache.chunks.map((c) => c.summary).join("\n\n");
  }
  const chunks = chunkText(body);
  const summarized = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error("dihentikan");
    emitProgress?.(`Membaca dokumen… bagian ${i + 1}/${chunks.length}`);
    const summary = await runTantular({
      system: SUMMARY_SYSTEM,
      user: chunks[i],
      maxTokens: 256,
      temperature: 0.1,
      signal
    });
    summarized.push({ hash: hashText(chunks[i]), summary });
  }
  cache = { docKey, chunks: summarized };
  return summarized.map((c) => c.summary).join("\n\n");
}

export function clearDocumentContextCache() { cache = null; }

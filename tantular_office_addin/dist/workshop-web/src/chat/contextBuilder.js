import { runTantular } from "../tantularClient.js";
import { getDocumentBodyText } from "../officeClient.js";

const RAW_LIMIT = 6000;
const HARD_CAP = 60000;
const CHUNK_SIZE = 3000;
const RETRIEVAL_LIMIT = 12000;

const STOPWORDS = new Set([
  "ada", "adalah", "agar", "akan", "atau", "bisa", "dan", "dari", "dengan", "di",
  "ini", "itu", "ke", "lebih", "pada", "saya", "sebagai", "tentang", "untuk", "yang",
  "a", "an", "and", "are", "be", "can", "detail", "further", "greater", "in", "is",
  "more", "of", "on", "please", "section", "sub", "subsection", "the", "to", "vs"
]);

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

export function normalizeSearchText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(text) {
  return normalizeSearchText(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function quotedPhrases(text) {
  const matches = [...String(text ?? "").matchAll(/["'“”‘’]([^"'“”‘’]{4,160})["'“”‘’]/g)];
  return matches.map((match) => normalizeSearchText(match[1])).filter(Boolean);
}

function looksHeadingLike(text) {
  const value = String(text || "").trim();
  return value.length > 3
    && value.length <= 140
    && !/[.!?]$/.test(value)
    && value.split(/\s+/).length <= 16;
}

// Query-aware extractive retrieval over the raw Word body. This runs before
// lossy document summarization so exact headings/subsections remain findable.
export function selectRelevantContext(bodyText, query, { maxChars = RETRIEVAL_LIMIT } = {}) {
  const body = String(bodyText ?? "").trim();
  const question = String(query ?? "").trim();
  if (!body || !question) return "";

  const paragraphs = body.split(/\n+/).map((text) => text.trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  const queryNorm = normalizeSearchText(question);
  const tokens = [...new Set(searchTokens(question))];
  const phrases = quotedPhrases(question);

  const ranked = paragraphs.map((text, index) => {
    const normalized = normalizeSearchText(text);
    let score = 0;
    for (const phrase of phrases) {
      if (normalized.includes(phrase)) score += 40;
      else {
        const phraseTokens = searchTokens(phrase);
        score += phraseTokens.filter((token) => normalized.includes(token)).length * 4;
      }
    }
    const overlap = tokens.filter((token) => normalized.includes(token)).length;
    score += overlap * 3;
    if (tokens.length && overlap === tokens.length) score += 12;
    if (normalized && queryNorm.includes(normalized) && normalized.length >= 8) score += 10;
    if (looksHeadingLike(text) && overlap >= 2) score += 8;
    return { index, score, text };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!ranked.length) return "";
  const intervals = [];
  for (const hit of ranked.slice(0, 4)) {
    let start = Math.max(0, hit.index - 1);
    let end = Math.min(paragraphs.length, hit.index + 5);
    if (looksHeadingLike(hit.text)) {
      start = hit.index;
      end = Math.min(paragraphs.length, hit.index + 7);
      for (let i = hit.index + 2; i < end; i += 1) {
        if (looksHeadingLike(paragraphs[i])) { end = i; break; }
      }
    }
    if (!intervals.some(([a, b]) => start <= b && end >= a)) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);

  const excerpts = [];
  let used = 0;
  for (const [start, end] of intervals) {
    const excerpt = paragraphs.slice(start, end).join("\n");
    if (!excerpt || used + excerpt.length > maxChars) continue;
    excerpts.push(excerpt);
    used += excerpt.length;
  }
  return excerpts.join("\n\n");
}

// Cache shaped for future per-chunk invalidation (spec): v1 invalidates
// wholesale when the body hash (docKey) changes.
let cache = null; // { docKey, chunks: [{ hash, summary }] }

const SUMMARY_SYSTEM = "Anda peringkas dokumen Bahasa Indonesia. Ringkas bagian dokumen berikut menjadi 2-4 kalimat padat yang mempertahankan fakta, nama, dan angka. Balas hanya ringkasannya.";

export async function buildDocumentContext({ emitProgress, signal, query = "" } = {}) {
  const body = await getDocumentBodyText();
  if (body.length > HARD_CAP) {
    throw new Error(`Dokumen terlalu panjang (${body.length} karakter; batas ${HARD_CAP}). Pilih bagian yang relevan lalu gunakan konteks Seleksi.`);
  }
  const retrieved = selectRelevantContext(body, query);
  if (retrieved) return retrieved;
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

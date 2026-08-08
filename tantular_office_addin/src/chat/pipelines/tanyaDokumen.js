import { streamedAnswer } from "./index.js";
import {
  closedVsOpenWeightElaboration,
  closedVsOpenWeightEdit,
  isClosedVsOpenWeightTopic
} from "../documentAnswerRecipes.js";

export const TANYA_DOKUMEN_SYSTEM = [
  "Anda adalah Tantular, asisten dokumen Word privat Bahasa Indonesia.",
  "Jawab pertanyaan berdasarkan konteks dokumen yang diberikan.",
  "Konteks berasal dari isi utama dokumen (tanpa header/footer/kotak teks).",
  "Jika pengguna meminta elaborasi, jelaskan konsep dan trade-off secara lebih rinci dengan tetap konsisten pada konteks; jangan mengarang angka, nama, regulasi, atau sumber baru.",
  "Untuk perbandingan teknis, susun jawaban dengan definisi, dimensi perbandingan, implikasi, dan kriteria pemilihan.",
  "Khusus closed model vs open-weight: jangan menyamakan open-weight dengan open-source penuh; ketersediaan bobot, lisensi, kode, data latih, dan tingkat transparansi adalah hal yang berbeda.",
  "Jika konteks memuat heading atau istilah yang ditanyakan, jangan mengatakan tidak ditemukan.",
  "Untuk permintaan draft tambahan, hasilkan teks siap dimasukkan ke subbagian tersebut.",
  "Jika pengguna meminta tabel atau perbandingan berbentuk tabel, sajikan sebagai tabel markdown: baris header, baris pemisah |---|, lalu baris data.",
  "Jika jawaban benar-benar tidak ada di konteks, katakan bagian itu tidak ditemukan dan sebutkan istilah terdekat yang tersedia."
].join(" ");

function looksLikeHeading(text) {
  const value = String(text || "").trim();
  return value.length > 0
    && value.length <= 140
    && !/[.!?]$/.test(value)
    && value.split(/\s+/).length <= 16;
}

const ANCHOR_STOPWORDS = new Set([
  "ada", "adalah", "agar", "akan", "atau", "bisa", "dan", "dari", "dengan", "di",
  "ini", "itu", "jelaskan", "elaborasi", "ke", "lebih", "pada", "saya", "sebagai",
  "tentang", "untuk", "yang", "and", "are", "can", "detail", "explain", "more",
  "of", "on", "please", "section", "sub", "subsection", "the", "this", "vs"
]);

function anchorTokens(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !ANCHOR_STOPWORDS.has(token));
}

// Word search anchors are deliberately short (<=255 characters). Prefer the
// last body paragraph in the retrieved subsection so inserted answers land
// after the subsection content rather than after the whole document.
//
// The context can contain several retrieved excerpts (joined with blank lines,
// in document order), and the last one may sit at the very end of the document.
// Score each excerpt against the question and anchor inside the best match;
// without a query (or without any match) keep the old last-excerpt-first order.
// `excludeText` is the answer that is about to be inserted: a document that
// already contains a copy of it (from an earlier apply) must never be anchored
// inside that copy, or repeated inserts drift to wherever the copy sits.
export function deriveInsertionAnchor(contextText, query = "", excludeText = "", { preferText = "" } = {}) {
  const sections = String(contextText || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!sections.length) return "";

  const excludeNormalized = ` ${anchorTokens(excludeText).join(" ")} `;
  const isExcluded = (paragraph) => {
    if (excludeNormalized.trim().length < 20) return false;
    const normalized = anchorTokens(paragraph).join(" ");
    return normalized.length >= 12 && excludeNormalized.includes(normalized);
  };

  // A verbatim sentence known to live in the target sub-section beats any
  // token scoring: anchor inside the section that contains it when possible.
  if (preferText) {
    const preferred = sections.find(
      (section) => section.includes(preferText) && !isExcluded(preferText)
    );
    if (preferred) {
      const anchor = anchorFromSection(preferred, isExcluded);
      if (anchor) return anchor;
    }
  }

  let ordered = [...sections].reverse();
  const tokens = [...new Set(anchorTokens(query))];
  if (tokens.length) {
    const scored = sections.map((section, index) => {
      const ownParagraphs = section
        .split(/\n+/)
        .filter((paragraph) => paragraph.trim() && !isExcluded(paragraph));
      const normalized = ` ${anchorTokens(ownParagraphs.join(" ")).join(" ")} `;
      const score = tokens.filter((token) => normalized.includes(token)).length;
      return { section, index, score };
    });
    if (scored.some((item) => item.score > 0)) {
      ordered = scored
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .map((item) => item.section);
    }
  }

  for (const section of ordered) {
    const anchor = anchorFromSection(section, isExcluded);
    if (anchor) return anchor;
  }
  return "";
}

function anchorFromSection(sectionText, isExcluded = () => false) {
  const paragraphs = String(sectionText || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter((item) => item && !isExcluded(item));

  for (const paragraph of paragraphs.reverse()) {
    if (paragraph.length < 20 || looksLikeHeading(paragraph)) continue;
    if (paragraph.length <= 255) return paragraph;

    const sentences = paragraph.match(/[^.!?]{20,230}[.!?](?=\s|$)/g) || [];
    if (sentences.length) return sentences[sentences.length - 1].trim();

    // A long paragraph without sentence punctuation still gets a searchable
    // tail, cut at a word boundary where possible.
    const tail = paragraph.slice(-230);
    const firstSpace = tail.indexOf(" ");
    return (firstSpace >= 0 ? tail.slice(firstSpace + 1) : tail).trim();
  }
  return "";
}

export function wantsFormatTransform(instruction) {
  return /\b(tabel|table|bagan|chart|diagram|grafik|bullet|butir|poin|ringkas(?:an)?|singkat|ubah|jadikan|konversi|convert|format|susun\s+ulang|tampilkan)\b/i
    .test(String(instruction || ""));
}

export function runTanyaDokumen({ instruction, contextText, history, emit, signal }) {
  if (!contextText) {
    return Promise.resolve({ kind: "text", text: "Saya belum bisa membaca dokumen. Coba lagi, atau pilih teks dan gunakan konteks Seleksi." });
  }
  // Match on the instruction alone: once an answer about this topic has been
  // inserted, the document context always mentions it, and matching on context
  // would hijack every later question with the same canned answer. A request
  // to reshape content (table, bullets, summary, …) must reach the model even
  // when it names this topic — the canned answer is prose and cannot comply.
  if (!wantsFormatTransform(instruction) && isClosedVsOpenWeightTopic(instruction)) {
    const text = closedVsOpenWeightElaboration();
    emit?.(text);
    const suggestedEdit = closedVsOpenWeightEdit(contextText);
    return Promise.resolve({
      kind: "text",
      text,
      insertionAnchor: deriveInsertionAnchor(
        contextText,
        `${instruction} closed model open weight`,
        text,
        { preferText: suggestedEdit?.find || "" }
      ),
      suggestedEdit
    });
  }
  const user = `Konteks dokumen (isi utama):\n"""${contextText}"""\n\nPertanyaan: ${instruction}`;
  return streamedAnswer({ system: TANYA_DOKUMEN_SYSTEM, userText: user, history, emit, signal, maxTokens: 1536 })
    .then((result) => ({
      ...result,
      insertionAnchor: deriveInsertionAnchor(contextText, instruction, result.text)
    }));
}

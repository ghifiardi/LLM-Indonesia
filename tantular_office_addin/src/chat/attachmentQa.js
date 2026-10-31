// Chat over the attached file (2026-09-05). The source card's PDF/DOCX was
// only wired to the Studios; the chat saw the Word body and answered "tidak
// ditemukan" about a book it never received. Two things here, both pure:
//  - counts (pages, paragraphs, words, characters, sections) computed from
//    the extraction — metadata no excerpt can answer, so the model is never
//    asked;
//  - question-driven retrieval over the attachment's own text, keeping the
//    extractor's "[Page N]" markers so the answer can cite a page.

import { selectRelevantContext } from "./contextBuilder.js";

const str = (v) => String(v ?? "");
const PAGE_MARK_RE = /^\[Page (\d+)\]\s*$/m;

export function attachmentLabel(filename) {
  return `Lampiran: ${str(filename) || "file"}`;
}

export function describeAttachment({ filename, kind, text, chars } = {}) {
  const body = str(text).replace(/\r\n?/g, "\n");
  const pageNumbers = [...body.matchAll(/^\[Page (\d+)\]\s*$/gm)].map((m) => Number(m[1]));
  const paragraphs = body.split(/\n{2,}/).map((p) => p.replace(/^\[Page \d+\]\s*/, "").trim()).filter(Boolean);
  const words = body.replace(/\[Page \d+\]/g, " ").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const sections = paragraphs.filter((p) => p.length <= 90 && !/[.!?:]$/.test(p) && p.split(/\s+/).length <= 12).length;
  return {
    filename: str(filename), kind: str(kind),
    pages: pageNumbers.length ? Math.max(...pageNumbers) : null,
    paragraphs: paragraphs.length, words,
    chars: Number(chars) || body.length,
    sections
  };
}

const ASKS = {
  pages: /\b(?:halaman|pages?|laman)\b/i,
  paragraphs: /\b(?:paragraf|paragraphs?|pagagraphs?|alinea)\b/i,
  words: /\b(?:kata|words?)\b/i,
  chars: /\b(?:karakter|characters?|huruf)\b/i,
  sections: /\b(?:bagian|sections?|bab|chapters?)\b/i
};
const COUNT_CUE = /\b(?:berapa|jumlah|banyak|how many|number of|count|total)\b/i;

export function answerAttachmentStats(question, stats) {
  const q = str(question);
  if (!COUNT_CUE.test(q)) return null;
  const asked = Object.entries(ASKS).filter(([, re]) => re.test(q)).map(([k]) => k);
  if (!asked.length) return null;
  const en = /\b(?:how many|pages?|paragraphs?|words?|characters?|sections?|chapters?|does|the book)\b/i.test(q) && !/\b(?:berapa|jumlah|halaman|paragraf|kata)\b/i.test(q);
  const name = stats?.filename || (en ? "the attached file" : "file lampiran");
  const unit = en
    ? { pages: "pages", paragraphs: "paragraphs", words: "words", chars: "characters", sections: "sections or headings" }
    : { pages: "halaman", paragraphs: "paragraf", words: "kata", chars: "karakter", sections: "bagian/judul" };
  const parts = asked.map((k) => {
    const value = stats?.[k];
    if (value === null || value === undefined) {
      return en ? `the page count is not available from the extraction (no page markers in this file type)`
                : `jumlah halaman tidak tersedia dari hasil ekstraksi (tidak ada penanda halaman untuk jenis file ini)`;
    }
    return `${Number(value).toLocaleString(en ? "en-US" : "id-ID")} ${unit[k]}`;
  });
  const lead = en ? `Based on the extracted text of ${name}: ` : `Berdasarkan teks hasil ekstraksi ${name}: `;
  const note = en ? " (counted from the extracted text, not from the model)." : " (dihitung dari teks hasil ekstraksi, bukan dari model).";
  return lead + parts.join(en ? ", " : ", ") + note;
}

const OPENING_CHARS = 6000;

export function retrieveFromAttachment(text, question, { maxChars = 12000 } = {}) {
  const body = str(text).replace(/\r\n?/g, "\n");
  // Keep the page markers attached to their paragraphs so an excerpt carries
  // its page: "[Page 4]\nChapter 2 ..." stays one paragraph for retrieval.
  const withPages = body.replace(/^\[Page (\d+)\]\s*\n/gm, "[Page $1] ");
  const hit = selectRelevantContext(withPages, question, { maxChars });
  if (hit) return { mode: "retrieved", text: hit };
  return { mode: "opening", text: withPages.slice(0, OPENING_CHARS) };
}

const MENTION_RE = /\b(?:lampiran|dilampirkan|melampirkan|saya lampirkan|diunggah|unggahan|upload(?:ed)?|attached|attachment|file (?:tersebut|ini|itu|pdf)|pdf|dokumen yang (?:saya )?(?:unggah|lampirkan)|the book|buku (?:ini|itu|tersebut|yang))\b/i;
export function mentionsAttachment(message) {
  return MENTION_RE.test(str(message));
}

// Tantular Deck Studio — deterministic document → structured deck.
// For long documents (PDF/DOCX/text), a small local model cannot reliably plan
// a deck. This module builds structure directly: detect a title, detect section
// headings, group content, and emit clean slides with concise bullets.

import {
  parseStatementRow,
  statementBullets,
  looksLikeStatement,
  stripBilingualMirror,
  detectPeriods
} from "./statementRows.js";

const HEADING_WORDS = [
  "abstract", "abstrak", "introduction", "pendahuluan", "background", "latar belakang",
  "method", "methods", "methodology", "metodologi", "approach", "pendekatan",
  "results", "hasil", "discussion", "pembahasan", "analysis", "analisis",
  "evaluation", "evaluasi", "experiments", "eksperimen", "related work",
  "conclusion", "kesimpulan", "conclusions", "summary", "ringkasan",
  "future work", "limitations", "keterbatasan", "contributions", "kontribusi",
  "references", "daftar pustaka", "acknowledgments", "overview", "ikhtisar"
];

export function buildDocumentDeckSpec(rawText, slideCount = 8) {
  const text = normalize(rawText);
  if (text.length < 400) return null; // too short; let other paths handle it

  const title = detectTitle(text);
  let sections = detectSections(text);
  if (sections.length < 3) sections = detectSectionsLoose(text);
  const requestedCount = clamp(slideCount, 4, 30);
  if (sections.length < 3) sections = fallbackSections(text, Math.max(3, requestedCount - 3));
  if (!sections.length) return null;

  const count = requestedCount;
  const bodyBudget = Math.max(2, count - 3); // title + agenda + closing reserved
  sections = mergeOrTrimSections(sections, bodyBudget);
  // The requested count is a TARGET, not just a cap. A document with few
  // detected sections used to yield ~6 slides even when the user asked for 20,
  // silently dropping both the request and every sentence past each section's
  // first bullets. Split sentence-rich sections into continuation slides.
  if (sections.length < bodyBudget) sections = expandSectionsToTarget(sections, bodyBudget);

  const periods = documentPeriods(text);

  const slides = [];
  slides.push({
    type: "title",
    headline: title,
    subhead: "Ringkasan terstruktur oleh Tantular Deck Studio"
  });

  slides.push({
    type: "agenda",
    headline: "Agenda",
    bullets: sections.map((s) => truncate(sectionHeadline(s.title), 70)).slice(0, 7)
  });

  // Two slides with the same headline AND the same bullets are a duplicate, not
  // a continuation: section expansion could emit the same statement heading
  // twice with identical content.
  const seen = new Set();
  for (const section of sections) {
    const bullets = toBullets(section.body, section.title, periods);
    if (!bullets.length) continue;
    const headline = truncate(sectionHeadline(section.title), 80);
    const fingerprint = `${headline} ${bullets.join(" ")}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    slides.push({ type: "bullets", headline, bullets });
  }

  slides.push({
    type: "closing",
    headline: "Poin Kunci & Langkah Berikutnya",
    bullets: keyTakeaways(sections)
  });

  return { title, subtitle: "Ringkasan terstruktur", slides };
}

// Section titles come from a group's first line when no heading was detected,
// which put a whole flattened statement row in the headline position:
// "hasil investasi lain-lain 91,003 18,478 from other investments". The row's
// own label is the honest heading; its figures belong in the body.
function sectionHeadline(title) {
  const row = parseStatementRow(title);
  return stripBilingualMirror(row ? row.label : title);
}

// Column years, taken from the first heading in the document that names them.
// A statement page often repeats only the line items, so a row's own heading
// frequently has no years — without this the figures print unlabelled and the
// reader cannot tell 2025 from 2024.
function documentPeriods(text) {
  for (const line of String(text || "").split("\n")) {
    const periods = detectPeriods(line);
    if (periods.length >= 2) return periods;
  }
  return [];
}

// --- detection ---------------------------------------------------------------

function detectTitle(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const skip = /(published as|conference paper|under review|preprint|arxiv|proceedings|copyright|all rights reserved|^\d{4}$|^page \d+)/i;
  const candidates = [];
  for (const raw of lines.slice(0, 25)) {
    const clean = raw.replace(/^\[Page \d+\]\s*/i, "").trim();
    if (clean.length < 8 || clean.length > 120) continue;
    if (skip.test(clean)) continue;
    if (/^abstract|^abstrak|^keywords/i.test(clean)) continue;
    if (!hasEnoughLetters(clean)) continue;
    candidates.push(clean);
  }
  // Prefer an early, title-like line (mostly letters, not a sentence).
  const titleLike = candidates.find((c) => !/[.]$/.test(c) && letterRatio(c) > 0.6);
  return truncate(respaceHeading(titleLike || candidates[0] || lines[0] || "Dokumen"), 100);
}

function detectSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\[Page \d+\]\s*/i, "").trim();
    if (!line) continue;
    if (isHeading(line)) {
      current = { title: cleanHeading(line), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      current = { title: "Ikhtisar", body: [line] };
      sections.push(current);
    }
  }

  return sections
    .map((s) => ({ title: s.title, body: s.body.join("\n").trim() }))
    .filter((s) => s.body.length > 40);
}

function isHeading(line) {
  if (line.length > 90) return false;
  if (!hasEnoughLetters(line)) return false;          // reject axis labels / number rows
  if (letterRatio(line) < 0.45) return false;         // mostly digits/symbols => not a heading
  if (/[.:;,]$/.test(line) && !/^#+/.test(line)) {
    // trailing sentence punctuation usually means it's prose, not a heading
    if (!/^\d+(\.\d+)*\s/.test(line)) return false;
  }
  if (/^#{1,6}\s+\S/.test(line)) return true;                // markdown heading
  if (/^\d+(\.\d+)*\.?\s+[A-Z][A-Za-z]/.test(line) && line.length <= 80) return true; // "3.1 Method"
  const words = line.split(/\s+/);
  if (words.length <= 9) {
    const lower = line.toLowerCase().replace(/^\d+(\.\d+)*\.?\s*/, "");
    if (HEADING_WORDS.some((w) => lower === w || lower.startsWith(w + " ") || lower === w + ":")) return true;
    if (/^[A-Z][A-Z0-9 \-/&]+$/.test(line) && /[A-Z]{3,}/.test(line) && line.length >= 4) return true; // ALLCAPS heading
  }
  return false;
}

function hasEnoughLetters(line) {
  return (line.match(/[A-Za-z]/g) || []).length >= 3;
}

function letterRatio(line) {
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  const nonSpace = line.replace(/\s/g, "").length || 1;
  return letters / nonSpace;
}

function cleanHeading(line) {
  return respaceHeading(line.replace(/^#{1,6}\s+/, "").replace(/:$/, "").trim());
}

// Some PDFs (special title fonts) export headings with no spaces, e.g.
// "DARWINGÖDELMACHINE". Re-insert spaces by greedily splitting long ALL-CAPS
// tokens against a small dictionary. Only applied to titles/headings.
const RESPACE_WORDS = [
  "INTRODUCTION", "BACKGROUND", "METHODOLOGY", "METHODS", "METHOD", "APPROACH",
  "RESULTS", "DISCUSSION", "ANALYSIS", "EVALUATION", "EXPERIMENTS", "RELATED",
  "WORK", "CONCLUSIONS", "CONCLUSION", "SUMMARY", "REFERENCES", "ABSTRACT",
  "LIMITATIONS", "CONTRIBUTIONS", "OVERVIEW", "FUTURE", "EVOLUTION", "MACHINE",
  "AGENTS", "AGENT", "IMPROVING", "IMPROVEMENT", "OPEN", "ENDED", "SELF",
  "DARWIN", "GÖDEL", "GODEL", "OF", "AND", "THE", "FOR", "WITH", "SYSTEM",
  "FRAMEWORK", "MODEL", "LEARNING", "DEEP", "NEURAL", "NETWORK", "SECURITY",
  "PLATFORM", "STRATEGY", "OPERATIONS", "CENTER"
].sort((a, b) => b.length - a.length);

function respaceHeading(text) {
  return String(text || "")
    .split(/(\s+|-|:|,|\/)/)
    .map((tok) => (needsRespace(tok) ? greedySplit(tok) : tok))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function needsRespace(token) {
  if (token.length < 11) return false;
  return /^[A-ZÀ-ÖØ-Þ]+$/.test(token); // uppercase-only run (incl. accents)
}

function greedySplit(token) {
  const out = [];
  let i = 0;
  while (i < token.length) {
    let matched = "";
    for (const w of RESPACE_WORDS) {
      if (token.startsWith(w, i)) { matched = w; break; }
    }
    if (matched) {
      out.push(matched);
      i += matched.length;
    } else {
      // accumulate until the next dictionary word starts
      let j = i + 1;
      while (j < token.length && !RESPACE_WORDS.some((w) => token.startsWith(w, j))) j += 1;
      out.push(token.slice(i, j));
      i = j;
    }
  }
  return out.join(" ");
}

// Second pass for prose/notes-style documents (no numbered/keyword headings):
// a short standalone line without sentence punctuation is very likely a
// heading (e.g. "Primary recommendation: ShinkaEvolve"). Kept separate from
// isHeading() because line-wrapped PDF text would produce false positives.
function detectSectionsLoose(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\[Page \d+\]\s*/i, "").trim();
    if (!line) continue;
    if (isHeading(line) || isLooseHeading(line)) {
      current = { title: cleanHeading(line), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      current = { title: "Ikhtisar", body: [line] };
      sections.push(current);
    }
  }

  const result = sections
    .map((s) => ({ title: s.title, body: s.body.join("\n").trim() }))
    .filter((s) => s.body.length > 40);
  return result.length >= 3 ? result : [];
}

function isLooseHeading(line) {
  if (line.length < 4 || line.length > 60) return false;
  if (/[.!?;,]$/.test(line)) return false;      // sentence punctuation => prose
  if (!hasEnoughLetters(line)) return false;
  if (letterRatio(line) < 0.55) return false;
  if (!/^[A-Z0-9"“(]/.test(line)) return false; // headings start capitalized
  return line.split(/\s+/).length <= 8;
}

function fallbackSections(text, targetGroups = 6) {
  // No clear headings: split into balanced paragraph groups. Split on line
  // breaks only — splitting on ". " would consume the periods and leave each
  // group as one giant run-on sentence (=> a single truncated bullet).
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!paras.length) return [];
  const groups = clamp(targetGroups, 3, 27);
  const perGroup = Math.ceil(paras.length / groups);
  const sections = [];
  for (let i = 0; i < paras.length; i += perGroup) {
    sections.push({
      title: `Bagian ${sections.length + 1}`,
      body: paras.slice(i, i + perGroup).join("\n")
    });
    if (sections.length >= groups) break;
  }
  return sections.filter((s) => s.body.length > 40);
}

// Split the sentence-richest sections in half (repeatedly) until we reach the
// requested body-slide budget or run out of splittable content. Keeps document
// order; continuation slides reuse the section title with "(lanjutan)".
function expandSectionsToTarget(sections, budget) {
  const MIN_SENTENCES_TO_SPLIT = 6; // below this a slide reads fine as-is
  const result = sections.map((s) => ({ ...s, sentences: splitSentences(s.body) }));
  while (result.length < budget) {
    let best = -1;
    let bestLen = MIN_SENTENCES_TO_SPLIT - 1;
    for (let i = 0; i < result.length; i += 1) {
      const len = result[i].sentences?.length || 0;
      if (len > bestLen) { best = i; bestLen = len; }
    }
    if (best === -1) break; // nothing left worth splitting
    const section = result[best];
    const half = Math.ceil(section.sentences.length / 2);
    const partA = section.sentences.slice(0, half);
    const partB = section.sentences.slice(half);
    const contTitle = /\(lanjutan\)$/.test(section.title) ? section.title : `${section.title} (lanjutan)`;
    result.splice(best, 1,
      { title: section.title, body: partA.join(" "), sentences: partA },
      { title: contTitle, body: partB.join(" "), sentences: partB });
  }
  return result.map(({ title, body }) => ({ title, body }));
}

function mergeOrTrimSections(sections, budget) {
  if (sections.length <= budget) return sections;
  // Keep the most substantial sections by body length.
  return [...sections]
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.body.length - a.body.length)
    .slice(0, budget)
    .sort((a, b) => a.i - b.i)
    .map(({ title, body }) => ({ title, body }));
}

// --- content shaping ---------------------------------------------------------

// A statement page is not prose: its line items are rows, not sentences, so
// sentence-splitting dropped every figure on it. Rows are formatted as rows;
// prose lines (the currency basis, notably) are kept verbatim.
function toBullets(body, heading = "", periods = []) {
  if (looksLikeStatement(body)) return statementBullets(body, heading, 7, periods);
  // Section bodies keep their line breaks so statement rows stay separable.
  // Prose does not want them: a sentence wrapped across two source lines must
  // still read as one bullet.
  const sentences = splitSentences(String(body || "").replace(/\s+/g, " "));
  const bullets = [];
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (s.length < 25) continue;
    bullets.push(truncate(s, 150));
    if (bullets.length >= 6) break;
  }
  if (!bullets.length && body) bullets.push(truncate(body, 150));
  return bullets;
}

function keyTakeaways(sections) {
  const picks = [];
  for (const section of sections) {
    const first = splitSentences(section.body)[0];
    if (first && first.length > 30) picks.push(truncate(first, 150));
    if (picks.length >= 4) break;
  }
  if (picks.length < 3) {
    picks.push("Validasi detail terhadap dokumen sumber sebelum keputusan final.");
  }
  return picks.slice(0, 5);
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- helpers -----------------------------------------------------------------

function normalize(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text, max) {
  const t = String(text || "").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
}

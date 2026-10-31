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
// 2026-08-31: title/heading/section detection moved to the neutral
// src/document/extractedStructure.js so Document Studio's deterministic
// fallback can reuse the exact same, already-proven logic instead of a
// second, weaker copy (which is what produced generic "Bagian N" sections on
// a financial-PDF fallback). See that module's own header comment.
import {
  detectTitle as detectTitleShared,
  detectSections,
  detectSectionsLoose,
  normalize,
  truncate
} from "../document/extractedStructure.js";

export function buildDocumentDeckSpec(rawText, slideCount = 8) {
  const text = normalize(rawText);
  if (text.length < 400) return null; // too short; let other paths handle it

  const title = detectTitleShared(text) || "Dokumen";
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
    bullets: keyTakeaways(sections, periods)
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
// detectTitle/detectSections/detectSectionsLoose/isHeading/etc. now live in
// ../document/extractedStructure.js — imported above.

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

function keyTakeaways(sections, periods = []) {
  const picks = [];
  for (const section of sections) {
    // Same conversion the body slides use. Calling splitSentences directly left
    // whole multi-line statement blocks in a single takeaway bullet, because a
    // statement row has no terminal punctuation to split on.
    const bullets = toBullets(section.body, section.title, periods);
    // Prefer a line carrying figures, and never repeat one. Taking bullets[0]
    // blindly filled the takeaways with the same boilerplate three times —
    // "(Dinyatakan dalam ribuan Dolar AS)" heads every statement section.
    const fresh = (b) => b && b.length > 30 && !picks.includes(b);
    const first = bullets.find((b) => fresh(b) && /\d/.test(b)) || bullets.find(fresh);
    if (first) picks.push(truncate(first, 150));
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
// normalize/truncate now come from ../document/extractedStructure.js (imported above).

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
}

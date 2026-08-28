// Tantular Deck Studio — deterministic document → structured deck.
// For long documents (PDF/DOCX/text), a small local model cannot reliably plan
// a deck. This module builds structure directly: detect a title, detect section
// headings, group content, and emit clean slides with concise bullets.

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
  if (sections.length < 3) sections = fallbackSections(text);
  if (!sections.length) return null;

  const count = clamp(slideCount, 4, 14);
  const bodyBudget = Math.max(2, count - 3); // title + agenda + closing reserved
  sections = mergeOrTrimSections(sections, bodyBudget);

  const slides = [];
  slides.push({
    type: "title",
    headline: title,
    subhead: "Ringkasan terstruktur oleh Tantular Deck Studio"
  });

  slides.push({
    type: "agenda",
    headline: "Agenda",
    bullets: sections.map((s) => truncate(s.title, 70)).slice(0, 7)
  });

  for (const section of sections) {
    const bullets = toBullets(section.body);
    if (!bullets.length) continue;
    slides.push({
      type: "bullets",
      headline: truncate(section.title, 80),
      bullets
    });
  }

  slides.push({
    type: "closing",
    headline: "Poin Kunci & Langkah Berikutnya",
    bullets: keyTakeaways(sections)
  });

  return { title, subtitle: "Ringkasan terstruktur", slides };
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
    .map((s) => ({ title: s.title, body: s.body.join(" ").trim() }))
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
    .map((s) => ({ title: s.title, body: s.body.join(" ").trim() }))
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

function fallbackSections(text) {
  // No clear headings: split into balanced paragraph groups. Split on line
  // breaks only — splitting on ". " would consume the periods and leave each
  // group as one giant run-on sentence (=> a single truncated bullet).
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!paras.length) return [];
  const groups = 6;
  const perGroup = Math.ceil(paras.length / groups);
  const sections = [];
  for (let i = 0; i < paras.length; i += perGroup) {
    sections.push({
      title: `Bagian ${sections.length + 1}`,
      body: paras.slice(i, i + perGroup).join(" ")
    });
    if (sections.length >= groups) break;
  }
  return sections.filter((s) => s.body.length > 40);
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

function toBullets(body) {
  const sentences = splitSentences(body);
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

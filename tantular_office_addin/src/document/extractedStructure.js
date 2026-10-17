// Deterministic structure detection over flattened extractor text — shared
// between Deck Studio and Document Studio's fallback path.
//
// 2026-08-31: this logic already existed, proven and tested, inside
// src/deck/documentDeck.js (title detection, heading detection, bilingual
// mirror stripping via statementRows.js). Document Studio's own fallback
// (documentPlanner.js's old fallbackSections()) never used it — it just cut
// the flattened text into evenly-sized chunks labeled "Bagian 1", "Bagian 2",
// which is exactly the bug a financial-PDF-to-Word screenshot demonstrated:
// a bilingual cover page and financial statement rows got shredded into
// generic, meaningless sections. Moved here as the single, neutral place
// documentDeck.js AND documentPlanner.js both import from, rather than
// letting a second, inconsistent copy of this detection logic exist.
//
// Deliberately text-pattern based, not a real OOXML/PDF structural parser:
// it operates on the SAME flattened text (with "[Page N]"/"[Slide N]"/
// "[Sheet: Name]" markers already preserved by tools/document-extractor.py)
// that already reaches the model prompt today. This is a scoped fix for the
// demonstrated fallback-quality bug, not the full per-format block-level
// extraction IR — see documentPlanner.js's own comment on
// buildDeterministicDocumentSpec() for what that would additionally require.

import { parseStatementRow, stripBilingualMirror, isStatementRow } from "../deck/statementRows.js";

const HEADING_WORDS = [
  "abstract", "abstrak", "introduction", "pendahuluan", "background", "latar belakang",
  "method", "methods", "methodology", "metodologi", "approach", "pendekatan",
  "results", "hasil", "discussion", "pembahasan", "analysis", "analisis",
  "evaluation", "evaluasi", "experiments", "eksperimen", "related work",
  "conclusion", "kesimpulan", "conclusions", "summary", "ringkasan",
  "future work", "limitations", "keterbatasan", "contributions", "kontribusi",
  "references", "daftar pustaka", "acknowledgments", "overview", "ikhtisar"
];

// Financial-statement heading vocabulary (Phase 5's acceptance list), grouped
// by canonical category rather than a flat word list — this lets a consumer
// tell "these two headings are the same statement, just two languages"
// (financial_position + financial_position) apart from "these are two
// DIFFERENT statements that both happen to be headings"
// (financial_position + profit_or_loss). See statementHeadingKind() below.
const STATEMENT_HEADING_CATEGORIES = [
  { kind: "financial_position", phrases: ["laporan posisi keuangan", "statement of financial position", "statements of financial position"] },
  { kind: "profit_or_loss", phrases: ["laporan laba rugi", "laba rugi", "profit or loss"] },
  { kind: "cash_flows", phrases: ["arus kas", "cash flows", "statement of cash flows", "statements of cash flows"] },
  { kind: "changes_in_equity", phrases: ["perubahan ekuitas", "changes in equity", "statement of changes in equity"] },
  { kind: "independent_auditor", phrases: ["auditor independen", "independent auditor", "independent auditor's report"] },
  { kind: "financial_notes", phrases: ["catatan atas laporan keuangan", "notes to the financial statements"] }
];

// Removes lines that repeat across at least 3 distinct pages/slides/sheets —
// running headers/footers ("PT Company Name — Report Title", printed on
// every page). Deliberately page-position-aware, unlike the existing
// src/document/sourceCompaction.js (explicitly NOT used here — see that
// file's own warning: a raw global-frequency count with no page-boundary
// provenance can remove a legitimate short line that happens to repeat
// three times within a single page or a short document). This only counts a
// line once per DISTINCT page/slide/sheet marker, so a line must genuinely
// recur across pages — not just appear near other repeated lines — before
// it is treated as boilerplate. Short lines only (<=200 chars): a real
// repeated PARAGRAPH is extremely unlikely and worth keeping rather than
// risking a false positive on substantive content.
export function stripRepeatedPageLines(text) {
  const lines = String(text || "").split("\n");
  let page = null; // composite key: "page:N" | "slide:N" | "sheet:Name" | null
  const pagesByLine = new Map();
  const parsed = lines.map((rawLine) => {
    const pageMatch = rawLine.match(/^\[Page (\d+)\]\s*(.*)$/i);
    const slideMatch = rawLine.match(/^\[Slide (\d+)(?:\s*\|[^\]]*)?\]\s*(.*)$/i);
    const sheetMatch = rawLine.match(/^\[Sheet:\s*([^\]]+)\]\s*(.*)$/i);
    let content = rawLine;
    let isMarker = false;
    if (pageMatch) { page = `page:${pageMatch[1]}`; content = pageMatch[2]; isMarker = true; }
    else if (slideMatch) { page = `slide:${slideMatch[1]}`; content = slideMatch[2]; isMarker = true; }
    else if (sheetMatch) { page = `sheet:${sheetMatch[1]}`; content = sheetMatch[2]; isMarker = true; }
    const trimmed = content.trim();
    if (trimmed && trimmed.length <= 200) {
      if (!pagesByLine.has(trimmed)) pagesByLine.set(trimmed, new Set());
      pagesByLine.get(trimmed).add(page);
    }
    return { rawLine, isMarker, trimmed, page };
  });

  const repeated = new Set(
    [...pagesByLine.entries()]
      .filter(([, pages]) => pages.size >= 3)
      .map(([lineText]) => lineText)
  );
  if (!repeated.size) return String(text || "");

  const kept = [];
  for (const { rawLine, isMarker, trimmed } of parsed) {
    if (isMarker) { kept.push(rawLine); continue; }
    if (trimmed && repeated.has(trimmed)) continue; // drop the repeated header/footer line
    kept.push(rawLine);
  }
  return kept.join("\n");
}

export function normalize(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text, max) {
  const t = String(text || "").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export function hasEnoughLetters(line) {
  return (line.match(/[A-Za-z]/g) || []).length >= 3;
}

export function letterRatio(line) {
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  const nonSpace = line.replace(/\s/g, "").length || 1;
  return letters / nonSpace;
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
      let j = i + 1;
      while (j < token.length && !RESPACE_WORDS.some((w) => token.startsWith(w, j))) j += 1;
      out.push(token.slice(i, j));
      i = j;
    }
  }
  return out.join(" ");
}

export function respaceHeading(text) {
  return String(text || "")
    .split(/(\s+|-|:|,|\/)/)
    .map((tok) => (needsRespace(tok) ? greedySplit(tok) : tok))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function cleanHeading(line) {
  // A bilingual heading is sometimes wrapped as "LAPORAN POSISI KEUANGAN/"
  // with the English mirror on the next line — the trailing "/" is a
  // line-wrap artifact, not part of the heading text.
  return respaceHeading(line.replace(/^#{1,6}\s+/, "").replace(/:$/, "").replace(/\/$/, "").trim());
}

// True when `line` names a recognized financial-statement heading (Indonesian
// or English, or the bilingual mirror of both). Checked before the generic
// heading heuristics so a statement title is never mistaken for prose merely
// because it is long or ends without a period.
//
// Substring matching alone is NOT enough: an ordinary sentence discussing a
// statement ("...bagian penting dari laporan posisi keuangan perusahaan...")
// legitimately contains the phrase without being a heading. A real heading
// line is short, mostly IS the phrase, and does not end in sentence
// punctuation — this requires the matched phrase to cover a large share of
// the line's own length, not just appear somewhere inside a longer sentence.
// Returns the canonical statement category ("financial_position",
// "profit_or_loss", ...) a line names, or null when it names none. Two
// headings sharing a category are the SAME statement (just two languages);
// two headings with different (non-null) categories are genuinely different
// statements and must never be treated as a mirror pair of each other — see
// splitOnHeadings()'s use of this for consecutive-heading suppression.
export function statementHeadingKind(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.length > 160) return null;
  if (/[.,;]$/.test(raw)) return null; // sentence-terminal punctuation => prose
  // A bilingual mirror can be space-separated ("X X") — stripBilingualMirror
  // handles that — or slash-joined with no surrounding space ("X/Y", the
  // real report formatting, e.g. "LAPORAN LABA RUGI/PROFIT OR LOSS"). Check
  // the whole (mirror-stripped) line AND each "/"-segment independently, so
  // either language half passing the coverage-ratio check is sufficient.
  const candidates = [stripBilingualMirror(raw), ...raw.split("/")]
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  for (const lower of candidates) {
    for (const { kind, phrases } of STATEMENT_HEADING_CATEGORIES) {
      const match = phrases.find((w) => lower.includes(w));
      // The phrase must account for a large share of its segment — a heading
      // like "LAPORAN LABA RUGI" is ALMOST ENTIRELY the phrase itself, give
      // or take a few connector words/dates; a sentence merely mentioning it
      // is not.
      if (match && match.length / lower.length >= 0.5) return kind;
    }
  }
  return null;
}

export function isStatementHeading(line) {
  return statementHeadingKind(line) !== null;
}

export function isHeading(line) {
  if (isStatementHeading(line)) return true;
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

export function isLooseHeading(line) {
  if (line.length < 4 || line.length > 60) return false;
  if (/[.!?;,]$/.test(line)) return false;      // sentence punctuation => prose
  if (!hasEnoughLetters(line)) return false;
  if (letterRatio(line) < 0.55) return false;
  if (!/^[A-Z0-9"“(]/.test(line)) return false; // headings start capitalized
  return line.split(/\s+/).length <= 8;
}

// Detects a document title from the first ~25 non-empty lines. Skips
// page/slide/sheet markers, boilerplate ("published as", "page N"), and any
// line that is actually a financial statement row (its own label, not the
// figures, would be the honest heading — a title is never a row).
export function detectTitle(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const skip = /(published as|conference paper|under review|preprint|arxiv|proceedings|copyright|all rights reserved|^\d{4}$|^page \d+)/i;
  const marker = /^\[(page|slide)\s+\d+[^\]]*\]|^\[sheet:[^\]]*\]/i;
  const candidates = [];
  for (const raw of lines.slice(0, 25)) {
    const clean = raw.replace(marker, "").trim();
    if (!clean) continue;
    if (clean.length < 8 || clean.length > 120) continue;
    if (skip.test(clean)) continue;
    if (/^abstract|^abstrak|^keywords/i.test(clean)) continue;
    if (!hasEnoughLetters(clean)) continue;
    if (isStatementRow(clean)) continue;
    candidates.push(clean);
  }
  const titleLike = candidates.find((c) => !/[.]$/.test(c) && letterRatio(c) > 0.6);
  const chosen = titleLike || candidates[0] || lines[0] || "";
  return truncate(stripBilingualMirror(respaceHeading(chosen)), 100);
}

// Splits flattened text into { title, body } sections at detected headings.
// Page/slide/sheet markers are stripped from the line used for detection but
// kept attached to the section body via `page`/`slide`/`sheet` provenance so
// a marker itself never becomes a paragraph of body text.
function splitOnHeadings(text, headingTest) {
  const lines = String(text || "").split("\n");
  const sections = [];
  let current = null;
  let page = null;
  let slide = null;
  let sheet = null;

  for (const rawLine of lines) {
    const pageMatch = rawLine.match(/^\[Page (\d+)\]\s*(.*)$/i);
    const slideMatch = rawLine.match(/^\[Slide (\d+)(?:\s*\|[^\]]*)?\]\s*(.*)$/i);
    const sheetMatch = rawLine.match(/^\[Sheet:\s*([^\]]+)\]\s*(.*)$/i);
    let line = rawLine.trim();
    if (pageMatch) { page = Number(pageMatch[1]); line = pageMatch[2].trim(); }
    else if (slideMatch) { slide = Number(slideMatch[1]); line = slideMatch[2].trim(); }
    else if (sheetMatch) { sheet = sheetMatch[1].trim(); line = sheetMatch[2].trim(); }
    if (!line) continue;
    if (headingTest(line)) {
      // A bilingual heading is often printed as two consecutive lines — the
      // Indonesian line, then its English mirror directly below, with no
      // body content between them (e.g. "LAPORAN POSISI KEUANGAN/" then
      // "STATEMENT OF FINANCIAL POSITION"). Without any check here, the
      // second heading line closes the first section with an EMPTY body,
      // which the final length filter below then silently drops.
      //
      // But two consecutive headings are not ALWAYS a mirror pair — "LAPORAN
      // POSISI KEUANGAN" immediately followed by "LAPORAN LABA RUGI" (no body
      // between them, e.g. an empty statement) are two genuinely different
      // sections, and suppressing the second would silently discard it. Only
      // suppress when both lines name the SAME canonical statement category
      // — a real, conservative mirror test, not "any two adjacent headings".
      // Two headings that are neither recognized statement categories are
      // never suppressed here: each becomes its own section (the earlier one
      // is later dropped by the empty-body length filter below if it truly
      // never gained body content, same as it always has — this only ever
      // widens what survives, never narrows it further).
      const pendingKind = current && current.body.length === 0 ? statementHeadingKind(current.rawHeadingLine) : null;
      if (pendingKind && pendingKind === statementHeadingKind(line)) continue;
      current = { title: cleanHeading(line), body: [], page, slide, sheet, rawHeadingLine: line };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      current = { title: "Ikhtisar", body: [line], page, slide, sheet };
      sections.push(current);
    }
  }

  return sections
    .map((s) => ({ title: s.title, body: s.body.join("\n").trim(), page: s.page, slide: s.slide, sheet: s.sheet }))
    .filter((s) => s.body.length > 40);
}

export function detectSections(text) {
  return splitOnHeadings(text, isHeading);
}

// Second pass for prose/notes-style documents (no numbered/keyword headings):
// a short standalone line without sentence punctuation is very likely a
// heading. Kept separate from detectSections() because line-wrapped PDF text
// would produce false positives if applied everywhere.
export function detectSectionsLoose(text) {
  const result = splitOnHeadings(text, (line) => isHeading(line) || isLooseHeading(line));
  return result.length >= 3 ? result : [];
}

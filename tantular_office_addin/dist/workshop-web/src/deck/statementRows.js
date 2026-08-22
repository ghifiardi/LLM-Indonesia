// Parsing for financial statement rows flattened out of a bilingual PDF.
//
// An Indonesian listed-company report is laid out in four columns:
//
//     hasil investasi lain-lain    91,003   18,478   from other investments
//     └── Indonesian label ──┘    └─2025─┘ └─2024─┘  └── English label ──┘
//
// Layout-mode PDF extraction flattens that into one line. The row survives
// intact, but nothing downstream knows it is a row — so it was treated as a
// sentence, and a whole row ended up as a slide headline.
//
// This module recognises the shape and takes it apart, so figures can be
// presented as figures and a row can be kept out of the heading position.

// A figure: 91,003 · 1.234.567 · (27,344) for negatives · 12,5% · a bare dash
// for nil. Parenthesised negatives are the accounting convention throughout.
const FIGURE = /^\(?-?[\d][\d.,]*%?\)?$|^[-–—]$/;

function isFigure(token) {
  return FIGURE.test(token) && /[\d-–—]/.test(token);
}

function hasLetters(text) {
  return /[A-Za-zÀ-ÿ]/.test(text);
}

/**
 * Split a flattened row into its label, its figures, and the trailing
 * translated label.
 *
 * Returns null when the line is not a statement row — including for bilingual
 * headings like "31 DESEMBER 2025 DAN 2024 31 DECEMBER 2025 AND 2024", where
 * the digits are part of the prose rather than a column of figures.
 */
export function parseStatementRow(line) {
  const tokens = String(line || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  // Find the longest contiguous run of figures. Years embedded in a heading
  // form runs of one and are rejected below; a real column block is >= 2.
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let totalFigures = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && isFigure(tokens[i])) {
      totalFigures++;
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const length = i - start;
      if (length > bestLength) { bestLength = length; bestStart = start; }
      start = -1;
    }
  }
  if (bestLength < 2) return null;

  // A statement row has exactly ONE block of figures: the value columns. Digits
  // loose in the label or the mirror mean this is prose that happens to contain
  // numbers — "31 DESEMBER 2025 DAN 2024 31 DECEMBER 2025 AND 2024" otherwise
  // parses as a row, because "2024 31" is adjacent across the language boundary.
  if (bestLength !== totalFigures) return null;

  const label = tokens.slice(0, bestStart).join(" ").trim();
  const values = tokens.slice(bestStart, bestStart + bestLength);
  const trailing = tokens.slice(bestStart + bestLength).join(" ").trim();

  // A row must be labelled. A bare run of figures is a column fragment, not a
  // line item, and presenting it would invent a meaning it does not have.
  if (!label || !hasLetters(label)) return null;

  return { label, values, labelEn: trailing && hasLetters(trailing) ? trailing : "" };
}

export function isStatementRow(line) {
  return parseStatementRow(line) !== null;
}

/**
 * Render a parsed row for a slide bullet.
 *
 * The English mirror is dropped: it doubles the length of every bullet and
 * carries no information the Indonesian label does not already carry. Column
 * years are labelled when supplied, because "91,003 18,478" alone does not say
 * which year is which.
 */
export function formatStatementRow(row, periods = []) {
  if (!row) return "";
  const parts = row.values.map((value, i) => (
    periods[i] ? `${periods[i]}: ${value}` : value
  ));
  return `${row.label} — ${parts.join(" · ")}`;
}

// Column periods, read from a heading such as
// "31 DESEMBER 2025 DAN 2024 31 DECEMBER 2025 AND 2024" -> ["2025", "2024"].
// Deduped in order, so the English mirror does not add phantom columns.
export function detectPeriods(heading) {
  const years = String(heading || "").match(/\b(19|20)\d{2}\b/g) || [];
  return [...new Set(years)];
}

/**
 * Turn a statement-heavy body into bullets, one per line item.
 *
 * Non-row lines are kept as-is: a statement page carries real prose too
 * (currency basis, "Dinyatakan dalam ribuan Dolar AS"), and dropping it would
 * strip the figures of their unit.
 */
export function statementBullets(body, heading = "", limit = 7, fallbackPeriods = []) {
  // A statement page usually repeats only its line items, so the row's own
  // heading often names no years; the document-level periods stand in.
  const fromHeading = detectPeriods(heading);
  const periods = fromHeading.length >= 2 ? fromHeading : fallbackPeriods;
  const bullets = [];
  for (const line of String(body || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = parseStatementRow(trimmed);
    bullets.push(row ? formatStatementRow(row, periods) : trimmed);
    if (bullets.length >= limit) break;
  }
  return bullets;
}

/**
 * Drop the English half of a mirrored bilingual heading.
 *
 * The report prints each heading twice, side by side, and layout extraction
 * joins them: "31 DESEMBER 2025 DAN 2024 31 DECEMBER 2025 AND 2024",
 * "1. UMUM 1. GENERAL". The mirror is detected structurally — the second half
 * restarts with the first token, and the halves are the same length — rather
 * than by translating, so it does not depend on a vocabulary.
 */
export function stripBilingualMirror(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return String(text || "").trim();
  for (let i = 2; i < tokens.length - 1; i++) {
    if (tokens[i] !== tokens[0]) continue;
    // Halves must be near-equal in length; a heading that merely repeats a word
    // partway through is not a mirror.
    if (Math.abs((tokens.length - i) - i) > 1) continue;
    return tokens.slice(0, i).join(" ");
  }
  return String(text || "").trim();
}

/** Does this body look like a statement rather than prose? */
export function looksLikeStatement(body) {
  const lines = String(body || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const rows = lines.filter(isStatementRow).length;
  return rows / lines.length >= 0.4;
}

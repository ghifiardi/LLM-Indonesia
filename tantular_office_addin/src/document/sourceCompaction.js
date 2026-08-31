// Safe, deterministic compaction for extracted Word/PowerPoint/PDF text
// before it reaches the model. Purely mechanical — never summarizes,
// paraphrases, or rewrites meaning, and never drops a paragraph for being
// merely SIMILAR rather than an exact duplicate. Real extracted documents
// routinely carry repeated slide/page headers and footers and blank-line
// runs that cost prompt-evaluation time without adding information; this
// removes exactly that, nothing else.
//
// Deliberately conservative: when in doubt, keep the line. A false removal
// (dropping something unique) would violate the product's own grounding
// guarantee; a missed removal (leaving boilerplate in) only costs a few
// tokens.

const HEADER_FOOTER_MIN_REPEATS = 3;
const HEADER_FOOTER_MAX_LINE_CHARS = 80;

function normalizeForComparison(line) {
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

export function compactSource(text) {
  const original = String(text || "");
  if (!original.trim()) {
    return { text: original, originalChars: original.length, compactedChars: original.length, removedChars: 0 };
  }

  // 1) Normalize line endings and split, preserving line order throughout.
  const rawLines = original.replace(/\r\n?/g, "\n").split("\n");

  // 2) Find candidate headers/footers: short lines that recur verbatim
  // (after whitespace/case normalization) at least HEADER_FOOTER_MIN_REPEATS
  // times. Page numbers, slide titles repeated on every slide, running
  // headers — the shape of thing extraction tools duplicate across pages.
  // Length-capped so a genuinely short but substantive sentence that happens
  // to repeat (e.g. a defined term) is far less likely to be caught — real
  // boilerplate is short BY NATURE (headers/footers/page numbers).
  const counts = new Map();
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > HEADER_FOOTER_MAX_LINE_CHARS) continue;
    const key = normalizeForComparison(trimmed);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const boilerplateKeys = new Set(
    [...counts.entries()].filter(([, n]) => n >= HEADER_FOOTER_MIN_REPEATS).map(([key]) => key)
  );

  // 3) Walk lines in order, applying (in this order, each independently
  // safe): drop boilerplate-header/footer lines, collapse exact-duplicate
  // ADJACENT non-empty lines (a real extraction artifact — the same
  // paragraph emitted twice back to back — never a legitimate case of two
  // genuinely different consecutive lines sharing exact text), and collapse
  // runs of 2+ blank lines down to one paragraph-separator blank line.
  const kept = [];
  let previousNormalized = null;
  let blankRun = 0;
  let removedChars = 0;

  for (const line of rawLines) {
    const trimmed = line.trim();

    if (!trimmed) {
      blankRun += 1;
      if (blankRun <= 1) kept.push("");
      else removedChars += line.length + 1; // +1 for the newline this line contributed
      continue;
    }
    blankRun = 0;

    const normalized = normalizeForComparison(trimmed);

    if (boilerplateKeys.has(normalized)) {
      removedChars += line.length + 1;
      continue;
    }
    if (normalized === previousNormalized) {
      // Exact adjacent duplicate — extraction artifacts (a heading emitted
      // once as a title and again as the first body line), not two
      // different sentences that happen to read the same.
      removedChars += line.length + 1;
      continue;
    }

    kept.push(line);
    previousNormalized = normalized;
  }

  // Trim a trailing blank line the loop above may have kept.
  while (kept.length && kept[kept.length - 1] === "") kept.pop();

  const compacted = kept.join("\n");
  return {
    text: compacted,
    originalChars: original.length,
    compactedChars: compacted.length,
    removedChars: original.length - compacted.length
  };
}

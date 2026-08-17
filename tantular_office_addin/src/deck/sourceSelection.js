// Bounded, explicit source selection for long documents.
//
// Before this, Deck Studio handed the entire extracted document downstream and
// hoped it fit. For a financial report that is several hundred thousand
// characters, the overflow was discarded with no error and no warning — the
// deck was built from whatever fragment happened to survive, and looked like a
// successful run. The silent truncation was the bug.
//
// So: chunk by document structure first and size second, score chunks against
// financial-statement intent, select up to an explicit token budget, and carry
// provenance (page + heading) into the prompt. What was dropped is reported,
// never swallowed.
//
// Everything here is pure and synchronous so it can be tested without a model,
// a companion, or an Office host.

// Kept in step with models/Modelfile.office-9b. Raising num_ctx was rejected
// deliberately: 131072 on a 9B model turns memory pressure and latency into the
// next workshop failure on attendee laptops.
export const MODEL_CONTEXT_TOKENS = 32768;
export const RESERVED_OUTPUT_TOKENS = 8192; // PARAMETER num_predict
export const RESERVED_PROMPT_TOKENS = 2048; // system prompt, instructions, JSON scaffold
export const SOURCE_TOKEN_BUDGET =
  MODEL_CONTEXT_TOKENS - RESERVED_OUTPUT_TOKENS - RESERVED_PROMPT_TOKENS;

// Indonesian/English mixed financial text runs denser than plain English prose:
// long compound words, many digits and separators. 3.5 chars/token is a
// deliberate under-estimate of capacity (i.e. it over-estimates token count),
// because overshooting the context is silent while undershooting is merely
// slightly wasteful.
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / CHARS_PER_TOKEN);
}

// Hard ceiling per chunk so one enormous unbroken section cannot consume the
// whole budget on its own.
const MAX_CHUNK_CHARS = 6000;

// Statement-intent vocabulary, Indonesian and English. Financial reports in
// Indonesia are routinely bilingual in the same line, so both forms appear.
const INTENT_PATTERNS = [
  { weight: 10, re: /laporan\s+posisi\s+keuangan|statements?\s+of\s+financial\s+position|neraca\b|balance\s+sheets?/i },
  { weight: 10, re: /laba\s+rugi|profit\s+or\s+loss|comprehensive\s+income|penghasilan\s+komprehensif/i },
  { weight: 9, re: /arus\s+kas|cash\s+flows?/i },
  { weight: 8, re: /perubahan\s+ekuitas|changes\s+in\s+equity/i },
  { weight: 6, re: /konsolidasian|consolidated/i },
  { weight: 4, re: /aset\s+lancar|aset\s+tidak\s+lancar|current\s+assets|non-?current\s+assets/i },
  { weight: 4, re: /liabilitas|liabilit(y|ies)|ekuitas|equity/i },
  { weight: 3, re: /pendapatan|revenue|beban\s+pokok|cost\s+of\s+revenue/i },
];

// Notes are enormous and dominate any financial report by volume. Including
// them by default would crowd out the statements themselves, so they are
// negatively weighted unless explicitly requested.
const NOTES_PATTERN = /catatan\s+atas\s+laporan\s+keuangan|notes\s+to\s+the\s+(consolidated\s+)?financial/i;

const PAGE_MARKER = /^\[Page (\d+)\]$/;
const SLIDE_MARKER = /^\[Slide (\d+)(?:\s*\|\s*id\s*([^\]]+))?\]$/;

// A heading in extracted PDF text: short, not sentence-punctuated, and either
// mostly uppercase or a known statement title. Deliberately conservative —
// line-wrapped body text produces false positives otherwise.
function isHeading(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (/[.;]$/.test(trimmed)) return false;
  if (INTENT_PATTERNS.some((p) => p.re.test(trimmed))) return true;
  const letters = trimmed.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, "").length;
  return upper / letters.length > 0.7;
}

// Fraction of tokens on a line that look like figures. Statement rows are
// mostly numbers; prose is not. This is what distinguishes a balance sheet from
// a paragraph that merely mentions one.
export function numericDensity(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const numeric = words.filter((w) => /^\(?-?[\d.,]+\)?$/.test(w) && /\d/.test(w)).length;
  return numeric / words.length;
}

// Structure first (page markers, then headings), size second. Size-splitting
// only ever happens inside a structural unit, so a chunk never straddles two
// sections and provenance stays truthful.
export function chunkDocument(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const chunks = [];
  let page = null;
  let heading = null;
  let buffer = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    for (const piece of splitBySize(body)) {
      chunks.push({
        index: chunks.length,
        page,
        heading,
        text: piece,
        tokens: estimateTokens(piece),
      });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const pageMatch = trimmed.match(PAGE_MARKER) || trimmed.match(SLIDE_MARKER);
    if (pageMatch) {
      flush();
      page = Number(pageMatch[1]);
      heading = null;
      continue;
    }
    if (isHeading(trimmed)) {
      flush();
      heading = trimmed;
      // The heading is part of its own chunk: a statement title carries the
      // period and currency basis, which the slide needs.
      buffer.push(trimmed);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

function splitBySize(body) {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const out = [];
  const paragraphs = body.split(/\n{2,}/);
  let current = "";
  for (const para of paragraphs) {
    // A single paragraph over the cap is split on line boundaries rather than
    // mid-row, so a statement line is never cut in half.
    if (para.length > MAX_CHUNK_CHARS) {
      if (current.trim()) { out.push(current.trim()); current = ""; }
      let lineBuf = "";
      for (const line of para.split("\n")) {
        if ((lineBuf + "\n" + line).length > MAX_CHUNK_CHARS && lineBuf.trim()) {
          out.push(lineBuf.trim());
          lineBuf = "";
        }
        lineBuf += (lineBuf ? "\n" : "") + line;
      }
      if (lineBuf.trim()) out.push(lineBuf.trim());
      continue;
    }
    if ((current + "\n\n" + para).length > MAX_CHUNK_CHARS && current.trim()) {
      out.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function scoreChunk(chunk, { includeNotes = false } = {}) {
  const haystack = `${chunk.heading || ""}\n${chunk.text || ""}`;
  let score = 0;
  for (const { weight, re } of INTENT_PATTERNS) {
    if (re.test(haystack)) score += weight;
    // A statement title in the heading is far stronger evidence than the same
    // words buried in a paragraph.
    if (chunk.heading && re.test(chunk.heading)) score += weight;
  }
  // A notes heading always contains "konsolidasian"/"consolidated" and so
  // collects the statement bonus twice over. The penalty must outweigh that
  // outright, or notes tie with the statements and win on volume.
  if (NOTES_PATTERN.test(haystack)) score += includeNotes ? 4 : -24;
  // Actual figures, not just talk about them.
  score += Math.round(numericDensity(chunk.text) * 12);
  return score;
}

/**
 * Select as much statement-relevant source as fits the budget.
 *
 * Returns selection metadata rather than just text, so callers can warn. A
 * caller that ignores `truncated` reintroduces the original bug.
 */
export function selectSource(text, { budget = SOURCE_TOKEN_BUDGET, includeNotes = false } = {}) {
  const chunks = chunkDocument(text);
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
  const scored = chunks.map((c) => ({ ...c, score: scoreChunk(c, { includeNotes }) }));

  // Rank by intent, but emit in document order: a balance sheet read out of
  // sequence is worse than one that is merely incomplete.
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let used = 0;
  for (const chunk of ranked) {
    if (used + chunk.tokens > budget) continue; // keep trying: a later chunk may still fit
    selected.push(chunk);
    used += chunk.tokens;
  }
  selected.sort((a, b) => a.index - b.index);

  const dropped = scored.filter((c) => !selected.includes(c));
  return {
    chunks: scored,
    selected,
    dropped,
    tokensSelected: used,
    tokensTotal: totalTokens,
    budget,
    truncated: dropped.length > 0,
    exhaustive: dropped.length === 0,
  };
}

function provenanceLabel(chunk) {
  const parts = [];
  if (chunk.page != null) parts.push(`hal. ${chunk.page}`);
  if (chunk.heading) parts.push(chunk.heading);
  return parts.length ? `[Sumber: ${parts.join(" — ")}]` : `[Sumber: bagian ${chunk.index + 1}]`;
}

/**
 * The selected source as plain document text, for consumers that treat their
 * input as CONTENT — notably buildDocumentDeckSpec, which structures text
 * deterministically into slides.
 *
 * Deliberately unannotated: annotating this stream put "[Sumber: hal. 1 — ...]"
 * on a slide headline, because a deterministic builder cannot tell a note about
 * the text from the text. Provenance for that path travels via
 * selectionInstruction() instead.
 */
export function selectedSourceText(selection) {
  return selection.selected.map((chunk) => chunk.text).join("\n\n");
}

/**
 * Provenance and coverage for the PROMPT channel — appended to deck
 * instructions, never mixed into the source body.
 *
 * Returns "" when the whole document fits: a model told to hedge about
 * completeness when the source *is* complete produces needlessly vague slides.
 */
export function selectionInstruction(selection) {
  if (selection.exhaustive) return "";
  const cited = selection.selected
    .map((chunk) => provenanceLabel(chunk))
    .filter((label, i, all) => all.indexOf(label) === i)
    .slice(0, 12)
    .join("; ");
  return (
    `Teks sumber DIPILIH, bukan seluruh dokumen: ` +
    `${selection.selected.length} dari ${selection.chunks.length} bagian, ` +
    `dipilih karena paling relevan dengan laporan keuangan. ` +
    `Bagian yang disertakan: ${cited}. ` +
    `Jangan menyatakan atau menyiratkan cakupan menyeluruh atas dokumen; ` +
    `sebut hanya angka yang benar-benar ada di teks sumber.`
  );
}

/** User-facing warning, or null when the whole document fits. */
export function describeSelection(selection, filename = "") {
  if (selection.exhaustive) return null;
  const from = filename ? ` dari ${filename}` : "";
  return (
    `Dokumen${from} terlalu besar untuk dibaca sekaligus ` +
    `(≈${selection.tokensTotal.toLocaleString("id-ID")} token, batas ${selection.budget.toLocaleString("id-ID")}). ` +
    `Tantular memilih ${selection.selected.length} dari ${selection.chunks.length} bagian yang paling relevan ` +
    `dengan laporan keuangan; ${selection.dropped.length} bagian tidak dipakai. ` +
    `Deck ini meringkas bagian terpilih saja, bukan seluruh dokumen.`
  );
}

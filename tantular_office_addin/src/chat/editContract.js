// Edit contract lives ONLY here — future Tinker SFT target.
export const EDIT_SYSTEM_PROMPT = [
  "Anda editor dokumen Bahasa Indonesia yang teliti.",
  "Balas HANYA JSON valid dengan bentuk:",
  '{"edits":[{"find":"<teks persis dari dokumen>","replace":"<teks baru>","before":"<±40 karakter sebelum find>","after":"<±40 karakter sesudah find>","occurrence":1,"alasan":"<alasan singkat>"}]}',
  "Aturan: find harus persis sama dengan teks di dokumen (maksimal 2000 karakter);",
  "gunakan before/after untuk membedakan teks yang berulang; maksimal 20 edit;",
  "Untuk permintaan elaborasi/perluasan bagian: pilih satu kalimat pendek yang persis ada sebagai find, lalu replace dengan 2-4 paragraf siap pakai (gunakan baris kosong antarparagraf) yang mempertahankan ide asli dan menambahkan definisi, trade-off, implikasi, serta kriteria pemilihan yang konsisten dengan konteks;",
  "Jangan hanya menambah satu klausa. Elaborasi harus substantif tetapi tetap ringkas, sekitar 120-250 kata bila pengguna meminta greater detail;",
  "Untuk topik closed model vs open-weight: jelaskan bahwa open-weight berarti bobot model tersedia menurut lisensinya, bukan otomatis open-source penuh atau transparan sepenuhnya; bandingkan deployment, kustomisasi, kendali data, vendor lock-in, kebutuhan talenta, dan tanggung jawab operasional tanpa mengarang angka;",
  "Jangan memilih heading saja sebagai find jika yang perlu diperluas adalah isi paragraf di bawahnya;",
  "jangan ubah makna, nama, angka kecuali diminta; tanpa teks lain di luar JSON."
].join(" ");

// "Perbaiki bahasa" is a proofread, not an edit-for-content. It used to share
// EDIT_SYSTEM_PROMPT, whose elaboration rules ("replace dengan 2-4 paragraf",
// "elaborasi harus substantif") leaked into plain language fixes: probed on
// 2026-10-31 against tantular-office:0.5-9b, a 12-sentence selection came
// back as rewrites that added claims ("enkripsi end-to-end") and even flipped
// meaning ("tetap memakai versi lama" → "beralih bertahap"), and the verbose
// before/after/alasan fields ran the reply into max_tokens mid-JSON.
export const LANGUAGE_FIX_SYSTEM_PROMPT = [
  "Anda korektor bahasa Indonesia. Tugas Anda HANYA memperbaiki ejaan, tanda baca, huruf kapital, dan tata bahasa yang jelas salah.",
  "Balas HANYA JSON valid dengan bentuk:",
  '{"edits":[{"find":"<potongan teks persis dari dokumen>","replace":"<potongan yang sudah dibetulkan>","alasan":"<maks 5 kata>"}]}',
  "Aturan: find sependek mungkin — cukup frasa yang salah ditambah satu-dua kata di sekitarnya agar unik, jangan seluruh kalimat atau paragraf;",
  "find tidak boleh melewati batas paragraf;",
  "replace harus sama dengan find kecuali bagian yang salah; jangan menambah informasi, contoh, istilah teknis, atau kalimat baru; jangan mengganti kata yang sudah benar dengan sinonim; jangan mengubah makna, nama, angka, kode, atau teks di dalam tanda `backtick`;",
  "isi before/after HANYA jika find muncul lebih dari sekali di teks; maksimal 20 edit;",
  "jika tidak ada kesalahan, balas {\"edits\":[]}; tanpa teks lain di luar JSON."
].join(" ");

// Instructions that ask only for a language/proofreading pass. Anything that
// also asks for expansion or a new tone stays on the general edit prompt.
const LANGUAGE_FIX_RE = /\b(perbaiki|betulkan|koreksi|rapikan)\s+(bahasa|ejaan|tata\s*bahasa|typo|salah\s*ketik)|\b(proofread|fix\s+(the\s+)?(grammar|spelling|typos?))\b/i;
const CONTENT_CHANGE_RE = /\b(elaborasi|perluas|kembangkan|tambahkan|perjelas|ubah\s+nada|persingkat|ringkas|lebih\s+(formal|santai|singkat|panjang)|expand|elaborate|rewrite)\b/i;

export function isLanguageFixRequest(instruction) {
  const text = String(instruction ?? "");
  return LANGUAGE_FIX_RE.test(text) && !CONTENT_CHANGE_RE.test(text);
}

// A language fix keeps the span essentially the same length. Anything that
// grows or shrinks it by more than max(20 chars, 30%) is a content rewrite
// and must not be offered under "Perbaiki bahasa".
export function isSubstantiveRewrite(find, replace) {
  const a = String(find ?? "");
  const b = String(replace ?? "");
  return Math.abs(b.length - a.length) > Math.max(20, a.length * 0.3);
}

const MAX_EDITS = 20;
// Raised from 200 to 2000 at the user's explicit request, after being told
// the tradeoff: the exact-match requirement below is unchanged, so a longer
// "find" is not less safe in the sense of matching the WRONG text — it just
// gets harder for the model to reproduce byte-for-byte over a longer span,
// which fails safe as locateEdit's "not_found" (surfaced, never a silent
// wrong replacement), not a corrupted document. 2000 chars fits whole
// long-sentence/paragraph edits in one shot for prose like academic writing.
const MAX_FIND = 2000;

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Returns the first balanced top-level {...} in text, skipping braces inside
// JSON strings, or { truncated: true } when an object opens but never closes.
// The old "first { to last }" slice turned a reply cut off at max_tokens into
// a parse of half an object (its last "}" belonged to an inner edit), which
// surfaced as the generic "tidak bisa dibaca" instead of "terpotong".
export function extractJsonObject(raw) {
  const text = String(raw ?? "").replace(/```(?:json|JSON)?/g, "");
  const start = text.indexOf("{");
  if (start === -1) return { json: null, truncated: false };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { json: text.slice(start, i + 1), truncated: false };
  }
  return { json: null, truncated: true };
}

export const EDIT_TRUNCATED_MESSAGE =
  "Balasan model terpotong sebelum JSON edit selesai (batas panjang jawaban habis). Pilih bagian teks yang lebih pendek lalu coba lagi.";

// finishReason (when the server reports it) is authoritative for truncation:
// "length" means the model hit max_tokens, whatever the text looks like.
export function parseEditContract(raw, { finishReason = null } = {}) {
  const { json, truncated } = extractJsonObject(raw);
  if (finishReason === "length" || truncated) throw contractError("EDIT_JSON_TRUNCATED", EDIT_TRUNCATED_MESSAGE);
  if (!json) throw contractError("EDIT_JSON_MISSING", "Model tidak mengembalikan JSON edit, hanya teks biasa. Coba ulangi permintaannya.");
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw contractError("EDIT_JSON_INVALID", `JSON edit dari model tidak bisa dibaca (${error?.message ?? "format salah"}).`);
  }
  const edits = parsed?.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw contractError("EDIT_EMPTY", "Tidak ada edit yang diusulkan.");
  if (edits.length > MAX_EDITS) throw new Error(`Terlalu banyak edit (${edits.length}); maksimal ${MAX_EDITS}.`);

  // One malformed item must not discard an otherwise-good batch. A weaker
  // local model asked for many edits at once (a large selection) is more
  // likely to slip on ONE item — e.g. leaving out "find" — while the rest of
  // the JSON is fine. Throwing away all of them on that single miss is what
  // previously turned "9 good edits, 1 bad" into "0 edits, try again", which
  // for a slow local model can mean burning another 90-second timeout instead
  // of just proceeding with what parsed correctly.
  const good = [];
  const skipped = [];
  edits.forEach((e, i) => {
    const find = String(e?.find ?? "");
    const replace = String(e?.replace ?? "");
    if (!find) return skipped.push({ index: i + 1, reason: `tidak punya "find"` });
    if (find.length > MAX_FIND) {
      return skipped.push({ index: i + 1, reason: `"find" terlalu panjang (maksimal ${MAX_FIND} karakter)` });
    }
    const occurrence = Number.isInteger(e?.occurrence) && e.occurrence >= 1 ? e.occurrence : 1;
    good.push({
      find, replace, occurrence,
      before: typeof e?.before === "string" ? e.before : "",
      after: typeof e?.after === "string" ? e.after : "",
      alasan: typeof e?.alasan === "string" ? e.alasan : ""
    });
  });
  // All-bad is still a real failure — there is nothing useful to show, and
  // the earlier per-item error text explained why better than a generic one.
  if (good.length === 0) {
    throw new Error(`Semua ${edits.length} edit tidak valid: ${skipped.map((s) => `#${s.index} ${s.reason}`).join("; ")}.`);
  }
  return { edits: good, skipped };
}

function allIndexesOf(haystack, needle) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

function normalizeWs(s) { return s.replace(/\s+/g, " "); }

function contextMatches(docText, index, length, edit) {
  const windowBefore = docText.slice(Math.max(0, index - 60), index);
  const windowAfter = docText.slice(index + length, index + length + 60);
  // Check if before context appears at the END of the window before the match
  const beforeOk = !edit.before || normalizeWs(windowBefore).endsWith(normalizeWs(edit.before));
  // Check if after context appears at the START of the window after the match
  const afterOk = !edit.after || normalizeWs(windowAfter).startsWith(normalizeWs(edit.after));
  return beforeOk && afterOk;
}

export function locateEdit(docText, edit) {
  if (!edit?.find) return { error: "not_found" };
  const doc = String(docText ?? "");
  let candidates = allIndexesOf(doc, edit.find).map((index) => ({ index, length: edit.find.length }));

  if (candidates.length === 0) {
    // One whitespace-normalized retry: match ignoring run-length of spaces.
    const pattern = edit.find.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    try {
      const re = new RegExp(pattern, "g");
      let m;
      while ((m = re.exec(doc)) !== null) candidates.push({ index: m.index, length: m[0].length });
    } catch { /* pattern too weird → stays not_found */ }
  }
  if (candidates.length === 0) return { error: "not_found" };
  // A unique raw match is unambiguous by definition, regardless of anchors.
  if (candidates.length === 1) return candidates[0];

  const filtered = candidates.filter((c) => contextMatches(doc, c.index, c.length, edit));
  const hasAnchors = Boolean(edit.before || edit.after);
  // Anchors were provided but matched nothing: never fall back to raw pool
  // positional counting — anchors resolve to exactly one location, never guessed.
  if (hasAnchors && filtered.length === 0) return { error: "ambiguous" };
  const pool = filtered.length > 0 ? filtered : candidates;
  if (pool.length === 1) return pool[0];
  const occurrence = edit.occurrence ?? 1;
  // occurrence only trusted when before/after narrowed nothing AND the
  // model addressed the repetition explicitly (occurrence > 1), or when
  // context filtering produced a unique-ish pool.
  if (filtered.length > 1 && occurrence > 1 && occurrence <= filtered.length) return filtered[occurrence - 1];
  return { error: "ambiguous" };
}

// Maps a character index to its ordinal among NON-overlapping occurrences of
// `find` (the same enumeration Word's body.search uses). Returns -1 when
// `find` does not occur non-overlappingly at exactly that index.
export function searchOrdinalAt(docText, find, index) {
  if (!find) return -1;
  let i = String(docText ?? "").indexOf(find);
  let ordinal = 0;
  while (i !== -1) {
    if (i === index) return ordinal;
    if (i > index) return -1;
    ordinal++;
    i = docText.indexOf(find, i + find.length); // non-overlapping stepping
  }
  return -1;
}

// Word's body.search rejects search strings over 255 characters and cannot
// match across a paragraph mark (body.text renders those as \r; \n, \v and
// the Unicode separators are treated the same). Anchors stay well under the
// limit so "^" escaping (^ → ^^) never pushes one over it.
export const WORD_SEARCH_MAX = 255;
const ANCHOR_MAX = 200;
const PARAGRAPH_MARK = /[\r\n\v\f\u2028\u2029]/;

export function escapeWordSearch(text) {
  return String(text).replace(/\^/g, "^^");
}

function collapseWs(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

// The ONE anchoring plan shared by the preview and the apply step, so an edit
// the preview offers is exactly an edit the apply step can reach. Given the
// span locateEdit found, it returns how to reach that span with Word search:
//  - start: the first ≤200 chars of the span's first paragraph, plus the
//    ordinal of that occurrence among Word's non-overlapping search hits;
//  - end (only when the span crosses a paragraph or is longer than one
//    anchor): the last ≤200 chars of its last paragraph, likewise;
//  - expected: the span text, which apply compares against the Word range
//    after start.expandTo(end) before writing anything.
// Leading/trailing whitespace (including a trailing paragraph mark the model
// copied into "find") is left outside the anchored range, and the same
// whitespace is dropped from the replacement so it is not doubled.
export function planWordAnchor(docText, index, length, replace = "") {
  const doc = String(docText ?? "");
  const span = doc.slice(index, index + length);
  const lead = span.match(/^\s*/)[0].length;
  const trail = span.length - span.trimEnd().length;
  const core = span.slice(lead, span.length - trail);
  if (!core) return { error: "unanchorable" };
  const coreStart = index + lead;
  const coreEnd = coreStart + core.length;

  let replacement = String(replace ?? "");
  if (lead) replacement = replacement.replace(/^\s+/, "");
  if (trail) replacement = replacement.replace(/\s+$/, "");

  const firstBreak = core.search(PARAGRAPH_MARK);
  const crossesParagraph = firstBreak !== -1;
  const firstPara = crossesParagraph ? core.slice(0, firstBreak) : core;
  let lastParaStart = 0;
  for (let i = core.length - 1; i >= 0; i--) {
    if (PARAGRAPH_MARK.test(core[i])) { lastParaStart = i + 1; break; }
  }
  const lastPara = core.slice(lastParaStart);

  if (!crossesParagraph && core.length <= ANCHOR_MAX) {
    const ordinal = searchOrdinalAt(doc, core, coreStart);
    if (ordinal === -1) return { error: "unanchorable" };
    return { start: { text: core, ordinal }, end: null, expected: core, replace: replacement };
  }
  const startText = firstPara.slice(0, ANCHOR_MAX);
  const endText = lastPara.slice(-ANCHOR_MAX);
  if (!startText.trim() || !endText.trim()) return { error: "unanchorable" };
  const startOrdinal = searchOrdinalAt(doc, startText, coreStart);
  const endOrdinal = searchOrdinalAt(doc, endText, coreEnd - endText.length);
  if (startOrdinal === -1 || endOrdinal === -1) return { error: "unanchorable" };
  return {
    start: { text: startText, ordinal: startOrdinal },
    end: { text: endText, ordinal: endOrdinal },
    expected: core,
    replace: replacement
  };
}

// Apply-time check on the range Word actually produced: the text must equal
// the planned span up to whitespace (Word reports paragraph marks as \r).
export function rangeMatchesPlan(rangeText, plan) {
  return collapseWs(rangeText) === collapseWs(plan?.expected);
}

// Locate + plan, exactly as the apply step will. `languageFix` additionally
// refuses edits that rewrite content instead of fixing language.
export function resolveEditAnchor(docText, edit, { languageFix = false } = {}) {
  const r = locateEdit(docText, edit);
  if (r.error) return { error: r.error };
  if (languageFix && isSubstantiveRewrite(docText.slice(r.index, r.index + r.length), edit.replace)) {
    return { error: "substantive" };
  }
  const plan = planWordAnchor(docText, r.index, r.length, edit.replace);
  if (plan.error) return { error: plan.error };
  return { index: r.index, length: r.length, plan };
}

export function resolveEdits(docText, edits, options = {}) {
  return edits.map((edit) => {
    const r = resolveEditAnchor(String(docText ?? ""), edit, options);
    return r.error ? { edit, error: r.error } : { edit, index: r.index, length: r.length, plan: r.plan };
  });
}

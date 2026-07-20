// Edit contract lives ONLY here — future Tinker SFT target.
export const EDIT_SYSTEM_PROMPT = [
  "Anda editor dokumen Bahasa Indonesia yang teliti.",
  "Balas HANYA JSON valid dengan bentuk:",
  '{"edits":[{"find":"<teks persis dari dokumen>","replace":"<teks baru>","before":"<±40 karakter sebelum find>","after":"<±40 karakter sesudah find>","occurrence":1,"alasan":"<alasan singkat>"}]}',
  "Aturan: find harus persis sama dengan teks di dokumen (maksimal 200 karakter);",
  "gunakan before/after untuk membedakan teks yang berulang; maksimal 20 edit;",
  "jangan ubah makna, nama, angka kecuali diminta; tanpa teks lain di luar JSON."
].join(" ");

const MAX_EDITS = 20;
const MAX_FIND = 200;

export function parseEditContract(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model tidak mengembalikan JSON edit yang valid.");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("JSON edit dari model tidak bisa dibaca.");
  }
  const edits = parsed?.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("Tidak ada edit yang diusulkan.");
  if (edits.length > MAX_EDITS) throw new Error(`Terlalu banyak edit (${edits.length}); maksimal ${MAX_EDITS}.`);
  return {
    edits: edits.map((e, i) => {
      const find = String(e?.find ?? "");
      const replace = String(e?.replace ?? "");
      if (!find) throw new Error(`Edit #${i + 1} tidak punya "find".`);
      if (find.length > MAX_FIND) throw new Error(`Edit #${i + 1}: "find" terlalu panjang (maksimal ${MAX_FIND} karakter).`);
      const occurrence = Number.isInteger(e?.occurrence) && e.occurrence >= 1 ? e.occurrence : 1;
      return {
        find, replace, occurrence,
        before: typeof e?.before === "string" ? e.before : "",
        after: typeof e?.after === "string" ? e.after : "",
        alasan: typeof e?.alasan === "string" ? e.alasan : ""
      };
    })
  };
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
  if (filtered.length === 0 && occurrence > 1 && occurrence <= pool.length) return pool[occurrence - 1];
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

export function resolveEdits(docText, edits) {
  return edits.map((edit) => {
    const r = locateEdit(docText, edit);
    return r.error ? { edit, error: r.error } : { edit, index: r.index, length: r.length };
  });
}

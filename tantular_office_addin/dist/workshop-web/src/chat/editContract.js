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

const MAX_EDITS = 20;
// Raised from 200 to 2000 at the user's explicit request, after being told
// the tradeoff: the exact-match requirement below is unchanged, so a longer
// "find" is not less safe in the sense of matching the WRONG text — it just
// gets harder for the model to reproduce byte-for-byte over a longer span,
// which fails safe as locateEdit's "not_found" (surfaced, never a silent
// wrong replacement), not a corrupted document. 2000 chars fits whole
// long-sentence/paragraph edits in one shot for prose like academic writing.
const MAX_FIND = 2000;

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

export function resolveEdits(docText, edits) {
  return edits.map((edit) => {
    const r = locateEdit(docText, edit);
    return r.error ? { edit, error: r.error } : { edit, index: r.index, length: r.length };
  });
}

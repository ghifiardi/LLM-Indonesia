// Formatting requests handled by code, not the model (2026-09-05): the model
// only sees text and used to apologise ("saya hanya memiliki akses ke teks").
// "perbesar font", "ukuran 20", "sesuaikan proporsional" become deterministic
// writes on the slide's own body text boxes. Pure.

const str = (v) => String(v ?? "");
const FOOTER_TEXT_RE = /·\s*\d+\s*\/\s*\d+\s*$/;
const FONT_WORD = /\b(?:font|huruf|teks|tulisan|ukuran)/i;

export function parseFormatRequest(message) {
  const text = str(message).toLowerCase();
  if (!text.trim()) return null;
  if (/\b(?:proporsional|sesuaikan|menyesuaikan|pas dengan slide|memenuhi slide|isi slide penuh|fit)\b/.test(text) && FONT_WORD.test(text)) return { kind: "fit" };
  if (/\bproporsional\b/.test(text)) return { kind: "fit" };
  const exact = text.match(/\b(?:ukuran(?:\s+font| huruf)?|font(?:\s+size)?|size)\s*(?:ke|menjadi|=|:)?\s*(\d{1,2})\s*(?:pt|px|poin)?\b/);
  if (exact && FONT_WORD.test(text)) return { kind: "font", size: Number(exact[1]) };
  if (/\b(?:perbesar|besarkan|lebih besar|diperbesar|membesarkan|enlarge|bigger|larger)\b/.test(text) && FONT_WORD.test(text)) return { kind: "font", delta: 2 };
  if (/\b(?:perkecil|kecilkan|lebih kecil|diperkecil|mengecilkan|smaller|shrink)\b/.test(text) && FONT_WORD.test(text)) return { kind: "font", delta: -2 };
  return null;
}

// Body text boxes: text shapes that are neither the topmost (title) nor the
// footer. Markers and pictures have no text and are skipped.
export function planFormatWrites(shapes, request) {
  const list = Array.isArray(shapes) ? shapes : [];
  const textual = list.map((s, i) => ({ s, i })).filter(({ s }) => str(s.text).trim());
  if (!textual.length || !request) return [];
  const sorted = textual.slice().sort((a, b) => Number(a.s.top) - Number(b.s.top));
  const title = sorted[0];
  const bodies = sorted.slice(1).filter(({ s }) => !FOOTER_TEXT_RE.test(str(s.text)) && !/·/.test(str(s.text)));
  if (request.kind !== "font") return [];
  return bodies.map(({ s, i }) => {
    const current = Number(s.fontSize) || 14;
    const next = request.size !== undefined ? Number(request.size) : current + (Number(request.delta) || 0);
    return { index: i, fontSize: Math.max(8, Math.min(60, Math.round(next))) };
  }).filter((w) => w.fontSize !== (Number(list[w.index].fontSize) || 14) || request.size !== undefined)
    .filter((w) => title.i !== w.index);
}

export function describeFormat(request, before, after) {
  if (request?.kind === "fit") return "ukuran huruf disesuaikan agar proporsional dengan slide";
  return `ukuran huruf isi ${before} → ${after}`;
}

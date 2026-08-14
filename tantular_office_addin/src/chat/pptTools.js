// Tantular PowerPoint chat tools — deck reading, action validation, execution.
// All Office/PowerPoint access for the PPT chat lives here so pptChat.js can
// stay a pure UI module (mirrors the excelChat.js / excelTools.js split).

import { sameSlideId, getActivePresentationPptxFile } from "../officeClient.js";
import { extractDocumentFile } from "../deck/documentExtract.js";

const MAX_ACTIONS_PER_TURN = 8;
const OPS = ["improve_slide", "replace_slide", "add_slide", "delete_slide"];
const FRONT_INSERT_REJECTION =
  "Menyisipkan slide di posisi paling depan belum didukung. " +
  "Sisipkan setelah slide 1, lalu geser di panel thumbnail.";

function isIndex(value) {
  return Number.isInteger(value);
}

function str(value) {
  return String(value ?? "").trim();
}

export function extractRequestedSlideIndex(text) {
  const value = String(text || "");
  const match = value.match(/\b(?:slide|page|halaman|hlm|deck\s*page)\s*#?\s*(\d{1,3})\b/i)
    || value.match(/#\s*(\d{1,3})\b/);
  if (!match) return 0;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : 0;
}

export function extractPptxSlides(text) {
  const value = String(text || "");
  const re = /^\[Slide\s+(\d+)(?:\s+\|\s+id\s+([^\]]+))?\]\s*\n([\s\S]*?)(?=^\[Slide\s+\d+(?:\s+\|\s+id\s+[^\]]+)?\]\s*\n|(?![\s\S]))/gm;
  const slides = [];
  let match;
  while ((match = re.exec(value))) {
    slides.push({
      label: `Slide ${match[1]}${match[2] ? ` | id ${match[2]}` : ""}`,
      index: match[1],
      id: match[2] || "",
      text: match[3].trim()
    });
  }
  return slides;
}

export function sanitizePptActions(raw, slideCount) {
  if (!Array.isArray(raw)) return { actions: [], rejected: [] };
  const total = Number(slideCount) || 0;
  const actions = [];
  const rejected = [];

  for (const item of raw) {
    if (actions.length >= MAX_ACTIONS_PER_TURN) {
      rejected.push(`Melebihi maksimum 8 aksi per giliran; sisanya diabaikan.`);
      break;
    }
    const op = str(item?.op);
    if (!OPS.includes(op)) {
      rejected.push(`Aksi "${op || "(kosong)"}" tidak dikenal dan diabaikan.`);
      continue;
    }

    if (op === "add_slide") {
      const afterIndex = item?.afterIndex;
      if (afterIndex === 0) { rejected.push(FRONT_INSERT_REJECTION); continue; }
      if (!isIndex(afterIndex) || afterIndex < 1 || afterIndex > total) {
        rejected.push(`add_slide dengan afterIndex "${afterIndex}" di luar jangkauan 1-${total}.`);
        continue;
      }
      const slide = sanitizeSlide(item?.slide);
      if (!slide.ok) { rejected.push(`add_slide ditolak: ${slide.reason}`); continue; }
      actions.push({ op, afterIndex, slide: slide.slide });
      continue;
    }

    const slideIndex = item?.slideIndex;
    if (!isIndex(slideIndex) || slideIndex < 1 || slideIndex > total) {
      rejected.push(`${op} dengan slideIndex "${slideIndex}" di luar jangkauan 1-${total}.`);
      continue;
    }
    if (op === "replace_slide") {
      const slide = sanitizeSlide(item?.slide);
      if (!slide.ok) { rejected.push(`replace_slide ditolak: ${slide.reason}`); continue; }
      actions.push({ op, slideIndex, slide: slide.slide });
      continue;
    }
    actions.push({ op, slideIndex });
  }

  return { actions, rejected };
}

// Field allowlist = exactly what pptxBuilder consumes. Anything else is
// stripped so a hallucinated field can never reach the renderer.
export const TYPE_RULES = {
  title:         { requires: null },
  closing:       { requires: null },
  quote:         { requires: null },
  agenda:        { requires: "bullets" },
  bullets:       { requires: "bullets" },
  cards:         { requires: "cards" },
  columns:       { requires: "columns" },
  metrics:       { requires: "metrics" },
  visualization: { requires: "data" }
};

function cleanStrings(raw) {
  return Array.isArray(raw) ? raw.map(str).filter(Boolean) : [];
}

function cleanCards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((card) => {
    const title = str(card?.title);
    if (!title) return null;
    const desc = str(card?.desc);
    return desc ? { title, desc } : { title };
  }).filter(Boolean);
}

function cleanColumns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((column) => {
    const title = str(column?.title);
    if (!title) return null;
    const points = cleanStrings(column?.points);
    return points.length ? { title, points } : { title };
  }).filter(Boolean);
}

function cleanMetrics(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((metric) => {
    const value = str(metric?.value);
    if (!value) return null;
    return { value, label: str(metric?.label) };
  }).filter(Boolean);
}

function cleanData(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((point) => {
    const label = str(point?.label);
    const value = Number(point?.value);
    if (!label || !Number.isFinite(value)) return null;
    return { label, value };
  }).filter(Boolean);
}

function sanitizeSlide(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "objek slide tidak ada." };
  const type = str(raw.type);
  if (!TYPE_RULES[type]) return { ok: false, reason: `type slide "${type}" tidak dikenal.` };

  const headline = str(raw.headline);
  const quote = str(raw.quote);
  if (type === "quote") {
    if (!headline && !quote) return { ok: false, reason: "slide quote butuh \"quote\" atau \"headline\"." };
  } else if (!headline) {
    return { ok: false, reason: `slide ${type} butuh "headline".` };
  }

  const slide = { type };
  if (headline) slide.headline = headline;
  if (quote) slide.quote = quote;
  if (str(raw.subhead)) slide.subhead = str(raw.subhead);

  // Drop invalid nested entries FIRST, then check emptiness — an array that
  // only contained malformed entries must reject the slide, not render blank.
  const bullets = cleanStrings(raw.bullets);
  const cards = cleanCards(raw.cards);
  const columns = cleanColumns(raw.columns);
  const metrics = cleanMetrics(raw.metrics);
  const data = cleanData(raw.data);
  if (bullets.length) slide.bullets = bullets;
  if (cards.length) slide.cards = cards;
  if (columns.length) slide.columns = columns;
  if (metrics.length) slide.metrics = metrics;
  if (data.length) slide.data = data;
  if (type === "visualization" && str(raw.chartType)) {
    slide.chartType = str(raw.chartType).toLowerCase();
  }

  const required = TYPE_RULES[type].requires;
  if (required && !(slide[required] || []).length) {
    return { ok: false, reason: `slide ${type} butuh "${required}" yang tidak kosong.` };
  }
  return { ok: true, slide };
}

// Execution order is load-bearing, for two reasons:
//  1. Mutating slide N shifts the position of everything after it, so the
//     highest index goes first.
//  2. replaceSlideInActivePresentation inserts after the original and THEN
//     deletes it (officeClient.js:603/645). An add_slide anchored on a slide
//     being replaced must therefore run BEFORE the replace, while its anchor
//     id still exists.
const OP_RANK = { add_slide: 0, replace_slide: 1, improve_slide: 1, delete_slide: 2 };

export const PER_SLIDE_CHARS = 400;
export const TOTAL_SNAPSHOT_CHARS = 9000;

// A confirmed delete must hit the slide the user saw in the proposal. If the
// deck moved between proposal and confirmation, warn instead of deleting
// whatever now sits at that position.
export function resolveDeleteTarget(liveIds, descriptor) {
  const ids = Array.isArray(liveIds) ? liveIds.map((id) => String(id || "")) : [];
  const wanted = str(descriptor?.id);
  const index = Number(descriptor?.slideIndex) || 0;

  if (wanted) {
    let position = ids.findIndex((id) => id === wanted);
    if (position < 0) {
      const matches = ids
        .map((id, i) => (sameSlideId(id, wanted) ? i : -1))
        .filter((i) => i >= 0);
      if (matches.length === 1) position = matches[0];
    }
    if (position < 0) {
      const title = str(descriptor?.title);
      return {
        ok: false,
        reason: `Deck sudah berubah sejak penghapusan diusulkan${title ? ` (slide "${title}")` : ""}. ` +
          "Tidak ada yang dihapus. Minta ulang jika masih ingin menghapusnya."
      };
    }
    return { ok: true, id: ids[position], index: position + 1 };
  }

  if (!Number.isInteger(index) || index < 1 || index > ids.length) {
    return { ok: false, reason: `Slide ${index || "?"} tidak ada lagi di deck aktif. Tidak ada yang dihapus.` };
  }
  return { ok: true, id: ids[index - 1], index };
}

export function deckContextToPromptText(ctx) {
  const slides = Array.isArray(ctx?.slides) ? ctx.slides : [];
  const lines = [
    `Deck aktif: ${slides.length} slide. Sumber pembacaan: ${str(ctx?.source) || "tidak diketahui"}.`,
    "Konten slide dipotong untuk konteks; jangan anggap bagian yang tidak terlihat kosong.",
    ""
  ];
  let budget = TOTAL_SNAPSHOT_CHARS;
  for (const slide of slides) {
    const header = `[Slide ${slide.index}${slide.id ? ` | id ${slide.id}` : ""}]`;
    const room = Math.max(0, Math.min(PER_SLIDE_CHARS, budget));
    const body = str(slide.text);
    const cut = body.length > room;
    const shown = cut ? `${body.slice(0, room)} [dipotong]` : body;
    lines.push(`${header} ${shown}`.trim());
    budget -= Math.min(body.length, room);
    if (budget <= 0) {
      lines.push(`[… ${slides.length - slide.index} slide berikutnya tidak ditampilkan karena batas konteks]`);
      break;
    }
  }
  return lines.join("\n");
}

export function orderPptActions(actions) {
  const list = Array.isArray(actions) ? actions.slice() : [];
  return list
    .map((action, position) => ({ action, position }))
    .sort((a, b) => {
      const aIndex = a.action.op === "add_slide" ? a.action.afterIndex : a.action.slideIndex;
      const bIndex = b.action.op === "add_slide" ? b.action.afterIndex : b.action.slideIndex;
      if (aIndex !== bIndex) return bIndex - aIndex;
      const rank = OP_RANK[a.action.op] - OP_RANK[b.action.op];
      if (rank !== 0) return rank;
      // Same anchor, same op: reverse model order. Every insert lands
      // immediately after the anchor, so the last one executed ends up first.
      if (a.action.op === "add_slide") return b.position - a.position;
      return a.position - b.position;
    })
    .map((entry) => entry.action);
}

let deckCache = null;

export function invalidateDeckContext() {
  deckCache = null;
}

function titleOf(text) {
  const first = str(text).split("\n").map(str).find(Boolean);
  return first || "(tanpa teks)";
}

export function buildDeckSlidesFromExtractor(text) {
  return extractPptxSlides(text).map((slide, position) => ({
    index: Number(slide.index) || position + 1,
    id: str(slide.id),
    title: titleOf(slide.text),
    text: str(slide.text),
    truncated: false
  }));
}

// Fast path: read the deck through the PowerPoint API. Requires Shape.textFrame
// (PowerPointApi 1.4), which is NOT confirmed on the Mac workshop host — this
// returns null rather than throwing so the caller falls back cleanly.
async function readDeckViaHost() {
  if (!globalThis.PowerPoint?.run) return null;
  try {
    return await PowerPoint.run(async (context) => {
      const collection = context.presentation.slides;
      collection.load("items");
      await context.sync();
      const items = collection.items || [];
      if (!items.length) return null;

      for (const slide of items) {
        slide.load("id");
        try { slide.shapes.load("items"); } catch (_) { /* older hosts */ }
      }
      await context.sync();

      const perSlide = items.map((slide) => {
        const ranges = [];
        for (const shape of slide.shapes?.items || []) {
          try {
            const range = shape.textFrame.textRange;
            range.load("text");
            ranges.push(range);
          } catch (_) { /* non-text shapes are expected */ }
        }
        return ranges;
      });
      await context.sync();

      const slides = items.map((slide, position) => {
        const text = perSlide[position]
          .map((range) => str(range.text))
          .filter(Boolean)
          .join("\n");
        return {
          index: position + 1,
          id: String(slide.id || ""),
          title: titleOf(text),
          text,
          truncated: false
        };
      });
      // A deck where every slide reads empty means textFrame silently gave us
      // nothing. Treat it as a failed read, not an empty deck.
      return slides.some((slide) => slide.text) ? slides : null;
    });
  } catch (error) {
    console.warn("[TantularChat/PPT] in-host deck read failed", error);
    return null;
  }
}

async function readDeckViaExtractor() {
  const file = await getActivePresentationPptxFile();
  const extracted = await extractDocumentFile(file);
  return buildDeckSlidesFromExtractor(extracted?.text || "");
}

export async function getDeckContext({ force = false } = {}) {
  if (deckCache && force !== true) return deckCache;

  let slides = await readDeckViaHost();
  let source = "host";
  if (!slides?.length) {
    try {
      slides = await readDeckViaExtractor();
      source = "extractor";
    } catch (error) {
      console.warn("[TantularChat/PPT] extractor deck read failed", error);
      slides = [];
    }
  }
  if (!slides?.length) {
    throw new Error(
      "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan, " +
      "lalu klik Muat ulang deck."
    );
  }

  deckCache = {
    slides,
    source,
    meta: `${slides.length} slide terbaca (${source}).`
  };
  return deckCache;
}

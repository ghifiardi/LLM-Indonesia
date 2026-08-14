// Tantular PowerPoint chat tools — deck reading, action validation, execution.
// All Office/PowerPoint access for the PPT chat lives here so pptChat.js can
// stay a pure UI module (mirrors the excelChat.js / excelTools.js split).

import {
  sameSlideId,
  getActivePresentationPptxFile,
  deleteSlidesInActivePresentation,
  insertSlideAfterInActivePresentation,
  readLiveSlideIds,
  replaceSlideInActivePresentation
} from "../officeClient.js";
import { extractDocumentFile } from "../deck/documentExtract.js";
import { buildDeckPptxBase64 } from "../deck/pptxBuilder.js";
import { improveExistingSlide } from "../deck/deckPlanner.js";

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

// The snapshot's index space is NOT 1..slides.length. `slide.index` is a TRUE
// DECK POSITION: the extractor skips slides it cannot read text from (image-only
// slides) while its counter keeps advancing, so a 60-slide deck can produce 30
// entries whose indexes run to 60. Bounding on the array length would reject the
// very indexes the prompt just printed. Accepts a snapshot (or slide array) for
// the real space, and still accepts a plain count for callers that only have one.
export function snapshotIndexSpace(bounds) {
  const list = Array.isArray(bounds)
    ? bounds
    : (bounds && typeof bounds === "object" && Array.isArray(bounds.slides) ? bounds.slides : null);
  if (list) {
    const set = new Set(
      list
        .map((entry) => Number(entry?.index ?? entry))
        .filter((value) => Number.isInteger(value) && value > 0)
    );
    return { known: true, has: (n) => set.has(n), max: set.size ? Math.max(...set) : 0 };
  }
  const total = Number.isFinite(Number(bounds)) ? Math.floor(Number(bounds)) : 0;
  const max = total > 0 ? total : 0;
  return { known: false, has: (n) => n >= 1 && n <= max, max };
}

function rangeRejection(space, op, field, value) {
  if (space.known && isIndex(value) && value >= 1 && value <= space.max && !space.has(value)) {
    return `${op} dengan ${field} ${value}: slide itu tidak ada di snapshot deck ` +
      "(slide tanpa teks yang bisa dibaca tidak ikut terbaca).";
  }
  return `${op} dengan ${field} "${value}" di luar jangkauan 1-${space.max}.`;
}

export function sanitizePptActions(raw, bounds) {
  if (!Array.isArray(raw)) return { actions: [], rejected: [] };
  const space = snapshotIndexSpace(bounds);
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
      if (!isIndex(afterIndex) || !space.has(afterIndex)) {
        rejected.push(rangeRejection(space, "add_slide", "afterIndex", afterIndex));
        continue;
      }
      const slide = sanitizeSlide(item?.slide);
      if (!slide.ok) { rejected.push(`add_slide ditolak: ${slide.reason}`); continue; }
      actions.push({ op, afterIndex, slide: slide.slide });
      continue;
    }

    const slideIndex = item?.slideIndex;
    if (!isIndex(slideIndex) || !space.has(slideIndex)) {
      rejected.push(rangeRejection(space, op, "slideIndex", slideIndex));
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
    // Number(null) is 0, so a hallucinated `value: null` would otherwise draw a
    // confident zero bar. "Jangan mengarang angka": drop the point instead.
    const rawValue = point?.value;
    const numeric = typeof rawValue === "number"
      || (typeof rawValue === "string" && rawValue.trim() !== "");
    if (!numeric) return null;
    const value = Number(rawValue);
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

// EVERY readable slide appears, always — dropping the tail of a large deck let
// the model plan a replace_slide on a slide whose text it never saw, destroying
// the original with no confirmation. Instead the per-slide body budget shrinks
// as the deck grows: a big deck gives every slide a short body rather than
// giving some slides a long body and others nothing at all.
export const SNAPSHOT_TITLE_CHARS = 60;
export const SNAPSHOT_CEILING_CHARS = TOTAL_SNAPSHOT_CHARS + 1500;

function clip(value, limit) {
  const text = str(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function deckContextToPromptText(ctx) {
  const slides = Array.isArray(ctx?.slides) ? ctx.slides : [];
  const lines = [
    `Deck aktif: ${slides.length} slide terbaca (slide tanpa teks yang bisa dibaca tidak muncul di daftar ini). ` +
      `Sumber pembacaan: ${str(ctx?.source) || "tidak diketahui"}.`,
    "Konten slide dipotong untuk konteks; jangan anggap bagian yang tidak terlihat kosong.",
    ""
  ];

  const headers = slides.map((slide) => {
    const title = clip(slide?.title, SNAPSHOT_TITLE_CHARS);
    return `[Slide ${slide?.index}${slide?.id ? ` | id ${slide.id}` : ""}${title ? ` | ${title}` : ""}]`;
  });
  const headerCost = headers.reduce((sum, header) => sum + header.length + 1, 0);
  const bodyBudget = Math.max(0, TOTAL_SNAPSHOT_CHARS - headerCost);
  const room = slides.length
    ? Math.max(0, Math.min(PER_SLIDE_CHARS, Math.floor(bodyBudget / slides.length)))
    : 0;

  slides.forEach((slide, position) => {
    const body = str(slide?.text);
    const shown = body.length > room ? `${body.slice(0, room)} [dipotong]` : body;
    lines.push(`${headers[position]} ${shown}`.trim());
  });
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
// (PowerPointApi 1.4).
//
// MEASURED 2026-08-14: this path does NOT work on the Mac workshop host — a probe
// there returned source "extractor", i.e. this returned null. Mac always falls
// back to the companion extractor below.
//
// It is kept anyway, for Windows attendees: the workshop ships a Windows
// installer, and Windows PowerPoint generally does support Shape.textFrame, so
// deleting this would make chat there depend entirely on the Python companion
// running. Treat it as unproven rather than working — nobody has run the probe
// on Windows yet. Re-measure before relying on it.
//
// Returns null rather than throwing, so the caller falls back cleanly.
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

const DECK_READ_GENERIC_MESSAGE =
  "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan, " +
  "lalu klik Muat ulang deck.";

// Pure decision: prefer the underlying error's own actionable message (e.g. from
// extractDocumentFile or getActivePresentationPptxFile), falling back to the
// generic message only when there is no useful message to forward.
export function deckReadErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return DECK_READ_GENERIC_MESSAGE;
}

export async function getDeckContext({ force = false } = {}) {
  if (deckCache && force !== true) return deckCache;

  let slides = await readDeckViaHost();
  let source = "host";
  let extractorError = null;
  if (!slides?.length) {
    try {
      slides = await readDeckViaExtractor();
      source = "extractor";
    } catch (error) {
      console.warn("[TantularChat/PPT] extractor deck read failed", error);
      extractorError = error;
      slides = [];
    }
  }
  if (!slides?.length) {
    throw new Error(deckReadErrorMessage(extractorError));
  }

  deckCache = {
    slides,
    source,
    meta: `${slides.length} slide terbaca (${source}).`
  };
  return deckCache;
}

export function resolveActionTarget(ctx, index) {
  const slides = Array.isArray(ctx?.slides) ? ctx.slides : [];
  const slide = slides.find((entry) => entry.index === index);
  if (!slide) return null;
  return { id: str(slide.id), index: slide.index, title: str(slide.title), text: str(slide.text) };
}

function specFor(slide, title) {
  return { title: title || str(slide.headline) || "Tantular", slides: [slide] };
}

// Stamped onto every write confirmation, same convention as DECK_STUDIO_BUILD
// in taskpane.js — a screenshot of the chat then identifies the code version.
export const PPT_CHAT_BUILD = "0.1.0-ppt-chat";

// Stop must be honest about what it left undone: say how many planned actions
// never ran, instead of a bare "dihentikan" that hides the size of the gap.
export function abortReportLine(skipped) {
  const count = Number.isInteger(skipped) && skipped > 0 ? skipped : 0;
  return count
    ? `⏹ Dihentikan oleh pengguna; ${count} aksi berikutnya tidak dijalankan.`
    : "⏹ Dihentikan oleh pengguna; tidak ada aksi lain yang tersisa.";
}

// improveExistingSlide silently degrades to a mechanical re-chunk of the source
// text when the companion is down or the model emits unparseable JSON. A bare ✅
// would sell that as a model improvement, so the report names it.
export function improveResultNote(source) {
  const value = str(source);
  if (value === "model-grounded") return "";
  if (value === "fallback") return " (versi fallback — model lokal tidak menjawab)";
  if (value === "fallback-grounded") return " (versi fallback — jawaban model tidak bisa dipakai)";
  return value ? ` (versi ${value})` : " (versi fallback)";
}

// ctx is IMMUTABLE for the whole turn: every target is resolved from the
// original snapshot before anything executes, so no action ever reads a deck
// state that a sibling action just changed.
export async function executePptActions(actions, ctx, hooks = {}) {
  const { onProgress = () => {}, signal, tone = "", instruction = "", styleId = "nusantara" } = hooks;
  const lines = [];
  const pendingDeletes = [];
  if (!actions.length) return { lines, pendingDeletes };

  const planned = orderPptActions(actions).map((action) => ({
    action,
    target: resolveActionTarget(ctx, action.op === "add_slide" ? action.afterIndex : action.slideIndex)
  }));

  let wrote = false;
  for (let position = 0; position < planned.length; position += 1) {
    const { action, target } = planned[position];
    if (signal?.aborted) {
      lines.push(abortReportLine(planned.length - position));
      break;
    }
    if (!target) {
      lines.push(`❌ ${action.op}: slide tidak ada di snapshot deck.`);
      continue;
    }

    try {
      if (action.op === "delete_slide") {
        pendingDeletes.push({
          op: "delete_slide", slideIndex: target.index, id: target.id, title: target.title
        });
        lines.push(`⏸ Hapus slide ${target.index} ("${target.title}") menunggu konfirmasi.`);
        continue;
      }

      if (action.op === "improve_slide") {
        if (!target.text) {
          lines.push(`❌ Slide ${target.index} tidak punya teks yang bisa dibaca untuk diperbaiki.`);
          continue;
        }
        onProgress(`Menyusun versi lebih baik untuk slide ${target.index}...`);
        const result = await improveExistingSlide({
          slideText: target.text, tone, instruction, signal
        });
        // improveExistingSlide catches EVERY failure — including the AbortError
        // raised by Stop — and answers with a truthy mechanical fallback spec.
        // Without this re-check the deck would be rewritten by the very click
        // the user made to prevent it. Nothing below here is reversible.
        if (signal?.aborted) {
          lines.push(`⏹ Slide ${target.index} TIDAK diubah — dihentikan sebelum ditulis ke deck.`);
          lines.push(abortReportLine(planned.length - position - 1));
          break;
        }
        if (!result?.spec) {
          lines.push(`❌ Slide ${target.index}: model tidak mengembalikan slide yang valid.`);
          continue;
        }
        onProgress(`Mengganti slide ${target.index}...`);
        const outcome = await replaceSlideInActivePresentation(
          buildDeckPptxBase64(result.spec, styleId, instruction),
          { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
        );
        if (outcome.replaced) {
          wrote = true;
          lines.push(`✅ Slide ${target.index} diperbaiki di tempat${improveResultNote(result.source)}.`);
        } else lines.push(`❌ Slide ${target.index}: ${outcome.reason || "penggantian gagal."}`);
        continue;
      }

      if (action.op === "replace_slide") {
        onProgress(`Mengganti slide ${target.index}...`);
        const outcome = await replaceSlideInActivePresentation(
          buildDeckPptxBase64(specFor(action.slide), styleId, instruction),
          { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
        );
        if (outcome.replaced) { wrote = true; lines.push(`✅ Slide ${target.index} diganti.`); }
        else lines.push(`❌ Slide ${target.index}: ${outcome.reason || "penggantian gagal."}`);
        continue;
      }

      // add_slide
      if (!target.id) {
        lines.push(`❌ Slide ${target.index} tidak punya id, jadi posisi sisipan tidak bisa dipastikan.`);
        continue;
      }
      onProgress(`Menyisipkan slide setelah slide ${target.index}...`);
      const title = str(action.slide.headline) || "tanpa judul";
      // Verified insert: reads the deck before and after inside one context and
      // refuses to claim success unless exactly one slide landed right after the
      // anchor — the same contract replace and delete already honor.
      const inserted = await insertSlideAfterInActivePresentation(
        buildDeckPptxBase64(specFor(action.slide), styleId, instruction),
        { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
      );
      if (inserted.inserted || inserted.deckChanged) wrote = true;
      if (inserted.inserted) {
        lines.push(`✅ Slide baru "${title}" disisipkan setelah slide ${target.index}.`);
      } else {
        lines.push(`❌ Slide baru "${title}": ${inserted.reason || "penyisipan tidak bisa diverifikasi."}`);
      }
    } catch (error) {
      lines.push(`❌ ${action.op} slide ${target.index}: ${error?.message || error}`);
    }
  }

  // Clear once, after the turn's writes. A pending delete is not a write.
  if (wrote) {
    invalidateDeckContext();
    lines.push(`(${PPT_CHAT_BUILD})`);
  }
  return { lines, pendingDeletes };
}

export async function executeConfirmedDelete(descriptor) {
  const liveIds = await readLiveSlideIds();
  const target = resolveDeleteTarget(liveIds, descriptor);
  if (!target.ok) return `❌ ${target.reason}`;
  const outcome = await deleteSlidesInActivePresentation([target.id]);
  if (!outcome.deleted) return `❌ Slide ${target.index}: ${outcome.reason}`;
  invalidateDeckContext();
  return `✅ Slide ${target.index} ("${str(descriptor?.title)}") dihapus. (${PPT_CHAT_BUILD})`;
}

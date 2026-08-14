// Tantular PowerPoint chat tools — deck reading, action validation, planning,
// and (only after the user confirms) execution.
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

// improve_slide stays content-free, but it may carry the user's INTENT for that
// slide ("buat lebih ringkas", "fokuskan ke biaya"). Without it every improve is
// the same generic rewrite while the reply narrates the user's request as done —
// a false claim. Intent is short by nature, so anything longer than this is
// either slide content smuggled in or a rambling model: truncate it.
export const MAX_ACTION_INSTRUCTION_CHARS = 200;

function sanitizeActionInstruction(raw) {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";
  return value.length > MAX_ACTION_INSTRUCTION_CHARS
    ? value.slice(0, MAX_ACTION_INSTRUCTION_CHARS).trim()
    : value;
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
    if (op === "improve_slide") {
      const instruction = sanitizeActionInstruction(item?.instruction);
      actions.push(instruction ? { op, slideIndex, instruction } : { op, slideIndex });
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
  // A one-column "columns" slide is never what anyone meant: pptxBuilder lays it
  // out as a single full-width panel and, when the model omitted the title, prints
  // its "Kolom 1" placeholder on the deck. Reject it with a reason the user sees,
  // rather than rendering nonsense that cannot be undone.
  if (type === "columns" && columns.length === 1) {
    return { ok: false, reason: "slide columns butuh minimal 2 kolom (1 kolom akan tampil sebagai \"Kolom 1\")." };
  }
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

// A confirmed write must hit the slide the user saw in the proposal. If the deck
// moved between proposal and confirmation, warn instead of rewriting or deleting
// whatever now sits at that position. Every confirmed action goes through this,
// not just deletes: plan and confirm are separated by an unbounded amount of
// human time, and the user can reorder the deck in that window.
const STALE_VERB = {
  delete_slide: "penghapusan",
  improve_slide: "perbaikan",
  replace_slide: "penggantian",
  add_slide: "penyisipan"
};

// The ops that overwrite or remove existing content. add_slide is not one of
// them (it only adds), but it has its own id requirement for the anchor.
const DESTRUCTIVE_OPS = new Set(["improve_slide", "replace_slide", "delete_slide"]);

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
      const verb = STALE_VERB[str(descriptor?.op)] || "penghapusan";
      return {
        ok: false,
        reason: `Deck sudah berubah sejak ${verb} diusulkan${title ? ` (slide "${title}")` : ""}. ` +
          "Tidak ada yang diubah. Minta ulang jika masih diinginkan."
      };
    }
    return { ok: true, id: ids[position], index: position + 1 };
  }

  if (!Number.isInteger(index) || index < 1 || index > ids.length) {
    return { ok: false, reason: `Slide ${index || "?"} tidak ada lagi di deck aktif. Tidak ada yang diubah.` };
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
          .map((range) => str(normalizeSlideText(range.text)))
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

function specFor(slide, position) {
  return { title: str(slide.headline) || "Tantular", slides: [slide], ...(position || {}) };
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

// The tuned improve prompt reads `instruction` as its steering text. The per-
// action intent is the ACTUAL request and goes first, explicitly prioritized;
// the project instructions stay below it as the style guide they are. Neither is
// dropped.
export function composeImproveInstruction(projectInstruction, actionInstruction) {
  const project = str(projectInstruction);
  const asked = str(actionInstruction);
  if (!asked) return project;
  const head = `Permintaan pengguna untuk slide ini (UTAMAKAN ini): ${asked}`;
  return project ? `${head}\n\nStyle guide / instruksi project:\n${project}` : head;
}

// MEASURED: the local planner does NOT emit the optional per-action
// `instruction`, so the intent channel added for it sat empty and every improve
// fell back to the project style guide alone. The pane always has the raw user
// message, so use it as the intent when the planner omits one. The planner's own
// per-action text still wins when present — in a multi-slide turn it is the more
// precise per-slide intent. Same 200-char clamp either way: this text is steering,
// not content.
export function resolveImproveIntent(actionInstruction, userRequest) {
  return sanitizeActionInstruction(actionInstruction) || sanitizeActionInstruction(userRequest);
}

// PowerPoint's in-host textRange.text separates PARAGRAPHS with "\r", so an
// unnormalized 6-bullet body shape reads as one line and every line-based
// measurement below silently collapses to 1. The companion/extractor path
// already normalizes; the host path (Windows) did not.
export function normalizeSlideText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

// --- Content loss ---------------------------------------------------------
// Improve rewrote a 6-bullet slide into a single-column, single-bullet slide and
// reported a bare ✅. With no undo in this add-in, silently discarding five of six
// facts and calling it success is the worst failure this product has. We do not
// block or retry the write — we measure it and say so.
//
// The unit is "one information-bearing line/point": a bullet, a card title or
// desc, a column title, a point inside a column, a metric value or label, a data
// point. It is crude on purpose — it must be pure, testable, and never wrong in
// a way that hides loss.
//
// BOTH SIDES MEASURE CONTENT, NOT CHROME. A previous calibration let each side
// add its own chrome (headline + footer, +1 more for a subhead) and then compared
// them through a RATIO. Chrome in the numerator is a floor of ~3 units that every
// spec earns for free however empty it is, so a 6-unit source could no longer
// reach severity: 6 bullets rewritten into ONE column with ONE point measured
// 8 → 4 and was ACCEPTED — the exact live failure this gate exists to catch.
// So chrome is now excluded from both counts and only content is compared.
//
// The source side is extracted slide text, so its chrome cannot be identified
// perfectly. Two elements are structurally identifiable and both are dropped:
//   * the FIRST line — pptxBuilder emits the headline first and every extractor
//     reads shapes in order, so line 1 is the headline. On a slide with no
//     title this drops one real content line instead; that under-counts the
//     source, which can only make the gate quieter, never falsely severe.
//   * the footer / brand line — matched by the built footer's own shape
//     ("Tantular Deck Studio", optionally "· 3/8") and by any trailing
//     "… · n/m" numbering a non-Tantular deck carries.
// The subhead is NOT identifiable in extracted text (line 2 is a subhead on one
// deck and a real bullet on the next), so rather than leave an asymmetry we
// count the subhead as CONTENT on BOTH sides. It is information the reader sees;
// treating it as content keeps the two counts measuring the same thing, and the
// most a rewrite can gain by inventing one is a single unit.
export function countSourceUnits(text) {
  const lines = normalizeSlideText(text)
    .split("\n")
    .map(str)
    .filter((line) => line.length >= 3 && !isSlideChromeLine(line));
  // Line 1 is the headline; the rest is content.
  return Math.max(0, lines.length - 1);
}

// The built footer is `Tantular Deck Studio` or `Tantular Deck Studio · 3/8`.
function isSlideChromeLine(line) {
  return /^tantular deck studio\b/i.test(line) || /·\s*\d+\s*\/\s*\d+$/.test(line);
}

// CALIBRATION: the spec side counts the CONTENT boxes pptxBuilder would emit —
// not the abstract "items", and not the chrome. drawCards writes one box per card
// title AND per desc, drawMetrics one per value AND per label, drawColumns one
// per column title AND per point. Counting cards as 1 each made a LOSSLESS 4-card
// rewrite look like a 64% loss against its own extraction; counting the chrome
// made a 6→1 gutting look acceptable. Content-only on both sides is the only
// version that gets both right.
//
// Render caps are applied here too (drawBullets slices 7, drawCards 8,
// drawColumns 3 columns × 6 points, drawMetrics 4, drawVisualization 8 data and
// 5 insight bullets). Without them a 12-bullet spec counted 12 while the deck
// renders 7 — an over-count on the KEPT side, i.e. a bias toward accepting a
// write that silently drops the tail.
export function countSpecUnits(slide) {
  if (!slide || typeof slide !== "object") return 0;
  const cap = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  const box = (value) => (str(value) ? 1 : 0);
  const pair = (a, b) => Math.max(1, box(a) + box(b));
  const isViz = slide.type === "visualization";
  return cap(slide.bullets, isViz ? 5 : 7).filter((b) => str(b)).length
    + cap(slide.cards, 8).reduce((sum, card) => sum + pair(card?.title, card?.desc), 0)
    + cap(slide.columns, 3)
      .reduce((sum, col) => sum + 1 + cap(col?.points, 6).filter((p) => str(p)).length, 0)
    + cap(slide.metrics, 4).reduce((sum, m) => sum + pair(m?.value, m?.label), 0)
    + cap(slide.data, 8).reduce((sum, d) => sum + pair(
      d?.value === 0 || d?.value ? String(d.value) : "", d?.label
    ), 0)
    // Counted as content on both sides — see countSourceUnits. The headline and
    // the footer/brand line are chrome and are counted on neither.
    + box(slide.subhead) + box(slide.quote);
}

// THRESHOLD (documented so it can be argued with): warn only when the source had
// at least 3 CONTENT units AND the result keeps AT MOST half of them. A 6→4
// tightening is what "ringkas" means and must stay quiet; 6→1 is content being
// thrown away.
//
// The comparison is `<=`, not `<`. With chrome excluded the counts are smaller
// and the exact-half boundary is now landed on by real guttings rather than by
// rounding noise: a 2×3-column slide rewritten to 2×1 points destroys four of its
// six points (67% of the points, half of all content) and measures exactly
// 8 → 4. Keeping half of a slide's content is loss, not tightening — and the two
// error directions are not symmetric. A false severe costs one extra local model
// call and, at worst, an honest refusal the user can retry; a false accept
// destroys content in a deck with NO UNDO.
export const CONTENT_LOSS_MIN_SOURCE_UNITS = 3;
export const CONTENT_LOSS_RATIO = 0.5;

export function contentLossNote(sourceUnits, keptUnits) {
  const before = Number(sourceUnits) || 0;
  const after = Number(keptUnits) || 0;
  if (before < CONTENT_LOSS_MIN_SOURCE_UNITS) return "";
  if (after > before * CONTENT_LOSS_RATIO) return "";
  return `(${before} poin → ${after} poin — banyak isi dihilangkan; periksa hasilnya)`;
}

// Composable with improveResultNote: the ✅ must say what was actually asked,
// still qualify a fallback result, and never hide that most of the slide is gone.
export function improveSuccessLine(index, actionInstruction, source, lossNote = "", retried = false) {
  const asked = str(actionInstruction);
  const requested = asked ? ` (diminta: "${asked}")` : "";
  const second = retried ? " (perlu percobaan kedua)" : "";
  return `✅ Slide ${index} diperbaiki di tempat${requested}${second}${str(lossNote) ? ` ${str(lossNote)}` : ""}${improveResultNote(source)}.`;
}

// --- Write decision -------------------------------------------------------
// Warning was not enough. Live testing produced a 7-point slide rewritten to ONE
// point three times in a row, and this add-in has NO UNDO: by the time the user
// reads the warning the deck is already damaged. So the destructive write must
// not happen at all. Severity is EXACTLY the threshold behind contentLossNote —
// one notion of "severe", not two.
export function isSevereContentLoss(sourceUnits, keptUnits) {
  return Boolean(contentLossNote(sourceUnits, keptUnits));
}

// Pure decision the executor merely obeys: "accept" (write), "retry" (ask the
// model once more, write nothing yet), "refuse" (write nothing at all, ever).
// The retry is a second local model call, so it is offered ONLY on severe loss
// and only on the first attempt.
export function decideImproveWrite(sourceUnits, keptUnits, attempt = 1) {
  if (!isSevereContentLoss(sourceUnits, keptUnits)) return "accept";
  return Number(attempt) >= 2 ? "refuse" : "retry";
}

// The model is a weak local 9B/4B: nuance in IMPROVE_SLIDE_SYSTEM demonstrably
// did not change its behaviour, so the retry instruction is blunt, concrete and
// numeric, and rides on top of whatever intent was already resolved.
export function composeImproveRetryInstruction(baseInstruction, sourceUnits) {
  const minimal = Math.max(1, Number(sourceUnits) || 1);
  const blunt = [
    "PERCOBAAN KEDUA — WAJIB DIPATUHI:",
    `Percobaan pertama membuang sebagian besar isi slide. Slide sumber punya ${minimal} poin.`,
    `Tulis ulang dengan JUMLAH POIN YANG SAMA, minimal ${minimal} poin. Jangan menggabungkan poin. Jangan menghapus poin.`,
    "Pertahankan SETIAP fakta, angka, nama, dan tanggal dari slide sumber.",
    "Yang boleh diubah HANYA kalimatnya: buat tiap poin lebih pendek dan lebih jelas."
  ].join("\n");
  const base = str(baseInstruction);
  return base ? `${blunt}\n\n${base}` : blunt;
}

// Honest refusal: the user must know the deck was PROTECTED, not that the
// feature quietly did nothing.
export function improveRefusedLine(index, sourceUnits, keptUnits) {
  const before = Number(sourceUnits) || 0;
  const after = Number(keptUnits) || 0;
  return `⛔ Slide ${index} TIDAK diubah — tidak ada perubahan yang ditulis ke deck. `
    + `Model lokal dua kali mengembalikan hasil yang membuang sebagian besar isi (${before} poin → ${after} poin), `
    + "jadi slide sengaja dibiarkan apa adanya. Coba lagi dengan permintaan yang lebih spesifik.";
}

// The real footer numbers for a one-slide spec written into an existing deck.
// The snapshot's index space IS the deck's position space (see
// snapshotIndexSpace), so its max is the real deck size.
// `added` covers an insert, which grows the deck by one before the new slide is
// numbered.
export function deckPositionFor(ctx, position, added = 0) {
  const space = snapshotIndexSpace(ctx);
  const total = Math.max(space.max + added, Number(position) || 0);
  return { startIndex: position, deckTotal: total };
}

// --- Plan / confirm split -------------------------------------------------
// THE LIVE DEFECT: the user clicked the chip "Ringkas isi deck ini" — a QUESTION —
// and the local 9B answered with replace_slide for slides 1..7. The executor
// applied every one of them and reported "✅ Slide 7 diganti." seven times over
// the user's real presentation. Slides 8 and 9 survived only because of the
// 8-actions-per-turn cap. The system prompt already said "kosongkan actions jika
// pengguna hanya bertanya"; the model ignored it, and no wording will reliably
// fix a model this small.
//
// So the safety moved out of the prompt and into the executor: planning and
// writing are now two separate steps, and NOTHING in this module writes to the
// deck until the user has seen the plan and clicked confirm. Deletes already
// worked exactly this way and were the only action never observed to destroy
// anything, so the other three ops were brought onto the same path rather than
// given a second, parallel one.

export const PENDING_OP_VERBS = {
  improve_slide: "perbaiki",
  replace_slide: "ganti",
  add_slide: "tambah",
  delete_slide: "hapus"
};

// One line per planned change, in the user's language, naming the slide it
// touches and saying plainly what it costs. Someone who typed a question must be
// able to read "Ganti slide 3 — seluruh isi lama hilang" and press Batal.
export function describePendingChange(descriptor) {
  const op = str(descriptor?.op);
  const index = Number(descriptor?.slideIndex) || 0;
  const title = str(descriptor?.title);
  const named = title ? ` ("${title}")` : "";
  if (op === "add_slide") {
    return `Tambah slide baru "${str(descriptor?.newTitle) || "tanpa judul"}" setelah slide ${index}`;
  }
  if (op === "improve_slide") return `Perbaiki slide ${index}${named} — isinya ditulis ulang`;
  if (op === "replace_slide") return `Ganti slide ${index}${named} — seluruh isi lama hilang`;
  if (op === "delete_slide") return `Hapus slide ${index}${named}`;
  return `${op || "aksi tidak dikenal"} pada slide ${index}`;
}

// Pure: the whole confirmation UI is derived from the planned list alone.
export function summarizePendingChanges(pending) {
  const list = (Array.isArray(pending) ? pending : []).filter(Boolean);
  const count = list.length;
  const slideNumbers = [...new Set(
    list
      .filter((entry) => str(entry.op) !== "add_slide")
      .map((entry) => Number(entry.slideIndex) || 0)
      .filter((value) => value > 0)
  )].sort((a, b) => a - b);
  const inserts = list.filter((entry) => str(entry.op) === "add_slide").length;

  // Displayed low-to-high, which is how the user reads their deck. Execution
  // order stays high-to-low (orderPptActions) and is not this list's business.
  const lines = list
    .slice()
    .sort((a, b) => (Number(a.slideIndex) || 0) - (Number(b.slideIndex) || 0))
    .map(describePendingChange);

  const parts = [];
  if (slideNumbers.length) {
    parts.push(`${slideNumbers.length} slide yang sudah ada (slide ${slideNumbers.join(", ")})`);
  }
  if (inserts) parts.push(`${inserts} slide baru`);
  const scope = parts.join(" dan ") || `${count} aksi`;

  return {
    count,
    slideNumbers,
    inserts,
    lines,
    headline: `⚠️ Tantular akan MENGUBAH deck ini: ${scope}. `
      + "Tidak ada undo. Periksa daftar di bawah, lalu setujui atau batalkan.",
    confirmLabel: count === 1 ? "Terapkan 1 perubahan" : `Terapkan ${count} perubahan`,
    cancelLabel: "Batal",
    cancelledLine: "⏹ Dibatalkan. Tidak ada slide yang diubah."
  };
}

// A genuine question plans nothing and must stay frictionless: no confirmation
// UI at all. Confirmation appears if and ONLY if the deck would change.
export function needsPptConfirmation(pending) {
  return (Array.isArray(pending) ? pending : []).filter(Boolean).length > 0;
}

// ctx is IMMUTABLE for the whole turn: every target is resolved from the
// original snapshot up front, so no action ever reads a deck state that a
// sibling action just changed.
//
// This function NO LONGER MUTATES THE DECK. It plans, resolves targets against
// the snapshot, and returns descriptors of what WOULD change. Actions that
// cannot be planned at all still report ❌ immediately — refusing to plan is not
// a mutation, and hiding it behind a confirmation would only delay the truth.
export function executePptActions(actions, ctx) {
  const lines = [];
  const pending = [];
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return { lines, pending };

  for (const action of orderPptActions(list)) {
    const target = resolveActionTarget(
      ctx, action.op === "add_slide" ? action.afterIndex : action.slideIndex
    );
    if (!target) {
      lines.push(`❌ ${action.op}: slide tidak ada di snapshot deck.`);
      continue;
    }
    if (action.op === "improve_slide" && !target.text) {
      lines.push(`❌ Slide ${target.index} tidak punya teks yang bisa dibaca untuk diperbaiki.`);
      continue;
    }
    if (action.op === "add_slide" && !target.id) {
      lines.push(`❌ Slide ${target.index} tidak punya id, jadi posisi sisipan tidak bisa dipastikan.`);
      continue;
    }
    // Same refusal, for the ops that DESTROY content. resolveDeleteTarget is
    // allowed to fall back to position when a descriptor carries no id — that is
    // its own contract and stays as it is. But a descriptor with no id reaches
    // the confirmed write with NO staleness detection at all: the user approves
    // "ganti slide 3" and whatever sits at position 3 at confirm time is
    // overwritten. That is exactly the damage the confirmation exists to
    // prevent, so an id-less destructive target is refused HERE, at plan time,
    // the way an id-less insert anchor already is.
    if (DESTRUCTIVE_OPS.has(action.op) && !target.id) {
      lines.push(
        `❌ Slide ${target.index} tidak punya id, jadi ${STALE_VERB[action.op]} tidak bisa dipastikan `
        + "mengenai slide yang benar. Muat ulang deck, lalu coba lagi."
      );
      continue;
    }
    pending.push({
      op: action.op,
      slideIndex: target.index,
      id: target.id,
      title: target.title,
      // Carried from the snapshot so the confirmed write improves the text the
      // user was actually shown.
      ...(action.op === "improve_slide" ? { text: target.text, instruction: action.instruction || "" } : {}),
      ...(action.slide ? { slide: action.slide, newTitle: str(action.slide.headline) } : {})
    });
  }

  return { lines, pending, summary: summarizePendingChanges(pending) };
}

// The confirmed writes. This is the previously-reviewed execution logic, moved
// behind the confirmation unchanged in substance: the improve retry-then-refuse
// gate, the abort re-checks after every model call, verified insert/replace/
// delete, one cache invalidation after the turn's writes, the build tag on
// writes only, and an honest ✅/❌ per action.
//
// What is new is staleness. Plan and confirm are separated by human time, so the
// live deck is re-read before EACH action and the descriptor's id is re-resolved
// against it. If the slide the user approved is gone, that action refuses
// honestly instead of rewriting whatever now sits at that position.
//
// The four Office-touching calls arrive through `hooks`, defaulting to the real
// officeClient imports, so production behaviour and every existing call site are
// unchanged while a test can drive this whole path with plain functions. The
// seam is deliberately narrow: only the calls that need a live PowerPoint.
export async function executeConfirmedPptPlan(pending, hooks = {}) {
  const {
    onProgress = () => {}, signal, tone = "", instruction = "",
    styleId = "nusantara", userRequest = "",
    readLiveIds = readLiveSlideIds,
    deleteSlides = deleteSlidesInActivePresentation,
    replaceSlide = replaceSlideInActivePresentation,
    insertSlideAfter = insertSlideAfterInActivePresentation
  } = hooks;
  const lines = [];
  const planned = (Array.isArray(pending) ? pending : []).filter(Boolean);
  if (!planned.length) return { lines };

  let wrote = false;
  for (let position = 0; position < planned.length; position += 1) {
    const descriptor = planned[position];
    if (signal?.aborted) {
      lines.push(abortReportLine(planned.length - position));
      break;
    }

    let target;
    let deckTotal = 0;
    try {
      const liveIds = await readLiveIds();
      const resolved = resolveDeleteTarget(liveIds, descriptor);
      if (!resolved.ok) { lines.push(`❌ ${resolved.reason}`); continue; }
      target = { id: resolved.id, index: resolved.index, title: str(descriptor.title), text: str(descriptor.text) };
      deckTotal = Array.isArray(liveIds) ? liveIds.length : 0;
    } catch (error) {
      lines.push(`❌ ${descriptor.op} slide ${descriptor.slideIndex}: ${error?.message || error}`);
      continue;
    }

    const action = descriptor;
    try {
      if (action.op === "delete_slide") {
        const outcome = await deleteSlides([target.id]);
        if (!outcome.deleted) { lines.push(`❌ Slide ${target.index}: ${outcome.reason}`); continue; }
        wrote = true;
        lines.push(`✅ Slide ${target.index} ("${target.title}") dihapus.`);
        continue;
      }

      if (action.op === "improve_slide") {
        onProgress(`Menyusun versi lebih baik untuk slide ${target.index}...`);
        const intent = resolveImproveIntent(action.instruction, userRequest);
        const baseInstruction = composeImproveInstruction(instruction, intent);
        let result = await improveExistingSlide({
          slideText: target.text, tone, instruction: baseInstruction, signal
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

        // No undo: on severe loss we do not write and then apologise. We retry
        // once with a blunt instruction, and if that is bad too we write nothing.
        const sourceUnits = countSourceUnits(target.text);
        let keptUnits = countSpecUnits(result.spec?.slides?.[0]);
        let retried = false;
        if (decideImproveWrite(sourceUnits, keptUnits, 1) === "retry") {
          retried = true;
          onProgress(`Hasil pertama membuang terlalu banyak isi — mencoba sekali lagi untuk slide ${target.index}...`);
          const second = await improveExistingSlide({
            slideText: target.text,
            tone,
            instruction: composeImproveRetryInstruction(baseInstruction, sourceUnits),
            signal
          });
          if (signal?.aborted) {
            lines.push(`⏹ Slide ${target.index} TIDAK diubah — dihentikan sebelum ditulis ke deck.`);
            lines.push(abortReportLine(planned.length - position - 1));
            break;
          }
          if (second?.spec) {
            result = second;
            keptUnits = countSpecUnits(second.spec?.slides?.[0]);
          }
          if (decideImproveWrite(sourceUnits, keptUnits, 2) === "refuse") {
            lines.push(improveRefusedLine(target.index, sourceUnits, keptUnits));
            continue;
          }
        }

        onProgress(`Mengganti slide ${target.index}...`);
        const outcome = await replaceSlide(
          buildDeckPptxBase64(
            { ...result.spec, ...deckPositionFor(deckTotal, target.index) },
            styleId,
            instruction
          ),
          { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
        );
        if (outcome.replaced) {
          wrote = true;
          lines.push(improveSuccessLine(
            target.index, intent, result.source, contentLossNote(sourceUnits, keptUnits), retried
          ));
        } else lines.push(`❌ Slide ${target.index}: ${outcome.reason || "penggantian gagal."}`);
        continue;
      }

      if (action.op === "replace_slide") {
        onProgress(`Mengganti slide ${target.index}...`);
        const outcome = await replaceSlide(
          buildDeckPptxBase64(specFor(action.slide, deckPositionFor(deckTotal, target.index)), styleId, instruction),
          { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
        );
        if (outcome.replaced) { wrote = true; lines.push(`✅ Slide ${target.index} diganti.`); }
        else lines.push(`❌ Slide ${target.index}: ${outcome.reason || "penggantian gagal."}`);
        continue;
      }

      // add_slide. An anchor with no id was already refused at plan time, but
      // the live re-resolution above can only ever hand back an id it found.
      onProgress(`Menyisipkan slide setelah slide ${target.index}...`);
      const title = str(action.slide?.headline) || "tanpa judul";
      // Verified insert: reads the deck before and after inside one context and
      // refuses to claim success unless exactly one slide landed right after the
      // anchor — the same contract replace and delete already honor.
      const inserted = await insertSlideAfter(
        buildDeckPptxBase64(
          specFor(action.slide, deckPositionFor(deckTotal, target.index + 1, 1)),
          styleId,
          instruction
        ),
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

  // Clear once, after the turn's writes. A refused or stale action is not a write.
  if (wrote) {
    invalidateDeckContext();
    lines.push(`(${PPT_CHAT_BUILD})`);
  }
  return { lines };
}

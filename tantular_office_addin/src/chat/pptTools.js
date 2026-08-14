// Tantular PowerPoint chat tools — deck reading, action validation, execution.
// All Office/PowerPoint access for the PPT chat lives here so pptChat.js can
// stay a pure UI module (mirrors the excelChat.js / excelTools.js split).

import { SLIDE_TYPES } from "../deck/deckPlanner.js";

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
const TYPE_RULES = {
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

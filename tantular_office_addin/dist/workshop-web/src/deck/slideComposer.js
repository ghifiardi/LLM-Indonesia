// Automatic re-layout ("tata ulang") in the slide's OWN design.
//
// The model only sees text; this module sees the slide. It groups the text
// boxes on a slide, chooses a layout pattern for that content shape, and
// produces a geometry plan for the native renderer (officeClient.
// buildNativeCardsOnSlide): panels with heading bars, one marker per bullet
// line, even vertical distribution, one consistent type size chosen from the
// line count. Fonts and colours come from the slide (deck/nativeCards.
// resolveCardStyle); nothing here invents a colour. Pure — no Office, no model.
// Units are points on a 960×540 slide.

import { fitText } from "./pptxBuilder.js";

const SLIDE_W = 960;
const SLIDE_H = 540;
const MARGIN = 54;
const FOOTER_TEXT_RE = /·\s*\d+\s*\/\s*\d+\s*$/;
const str = (v) => String(v ?? "").replace(/\r\n?/g, "\n");
const isText = (s) => str(s?.text).trim().length > 0;

function inlineHeadingOf(lines) {
  if (lines.length < 2) return "";
  const first = lines[0];
  const mean = lines.slice(1).reduce((sum, l) => sum + l.length, 0) / (lines.length - 1);
  return first.length <= 60 && !/[.!?:;]$/.test(first) && first.length <= 0.6 * mean ? first : "";
}

// Title = topmost text shape; footer = builder footer or the lowest "·" line;
// groups = the remaining text boxes in top order; markers = small non-text
// shapes beside them. `deleteIndexes` is everything the new layout replaces.
export function analyseSlideContent(shapes, { includeDecorations = false } = {}) {
  const list = Array.isArray(shapes) ? shapes : [];
  const indexed = list.map((s, i) => ({ s, i }));
  const textual = indexed.filter(({ s }) => isText(s));
  const footer = textual.filter(({ s }) => FOOTER_TEXT_RE.test(str(s.text)) || /·/.test(str(s.text)))
    .sort((a, b) => Number(b.s.top) - Number(a.s.top))[0] || null;
  const body = textual.filter((x) => x !== footer).sort((a, b) => Number(a.s.top) - Number(b.s.top));
  const titleEntry = body[0] || null;
  const boxes = body.slice(1);
  const markers = indexed.filter(({ s, i }) => !isText(s) && Number(s.width) <= 24 && Number(s.height) <= 24
    && (!titleEntry || i !== titleEntry.i));
  let groups = boxes.map(({ s, i }) => {
    const lines = str(s.text).split("\n").map((l) => l.trim()).filter(Boolean);
    const heading = inlineHeadingOf(lines);
    return { index: i, heading, items: heading ? lines.slice(1) : lines, left: Number(s.left) };
  }).filter((g) => g.items.length);
  // Builder layout / slot writes (live host36): several same-column boxes of
  // one or two lines each are ONE list, not N one-item groups.
  if (groups.length >= 2 && groups.every((g) => !g.heading && g.items.length <= 2)) {
    const lefts = groups.map((g) => g.left).filter(Number.isFinite);
    if (lefts.length === groups.length && Math.max(...lefts) - Math.min(...lefts) <= 24) {
      groups = [{ index: groups[0].index, heading: "", items: groups.flatMap((g) => g.items), left: lefts[0] }];
    }
  }
  groups = groups.map(({ left, ...g }) => g);
  const contentTop = boxes.length ? Math.min(...boxes.map(({ s }) => Number(s.top))) : 150;
  const bottom = footer ? Number(footer.s.top) - 12 : SLIDE_H - 48;
  const left = Math.min(MARGIN, ...markers.map(({ s }) => Number(s.left)).filter(Number.isFinite));
  const box = { left: Number.isFinite(left) ? left : MARGIN, top: contentTop, right: SLIDE_W - MARGIN, bottom };
  // Decorations: filled, textless, non-picture shapes inside the content area
  // (panels, bars, leftovers of a failed run). Replaced only when asked — a
  // Deck Studio slide is ours to compose; a user's own slide is not.
  const decorations = includeDecorations
    ? indexed.filter(({ s, i }) => !isText(s) && !/picture|image|graphic|chart|table/i.test(String(s.name || ""))
        && !markers.some((m) => m.i === i) && (!titleEntry || i !== titleEntry.i)
        && Number(s.top) >= box.top - 20 && Number(s.top) < box.bottom
        && Number(s.width) > 24 && Number(s.width) < SLIDE_W - 20 && Number(s.height) < SLIDE_H - 40).map(({ i }) => i)
    : [];
  return {
    title: titleEntry ? str(titleEntry.s.text).trim() : "",
    groups,
    box,
    deleteIndexes: [...new Set([...boxes.map(({ i }) => i), ...markers.map(({ i }) => i), ...decorations])].sort((a, b) => a - b)
  };
}

// A single sentence is a bullet; a paragraph is prose.
const isProse = (groups) => groups.some((g) => g.items.some((item) => item.length > 160))
  && groups.every((g) => g.items.length <= 3);

export function choosePattern(groups) {
  const list = Array.isArray(groups) ? groups.filter((g) => g?.items?.length) : [];
  if (!list.length) return "stack";
  if (isProse(list)) return "prose";
  if (list.length === 1) return list[0].items.length <= 7 ? "stack" : "panels";
  if (list.length <= 3) return "panels";
  return "panels-2rows";
}

export function fontSizeFor(lineCount) {
  const n = Number(lineCount) || 0;
  if (n <= 4) return 18;
  if (n <= 7) return 16;
  if (n <= 10) return 14;
  return 12;
}

// Split one long list into two balanced panels so "panels" always has ≥2.
function normaliseGroups(groups, pattern) {
  if (pattern === "panels" && groups.length === 1) {
    const items = groups[0].items;
    const half = Math.ceil(items.length / 2);
    return [{ ...groups[0], items: items.slice(0, half) }, { heading: "", items: items.slice(half) }];
  }
  return groups;
}

const SIZES = [24, 22, 20, 18, 16, 14, 12];
const wrappedLines = (text, width, size) => Math.max(1, Math.ceil(str(text).length / Math.max(8, Math.floor(width / (size * 0.5)))));

// The largest size whose wrapped lines, plus a breathing gap between items,
// fit the box. Six sentences in a 338 pt box came out at 16 pt from the line
// count alone and left a third of the slide empty (live host37).
export function fitFontSize(items, width, height, { minGap = 8 } = {}) {
  const list = (Array.isArray(items) ? items : []).map(str);
  for (const size of SIZES) {
    const total = list.reduce((sum, item) => sum + wrappedLines(item, width - 22, size) * size * 1.35, 0) + Math.max(0, list.length - 1) * minGap;
    if (total <= height) return size;
  }
  return SIZES[SIZES.length - 1];
}

function linesBlock(plan, { left, top, width, height, items, style, size, accent }) {
  const n = items.length;
  const lineH = size * 1.35;
  const heights = items.map((item) => wrappedLines(item, width - 22, size) * lineH);
  const total = heights.reduce((a, b) => a + b, 0);
  const gap = n > 1 ? Math.min(Math.max(0, (height - total) / (n - 1)), lineH * 1.2) : 0;
  let y = top;
  items.forEach((item, i) => {
    plan.push({ kind: "marker", left, top: y + (lineH - 10) / 2, width: 10, height: 10, fill: accent, line: false });
    const fitted = fitText(item, { maxChars: Math.max(20, Math.floor((width - 22) / (size * 0.5)) * 3), baseSize: size, minSize: Math.max(10, size - 4), step: 1 });
    plan.push({ kind: "line", left: left + 22, top: y, width: width - 22, height: heights[i], text: fitted.text,
                font: { name: style.bodyFont, color: style.bodyColor, size: fitted.size, bold: false } });
    y += heights[i] + gap;
  });
}

export function planSlideComposition({ content, pattern, style, headings = [] }) {
  const box = content?.box || { left: MARGIN, top: 150, right: SLIDE_W - MARGIN, bottom: SLIDE_H - 48 };
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const groups = normaliseGroups((content?.groups || []).filter((g) => g.items?.length), pattern);
  const plan = [];
  const accentOf = (i) => (i % 2 && style.accent2 ? style.accent2 : style.accent);
  if (!groups.length) return plan;

  if (pattern === "stack") {
    const items = groups.flatMap((g) => g.items);
    linesBlock(plan, { left: box.left, top: box.top, width, height, items, style, size: fitFontSize(items, width, height), accent: style.accent });
    return plan;
  }
  if (pattern === "prose") {
    const text = groups.flatMap((g) => [g.heading, ...g.items]).filter(Boolean).join("\n\n");
    const size = Math.max(12, Math.min(16, fontSizeFor(Math.ceil(text.length / 90))));
    const fitted = fitText(text, { maxChars: Math.floor(width / (size * 0.5)) * Math.floor(height / (size * 1.35)), baseSize: size, minSize: 12, step: 1 });
    plan.push({ kind: "text", left: box.left, top: box.top, width, height, text: fitted.text,
                font: { name: style.bodyFont, color: style.bodyColor, size: fitted.size, bold: false } });
    return plan;
  }

  // panels / panels-2rows
  const rows = pattern === "panels-2rows" ? 2 : 1;
  const cols = Math.ceil(groups.length / rows);
  const gap = 16;
  const pw = (width - gap * (cols - 1)) / cols;
  const ph = (height - gap * (rows - 1)) / rows;
  const barH = 34;
  const pad = 14;
  const size = Math.min(...groups.map((g) => fitFontSize(g.items, pw - pad * 2, ph - barH - pad * 2)));
  groups.forEach((g, i) => {
    const left = box.left + (i % cols) * (pw + gap);
    const top = box.top + Math.floor(i / cols) * (ph + gap);
    const accent = accentOf(i);
    plan.push({ kind: "panel", left, top, width: pw, height: ph, fill: style.panel || "#F6F7F9", line: false });
    plan.push({ kind: "bar", left, top, width: pw, height: barH, fill: accent, line: false });
    const heading = str(headings[i] || g.heading || g.items[0]).trim();
    const fittedHeading = fitText(heading, { maxChars: Math.max(12, Math.floor((pw - pad * 2) / 8)), baseSize: 16, minSize: 12, step: 1 });
    plan.push({ kind: "heading", left: left + pad, top: top + 7, width: pw - pad * 2, height: barH - 12, text: fittedHeading.text,
                font: { name: style.titleFont, color: style.onAccent || "#FFFFFF", size: fittedHeading.size, bold: true } });
    linesBlock(plan, { left: left + pad, top: top + barH + pad, width: pw - pad * 2, height: ph - barH - pad * 2,
                       items: g.items, style, size: Math.max(11, size), accent });
  });
  return plan;
}

export function describeComposition(pattern, groupCount) {
  if (pattern === "stack") return "satu daftar poin yang dibagi rata di area isi";
  if (pattern === "prose") return "satu blok teks";
  return `${groupCount} panel dengan bar judul${pattern === "panels-2rows" ? " dalam dua baris" : ""}`;
}

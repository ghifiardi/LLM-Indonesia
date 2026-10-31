// Native visual cards: pure geometry + style resolution for card panels drawn
// ON the user's own slide through the PowerPoint shape API (officeClient.
// buildNativeCardsOnSlide). Nothing here touches Office. This ADDS a visual
// layout that the in-place text writer cannot express; that writer is
// untouched. Units are points, like the shape API.

import { fitText } from "./pptxBuilder.js";

const FALLBACK = { accent: "#1F3A5F", titleFont: "Calibri", titleColor: "#1F3A5F", bodyFont: "Calibri", bodyColor: "#222222", bodySize: 12 };

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isColor = (v) => /^#?[0-9a-f]{6}$/i.test(str(v));
const hex = (v) => (str(v).startsWith("#") ? str(v) : `#${str(v)}`).toUpperCase();

// Reads from the host often come back EMPTY when a colour or font is inherited
// from the theme/master (design review, condition 1). Every field therefore
// has an explicit fallback, and the list of fallbacks used is returned so the
// result line can say so honestly.
export function resolveCardStyle(read = {}) {
  const fallbacks = [];
  const pick = (field, value, ok) => {
    if (ok(value)) return value;
    fallbacks.push(field);
    return FALLBACK[field];
  };
  const titleColor = isColor(read?.title?.color) ? hex(read.title.color) : "";
  const accentRead = isColor(read?.headingColor) ? hex(read.headingColor) : titleColor;
  const style = {
    accent: pick("accent", accentRead, isColor),
    titleFont: pick("titleFont", str(read?.title?.name), Boolean),
    titleColor: pick("titleColor", titleColor, isColor),
    bodyFont: pick("bodyFont", str(read?.body?.name), Boolean),
    bodyColor: pick("bodyColor", isColor(read?.body?.color) ? hex(read.body.color) : "", isColor),
    bodySize: pick("bodySize", Number(read?.body?.size) || 0, (n) => n >= 8 && n <= 40)
  };
  return { ...style, fallbacks };
}

export function describeCardStyle(style) {
  const f = Array.isArray(style?.fallbacks) ? style.fallbacks : [];
  if (!f.length) return "warna dan font mengikuti slide ini";
  return `warna/font mengikuti yang terbaca dari slide; ${f.length} nilai tidak terbaca dan memakai bawaan (${f.join(", ")})`;
}

// Layout mirrors pptxBuilder.drawCards: up to 3 in a row, 4 ⇒ 2×2, 5–6 ⇒ 3×2.
export function planNativeCards({ box, cards, style }) {
  const list = (Array.isArray(cards) ? cards : []).slice(0, 6);
  if (!list.length || !box) return [];
  const cols = list.length <= 3 ? list.length : list.length <= 4 ? 2 : 3;
  const rows = Math.ceil(list.length / cols);
  const gap = 14;
  const cw = (box.width - gap * (cols - 1)) / cols;
  const ch = (box.height - gap * (rows - 1)) / rows;
  const pad = 12;
  const titleSize = Math.max(11, Math.min(18, Math.round((style.bodySize || 12) * 1.15)));
  const plan = [];
  list.forEach((card, i) => {
    const left = box.left + (i % cols) * (cw + gap);
    const top = box.top + Math.floor(i / cols) * (ch + gap);
    plan.push({ kind: "panel", left, top, width: cw, height: ch, fill: "#FFFFFF", line: false, alpha: 0.35 });
    plan.push({ kind: "bar", left, top, width: cw, height: 5, fill: style.accent, line: false });
    const title = fitText(str(card.title), { maxChars: Math.max(12, Math.floor((cw - pad * 2) / (titleSize * 0.5)) * 2), baseSize: titleSize, minSize: 10, step: 1 });
    plan.push({
      kind: "title", left: left + pad, top: top + 12, width: cw - pad * 2, height: 36, text: title.text,
      font: { name: style.titleFont, color: style.titleColor, size: title.size, bold: true }
    });
    const lines = (Array.isArray(card.lines) ? card.lines : [card.desc]).map(str).filter(Boolean);
    const bodyText = lines.join("\n");
    const bodyH = ch - 12 - 36 - pad;
    const perLine = Math.max(10, Math.floor((cw - pad * 2) / ((style.bodySize || 12) * 0.5)));
    const maxLines = Math.max(2, Math.floor(bodyH / ((style.bodySize || 12) * 1.3)));
    const body = fitText(bodyText, { maxChars: perLine * maxLines, baseSize: style.bodySize || 12, minSize: 9, step: 1 });
    plan.push({
      kind: "text", left: left + pad, top: top + 12 + 36, width: cw - pad * 2, height: bodyH, text: body.text,
      font: { name: style.bodyFont, color: style.bodyColor, size: body.size, bold: false }
    });
  });
  return plan;
}

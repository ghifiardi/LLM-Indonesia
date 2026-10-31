// Deterministic layout repair for one slide. The model only sees text; this
// module sees geometry. It audits a slide's stacked text boxes for overlap and
// overflow and produces a reflow that KEEPS THE DESIGN: same fonts, colours,
// order, left edges and widths. Boxes are re-stacked top to bottom with their
// original gap; if the stack no longer fits above the footer the body font
// shrinks step by step to a floor; only past the floor are tail boxes merged.
// Bullet markers (small non-text shapes beside a box) move with their box.
// Pure: no Office, no model. Units are points on a 960×540 slide.

const SLIDE_H = 540;
const LINE_HEIGHT = 1.25;
const PADDING = 8;
const MIN_FONT = 10;
const DEFAULT_FONT = 14;
const FOOTER_TEXT_RE = /·\s*\d+\s*\/\s*\d+\s*$/;

const str = (v) => String(v ?? "");
const isText = (shape) => str(shape?.text).trim().length > 0;

export function estimateTextHeight(text, width, fontSize) {
  const size = Number(fontSize) || DEFAULT_FONT;
  const perLine = Math.max(8, Math.floor((Number(width) || 400) / (size * 0.5)));
  const lines = str(text).replace(/\r\n?/g, "\n").split("\n")
    .reduce((sum, para) => sum + Math.max(1, Math.ceil(para.trim().length / perLine)), 0);
  return Math.max(1, lines) * size * LINE_HEIGHT + PADDING;
}

function contentBounds(shapes) {
  const footer = shapes.map((s, i) => ({ s, i }))
    .filter(({ s }) => isText(s) && (FOOTER_TEXT_RE.test(str(s.text)) || /·/.test(str(s.text))))
    .sort((a, b) => b.s.top - a.s.top)[0];
  const bottom = footer ? Number(footer.s.top) - 12 : SLIDE_H - 48;
  return { contentBottom: bottom, footerIndex: footer ? footer.i : -1 };
}

// The stack: text shapes below the title (the topmost text shape), excluding
// the footer, in top order. Small non-text shapes are bullet markers.
function classify(shapes) {
  const list = Array.isArray(shapes) ? shapes : [];
  const { contentBottom, footerIndex } = contentBounds(list);
  const textual = list.map((s, i) => ({ s, i })).filter(({ s, i }) => isText(s) && i !== footerIndex);
  if (!textual.length) return { titleIndex: -1, stack: [], markers: [], contentBottom };
  textual.sort((a, b) => Number(a.s.top) - Number(b.s.top));
  const titleIndex = textual[0].i;
  const stack = textual.slice(1).map(({ i }) => i);
  const markers = list.map((s, i) => ({ s, i }))
    .filter(({ s, i }) => !isText(s) && i !== titleIndex && Number(s.width) <= 24 && Number(s.height) <= 24)
    .map(({ i }) => i);
  return { titleIndex, stack, markers, contentBottom };
}

export function auditSlideLayout(shapes) {
  const list = Array.isArray(shapes) ? shapes : [];
  const { stack, contentBottom } = classify(list);
  const overlaps = [];
  let overflow = false;
  for (let k = 0; k < stack.length; k += 1) {
    const s = list[stack[k]];
    const needed = Math.max(Number(s.height) || 0, estimateTextHeight(s.text, s.width, s.fontSize));
    const bottom = Number(s.top) + needed;
    if (k + 1 < stack.length && bottom > Number(list[stack[k + 1]].top) + 1) overlaps.push({ a: stack[k], b: stack[k + 1] });
    if (bottom > contentBottom + 1) overflow = true;
  }
  return { ok: overlaps.length === 0 && !overflow, overlaps, overflow, stack, contentBottom };
}

export function reflowSlideLayout(shapes) {
  const list = Array.isArray(shapes) ? shapes : [];
  const { stack, markers, contentBottom } = classify(list);
  if (stack.length < 1) return { ok: false, reason: "no_stack", writes: [] };
  const originalFontSize = Number(list[stack[0]].fontSize) || DEFAULT_FONT;
  const firstTop = Number(list[stack[0]].top);
  const gap = stack.length > 1
    ? Math.max(6, Number(list[stack[1]].top) - (Number(list[stack[0]].top) + Number(list[stack[0]].height)))
    : 8;

  // Working copy of the stack's texts; merging the tail rewrites these.
  let boxes = stack.map((i) => ({ index: i, text: str(list[i].text), width: Number(list[i].width) || 400 }));
  let fontSize = originalFontSize;
  let merged = 0;
  const layout = (size) => {
    let y = firstTop;
    const placed = boxes.map((b) => {
      const height = estimateTextHeight(b.text, b.width, size);
      const item = { index: b.index, top: Math.round(y), height: Math.round(height) };
      y += height + gap;
      return item;
    });
    return { placed, bottom: y - gap };
  };
  let result = layout(fontSize);
  while (result.bottom > contentBottom && fontSize > MIN_FONT) { fontSize -= 1; result = layout(fontSize); }
  while (result.bottom > contentBottom && boxes.length > 1) {
    const tail = boxes.pop();
    boxes[boxes.length - 1] = { ...boxes[boxes.length - 1], text: `${boxes[boxes.length - 1].text}\n${tail.text}` };
    merged += 1;
    result = layout(fontSize);
  }

  const writes = [];
  result.placed.forEach((p, k) => {
    const write = { index: p.index, top: p.top, height: p.height };
    if (fontSize !== originalFontSize) write.fontSize = fontSize;
    if (boxes[k].text !== str(list[p.index].text)) write.text = boxes[k].text;
    writes.push(write);
  });
  // Merged-away boxes are cleared; their markers hidden by moving with a cleared box.
  const kept = new Set(boxes.map((b) => b.index));
  for (const i of stack) if (!kept.has(i)) writes.push({ index: i, top: contentBottom, height: 1, text: "", clear: true });
  // Markers follow the box whose original top band they sat in.
  for (const m of markers) {
    const mTop = Number(list[m].top);
    const owner = stack.find((i) => mTop >= Number(list[i].top) - 2 && mTop <= Number(list[i].top) + Number(list[i].height));
    if (owner === undefined) continue;
    const moved = result.placed.find((p) => p.index === owner);
    if (!moved) continue;
    const offset = mTop - Number(list[owner].top);
    writes.push({ index: m, top: moved.top + offset });
  }
  const movedBoxes = result.placed.filter((p) => p.top !== Number(list[p.index].top) || p.height !== Number(list[p.index].height)).length;
  return { ok: true, writes, gap, fontSize, originalFontSize, merged, movedBoxes, contentBottom };
}

export function describeLayoutRepair(plan) {
  if (!plan?.ok) return "tata letak tidak bisa dirapikan";
  const parts = [`${plan.movedBoxes ?? plan.writes.filter((w) => w.height !== undefined).length} kotak teks digeser`];
  if (plan.fontSize !== plan.originalFontSize) parts.push(`ukuran huruf ${plan.originalFontSize} → ${plan.fontSize}`);
  if (plan.merged) parts.push(`${plan.merged} kotak digabung`);
  return parts.join(", ");
}

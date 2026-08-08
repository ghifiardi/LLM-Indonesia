// Minimal PPTX builder for Tantular Deck Studio.
// Generates a complete .pptx in-browser (no dependencies) and returns Base64.
// This is more reliable in PowerPoint web than mutating slides shape-by-shape.

import { getStyle } from "./deckStyles.js";

const PT = 12700; // EMU per point
const W = 960;
const H = 540;
const CX = W * PT;
const CY = H * PT;
const M = 54;

export function buildDeckPptxBase64(spec, styleId, projectInstructions = "") {
  const style = getStyle(styleId, projectInstructions);
  const slides = Array.isArray(spec?.slides) ? spec.slides : [];
  if (!slides.length) throw new Error("DeckSpec kosong; tidak ada slide untuk dibuat.");

  const files = new Map();
  files.set("[Content_Types].xml", contentTypes(slides.length));
  files.set("_rels/.rels", rootRels());
  files.set("docProps/app.xml", appXml(slides.length));
  files.set("docProps/core.xml", coreXml());
  files.set("ppt/presentation.xml", presentationXml(slides.length));
  files.set("ppt/_rels/presentation.xml.rels", presentationRels(slides.length));
  files.set("ppt/theme/theme1.xml", themeXml(style));
  files.set("ppt/slideMasters/slideMaster1.xml", slideMasterXml());
  files.set("ppt/slideMasters/_rels/slideMaster1.xml.rels", slideMasterRels());
  files.set("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml());
  files.set("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slideLayoutRels());

  slides.forEach((slide, i) => {
    files.set(`ppt/slides/slide${i + 1}.xml`, slideXml(slide, style, i, slides.length));
    files.set(`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRels());
  });

  return zipBase64(files);
}

function slideXml(s, style, index, total) {
  const bg = s.type === "title" || s.type === "quote" ? style.heroBg : style.bg;
  const shapes = [];
  let id = 2;
  const add = (xml) => shapes.push(xml);

  add(rect(++id, 0, 0, W, H, bg));
  if (s.type === "title" || s.type === "quote") {
    add(rect(++id, 0, H - 96, W, 96, style.accent));
    add(rect(++id, 0, H - 96, 240, 96, style.accent2));
    add(rect(++id, 0, 0, 12, H, style.accent2));
  } else {
    add(rect(++id, 0, 0, 12, H, style.accent));
    add(rect(++id, M, 104, 72, 6, style.accent2));
  }

  if (s.type === "title") drawTitle(add, idRef(() => ++id), s, style);
  else if (s.type === "quote") drawQuote(add, idRef(() => ++id), s, style);
  else if (s.type === "cards") drawCards(add, idRef(() => ++id), s, style, index, total);
  else if (s.type === "columns") drawColumns(add, idRef(() => ++id), s, style, index, total);
  else if (s.type === "metrics") drawMetrics(add, idRef(() => ++id), s, style, index, total);
  else if (s.type === "visualization") drawVisualization(add, idRef(() => ++id), s, style, index, total);
  else drawBullets(add, idRef(() => ++id), s, style, index, total);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${shapes.join("\n")}
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function idRef(next) { return { next }; }

function drawTitle(add, ids, s, style) {
  add(textBox(ids.next(), s.headline || "Presentasi", M, 176, W - M * 2, 130, { size: 42, bold: true, color: style.title }));
  add(textBox(ids.next(), s.subhead || "", M, 318, W - M * 2, 70, { size: 20, color: style.muted }));
  add(textBox(ids.next(), "Tantular Deck Studio", M, H - 70, 420, 36, { size: 15, bold: true, color: style.onAccent }));
}

function drawQuote(add, ids, s, style) {
  add(textBox(ids.next(), `“${s.headline || ""}”`, M + 18, 166, W - (M + 18) * 2, 190, { size: 32, bold: true, color: style.title }));
  if (s.subhead) add(textBox(ids.next(), `— ${s.subhead}`, M + 18, 374, W - (M + 18) * 2, 45, { size: 18, color: style.muted }));
}

function header(add, ids, s, style) {
  add(textBox(ids.next(), s.headline || "", M, 42, W - M * 2, 56, { size: 28, bold: true, color: style.title }));
  if (s.subhead) add(textBox(ids.next(), s.subhead, M, 116, W - M * 2, 34, { size: 15, color: style.muted }));
}

function drawBullets(add, ids, s, style, index, total) {
  header(add, ids, s, style);
  const bullets = (s.bullets || []).slice(0, 7);
  const top = s.subhead ? 168 : 150;
  const rowH = Math.min(58, Math.max(42, (H - top - 64) / Math.max(1, bullets.length)));
  bullets.forEach((b, i) => {
    const y = top + i * rowH;
    add(rect(ids.next(), M, y + 10, 12, 12, style.accent));
    add(textBox(ids.next(), b, M + 30, y, W - M * 2 - 30, rowH, { size: 18, color: style.text }));
  });
  footer(add, ids, style, index, total);
}

function drawCards(add, ids, s, style, index, total) {
  header(add, ids, s, style);
  const cards = (s.cards || []).slice(0, 8);
  const cols = cards.length <= 3 ? Math.max(1, cards.length) : cards.length <= 4 ? 2 : cards.length <= 6 ? 3 : 4;
  const rows = Math.ceil(cards.length / cols) || 1;
  const gap = 18, top = 164, areaW = W - M * 2, areaH = H - top - 58;
  const cw = (areaW - gap * (cols - 1)) / cols;
  const ch = (areaH - gap * (rows - 1)) / rows;
  cards.forEach((c, i) => {
    const x = M + (i % cols) * (cw + gap);
    const y = top + Math.floor(i / cols) * (ch + gap);
    add(rect(ids.next(), x, y, cw, ch, style.panel));
    add(rect(ids.next(), x, y, cw, 7, i % 2 ? style.accent2 : style.accent));
    add(textBox(ids.next(), c.title || "", x + 15, y + 17, cw - 30, 40, { size: 16, bold: true, color: style.title }));
    if (c.desc) add(textBox(ids.next(), c.desc, x + 15, y + 58, cw - 30, ch - 68, { size: 12.5, color: style.text }));
  });
  footer(add, ids, style, index, total);
}

function drawColumns(add, ids, s, style, index, total) {
  header(add, ids, s, style);
  const cols = (s.columns || []).slice(0, 3);
  const n = Math.max(1, cols.length), gap = 20, top = 164, areaW = W - M * 2;
  const cw = (areaW - gap * (n - 1)) / n;
  const ch = H - top - 58;
  cols.forEach((col, i) => {
    const x = M + i * (cw + gap);
    add(rect(ids.next(), x, top, cw, ch, style.panel));
    add(rect(ids.next(), x, top, cw, 46, i % 2 ? style.accent2 : style.accent));
    add(textBox(ids.next(), col.title || `Kolom ${i + 1}`, x + 14, top + 8, cw - 28, 30, { size: 16, bold: true, color: style.onAccent }));
    (col.points || []).slice(0, 6).forEach((p, j) => {
      const y = top + 62 + j * 40;
      add(rect(ids.next(), x + 16, y + 8, 9, 9, style.accent));
      add(textBox(ids.next(), p, x + 32, y, cw - 48, 38, { size: 12.5, color: style.text }));
    });
  });
  footer(add, ids, style, index, total);
}

function drawMetrics(add, ids, s, style, index, total) {
  header(add, ids, s, style);
  const metrics = (s.metrics || []).slice(0, 4);
  const n = Math.max(1, metrics.length), gap = 20, top = 190, areaW = W - M * 2;
  const cw = (areaW - gap * (n - 1)) / n;
  metrics.forEach((m, i) => {
    const x = M + i * (cw + gap);
    add(rect(ids.next(), x, top, cw, 210, style.panel));
    add(rect(ids.next(), x, top + 202, cw, 8, i % 2 ? style.accent2 : style.accent));
    add(textBox(ids.next(), m.value || "", x + 12, top + 34, cw - 24, 86, { size: 44, bold: true, color: style.accent }));
    add(textBox(ids.next(), m.label || "", x + 12, top + 136, cw - 24, 60, { size: 14, color: style.text }));
  });
  footer(add, ids, style, index, total);
}

function drawVisualization(add, ids, s, style, index, total) {
  header(add, ids, s, style);
  const data = (s.data || []).slice(0, 8);
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  const x0 = M + 24;
  const y0 = 180;
  const chartW = 560;
  const chartH = 250;
  const gap = 10;
  const barW = data.length ? (chartW - gap * (data.length - 1)) / data.length : 44;
  add(rect(ids.next(), M, 150, W - M * 2, 330, style.panel));
  add(rect(ids.next(), x0, y0 + chartH, chartW, 2, style.muted));
  data.forEach((d, i) => {
    const value = Math.max(0, Number(d.value) || 0);
    const h = Math.max(4, (value / max) * (chartH - 36));
    const x = x0 + i * (barW + gap);
    const y = y0 + chartH - h;
    const colors = style.projectPalette || [style.accent, style.accent2, style.panelAlt];
    add(rect(ids.next(), x, y, barW, h, colors[i % colors.length]));
    add(textBox(ids.next(), String(d.value), x, y - 28, barW, 22, { size: 11, bold: true, color: style.title }));
    add(textBox(ids.next(), d.label || "", x - 4, y0 + chartH + 8, barW + 8, 54, { size: 9.5, color: style.text }));
  });
  const insights = (s.bullets || []).slice(0, 5);
  insights.forEach((b, i) => {
    const y = 182 + i * 48;
    add(rect(ids.next(), M + 620, y + 8, 10, 10, style.accent2));
    add(textBox(ids.next(), b, M + 638, y, W - M - (M + 638), 44, { size: 13, color: style.text }));
  });
  footer(add, ids, style, index, total);
}

function footer(add, ids, style, index, total) {
  add(textBox(ids.next(), `Tantular Deck Studio · ${index + 1}/${total}`, M, H - 34, W - M * 2, 22, { size: 10, color: style.muted }));
}

function rect(id, left, top, width, height, fill) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rect ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(left)}" y="${emu(top)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hex(fill)}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}

function textBox(id, content, left, top, width, height, opts = {}) {
  const paras = wrap(String(content || ""), width, opts.size || 16).map((line, i) => paragraph(line, opts, i === 0));
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(left)}" y="${emu(top)}"/><a:ext cx="${emu(width)}" cy="${emu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle/>${paras.join("")}</p:txBody></p:sp>`;
}

function paragraph(line, opts, first) {
  const size = Math.round((opts.size || 16) * 100);
  const bold = opts.bold ? '<a:b/>' : '';
  return `<a:p><a:pPr marL="0" indent="0"/><a:r><a:rPr lang="id-ID" sz="${size}">${bold}<a:solidFill><a:srgbClr val="${hex(opts.color || "#000000")}"/></a:solidFill><a:latin typeface="Segoe UI"/><a:ea typeface="Segoe UI"/><a:cs typeface="Segoe UI"/></a:rPr><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="id-ID" sz="${size}"/></a:p>`;
}

function wrap(text, widthPt, fontSize) {
  const maxChars = Math.max(12, Math.floor(widthPt / (fontSize * 0.52)));
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 8);
}

function emu(pt) { return Math.round(pt * PT); }
function hex(c) { return String(c || "#000000").replace("#", "").toUpperCase(); }
function escapeXml(s) { return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

// --- PPTX package XML --------------------------------------------------------

function contentTypes(n) {
  const slides = Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides}</Types>`;
}
function rootRels() { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`; }
function presentationXml(n) {
  const ids = Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`;
}
function presentationRels(n) {
  const slides = Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}</Relationships>`;
}
function slideRels() { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`; }
function slideMasterRels() { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`; }
function slideLayoutRels() { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`; }
function slideMasterXml() { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`; }
function slideLayoutXml() { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld></p:sldLayout>`; }
function appXml(n) { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Tantular Deck Studio</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${n}</Slides></Properties>`; }
function coreXml() { const now = new Date().toISOString(); return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Tantular Deck</dc:title><dc:creator>Tantular Deck Studio</dc:creator><cp:lastModifiedBy>Tantular</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`; }
function themeXml(style) { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Tantular"><a:themeElements><a:clrScheme name="Tantular"><a:dk1><a:srgbClr val="${hex(style.bg)}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${hex(style.title)}"/></a:dk2><a:lt2><a:srgbClr val="${hex(style.panel)}"/></a:lt2><a:accent1><a:srgbClr val="${hex(style.accent)}"/></a:accent1><a:accent2><a:srgbClr val="${hex(style.accent2)}"/></a:accent2><a:accent3><a:srgbClr val="${hex(style.panelAlt)}"/></a:accent3><a:accent4><a:srgbClr val="${hex(style.muted)}"/></a:accent4><a:accent5><a:srgbClr val="${hex(style.text)}"/></a:accent5><a:accent6><a:srgbClr val="${hex(style.onAccent)}"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Tantular"><a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Tantular"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`; }

// --- ZIP store ---------------------------------------------------------------
function zipBase64(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = utf8(name), data = utf8(text), crc = crc32(data);
    const local = concat(u32sig(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data);
    parts.push(local);
    central.push(concat(u32sig(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes));
    offset += local.length;
  }
  const centralStart = offset;
  const centralBlob = concat(...central);
  const end = concat(u32sig(0x06054b50), u16(0), u16(0), u16(files.size), u16(files.size), u32(centralBlob.length), u32(centralStart), u16(0));
  const zip = concat(...parts, centralBlob, end);
  return bytesToBase64(zip);
}
function utf8(s) { return new TextEncoder().encode(s); }
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function u32sig(n) { return u32(n); }
function concat(...arrays) { const len = arrays.reduce((a,b)=>a+b.length,0); const out = new Uint8Array(len); let o=0; for (const a of arrays) { out.set(a,o); o+=a.length; } return out; }
function bytesToBase64(bytes) { let bin=""; const chunk=0x8000; for (let i=0;i<bytes.length;i+=chunk) bin += String.fromCharCode(...bytes.subarray(i,i+chunk)); return btoa(bin); }
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; t[i]=c>>>0;} return t; })();
function crc32(bytes) { let c=0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

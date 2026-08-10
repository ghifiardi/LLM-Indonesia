import test from "node:test";
import assert from "node:assert/strict";
import { styleOptions, getStyle } from "../src/deck/deckStyles.js";
import { buildDeckPptxBase64, fitText } from "../src/deck/pptxBuilder.js";

const REQUIRED = ["id", "name", "background", "motif", "palette", "type_scale", "chrome"];
const SPEC = {
  title: "Deck Uji",
  subtitle: "Sub",
  slides: [
    { type: "title", headline: "Judul", subhead: "Sub" },
    { type: "agenda", headline: "Agenda", bullets: ["Satu", "Dua"] },
    { type: "bullets", headline: "Isi", bullets: ["A", "B", "C"] },
    { type: "cards", headline: "Kartu", cards: [{ title: "T1", desc: "D1" }, { title: "T2", desc: "D2" }] },
    { type: "columns", headline: "Perbandingan", columns: [
      { title: "Kolom 1", points: ["Poin A", "Poin B"] },
      { title: "Kolom 2", points: ["Poin C"] }
    ] },
    { type: "metrics", headline: "Angka", metrics: [{ value: "10%", label: "Naik" }] },
    { type: "quote", headline: "", bullets: [], quote: "Kutipan penting." },
    { type: "visualization", headline: "Visualisasi Data", chartType: "bar",
      data: [{ label: "Q1", value: 10 }, { label: "Q2", value: 25 }, { label: "Q3", value: 15 }],
      bullets: ["Kenaikan di Q2."] },
    { type: "closing", headline: "Penutup", bullets: ["Next"] }
  ]
};

// Fixed content used for the geometry-stability regression check below: same
// slide content, rendered under every named pack, must place every text box
// at byte-identical coordinates. Only the look (fills/colors/motif) may vary.
const GEOMETRY_SPEC_BY_TYPE = {
  bullets: {
    title: "Geometri",
    subtitle: "",
    slides: [{ type: "bullets", headline: "Isi Stabil", subhead: "Sub stabil", bullets: ["A", "B", "C", "D"] }]
  },
  cards: {
    title: "Geometri",
    subtitle: "",
    slides: [{ type: "cards", headline: "Kartu Stabil", cards: [
      { title: "T1", desc: "D1" }, { title: "T2", desc: "D2" }, { title: "T3", desc: "D3" }
    ] }]
  }
};

function namedPacks() {
  return styleOptions().filter((p) => p.id !== "custom_freeform");
}

// Extracts <a:off .../> and <a:ext .../> pairs belonging to text boxes only
// (p:sp blocks whose cNvSpPr carries txBox="1"), in document order.
function extractTextBoxGeometry(slideXml) {
  const spBlocks = slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const geometry = [];
  for (const block of spBlocks) {
    if (!block.includes('txBox="1"')) continue;
    const off = block.match(/<a:off[^/]*\/>/);
    const ext = block.match(/<a:ext[^/]*\/>/);
    if (off) geometry.push(off[0]);
    if (ext) geometry.push(ext[0]);
  }
  return geometry;
}

function firstSlideXml(b64) {
  const zipText = Buffer.from(b64, "base64").toString("latin1");
  const marker = "ppt/slides/slide1.xml";
  const idx = zipText.indexOf(marker);
  assert.ok(idx >= 0, "slide1.xml not found in package");
  const xmlStart = zipText.indexOf("<?xml", idx);
  const xmlEnd = zipText.indexOf("</p:sld>", xmlStart) + "</p:sld>".length;
  return zipText.slice(xmlStart, xmlEnd);
}

test("every pack carries the complete token set", () => {
  const packs = namedPacks();
  assert.ok(packs.length >= 5 && packs.length <= 6);
  for (const p of styleOptions()) for (const k of REQUIRED) assert.ok(k in p, `${p.id} missing ${k}`);
});

test("styleOptions includes Bebas / custom (custom_freeform) alongside the named packs", () => {
  const all = styleOptions();
  const custom = all.find((p) => p.id === "custom_freeform");
  assert.ok(custom, "custom_freeform missing from styleOptions()");
  assert.equal(custom.name, "Bebas / custom");
  assert.equal(all.length, namedPacks().length + 1);
});

test("every slide type renders under every pack without throwing, XML references pack accent", () => {
  for (const p of styleOptions()) {
    const b64 = buildDeckPptxBase64(SPEC, p.id);
    assert.ok(b64.length > 1000);
    const raw = Buffer.from(b64, "base64").toString("latin1");
    const accentHex = p.palette.accent.replace("#", "").toUpperCase();
    assert.ok(raw.includes(accentHex), `${p.id} accent not in output`);
  }
});

test("columns and visualization slide types render under every pack without throwing, XML references pack accent", () => {
  const columnsSpec = {
    title: "Kolom", subtitle: "",
    slides: [{ type: "columns", headline: "Perbandingan", columns: [
      { title: "Kolom 1", points: ["Poin A", "Poin B"] },
      { title: "Kolom 2", points: ["Poin C", "Poin D"] },
      { title: "Kolom 3", points: ["Poin E"] }
    ] }]
  };
  const visualizationSpec = {
    title: "Visualisasi", subtitle: "",
    slides: [{ type: "visualization", headline: "Visualisasi Data", chartType: "bar",
      data: [{ label: "Q1", value: 10 }, { label: "Q2", value: 25 }, { label: "Q3", value: 15 }, { label: "Q4", value: 5 }],
      bullets: ["Insight satu.", "Insight dua."] }]
  };
  for (const p of styleOptions()) {
    for (const spec of [columnsSpec, visualizationSpec]) {
      const b64 = buildDeckPptxBase64(spec, p.id);
      assert.ok(b64.length > 1000);
      const raw = Buffer.from(b64, "base64").toString("latin1");
      const accentHex = p.palette.accent.replace("#", "").toUpperCase();
      assert.ok(raw.includes(accentHex), `${p.id} accent not in output for ${spec.slides[0].type}`);
    }
  }
});

test("packs are visually distinct: no two named packs share background kind + accent", () => {
  const seen = new Set();
  for (const p of namedPacks()) {
    const key = `${p.background.kind}:${p.palette.accent}`;
    assert.ok(!seen.has(key), `duplicate look ${key}`);
    seen.add(key);
  }
});

test("fitText shrinks then truncates deterministically", () => {
  const short = fitText("Singkat", { maxChars: 40, baseSize: 28, minSize: 18 });
  assert.deepEqual(short, { text: "Singkat", size: 28 });
  const long = fitText("x".repeat(400), { maxChars: 60, baseSize: 28, minSize: 18 });
  assert.equal(long.size, 18);
  assert.ok(long.text.endsWith("…") && long.text.length <= 61);
});

test("overflow never breaks XML: 400-char headline + 20 bullets renders valid zip under every pack", () => {
  const abuse = {
    ...SPEC,
    slides: [{
      type: "bullets",
      headline: "H".repeat(400),
      bullets: Array.from({ length: 20 }, (_, i) => `Butir panjang sekali nomor ${i} `.repeat(6))
    }]
  };
  for (const p of styleOptions()) {
    const b64 = buildDeckPptxBase64(abuse, p.id);
    assert.ok(b64.length > 1000);
  }
});

test("geometry stability: text box positions/sizes are byte-identical across every named pack (bullets, cards)", () => {
  for (const [type, spec] of Object.entries(GEOMETRY_SPEC_BY_TYPE)) {
    let reference = null;
    for (const p of namedPacks()) {
      const b64 = buildDeckPptxBase64(spec, p.id);
      const slideXml = firstSlideXml(b64);
      const geometry = extractTextBoxGeometry(slideXml);
      assert.ok(geometry.length > 0, `${type}/${p.id} produced no text box geometry`);
      if (!reference) {
        reference = geometry;
      } else {
        assert.deepEqual(geometry, reference, `${type}/${p.id} text box geometry diverges from other packs`);
      }
    }
  }
});

test("custom_freeform ('Bebas / custom') infers a dark background from 'dark' in project instructions", () => {
  const style = getStyle("custom_freeform", "Kami ingin tema dark untuk acara ini.");
  assert.equal(style.bg, "#0B1020");
  assert.equal(style.accent, "#24BDAD");
});

test("custom_freeform ('Bebas / custom') adopts two explicit hex colors from project instructions", () => {
  const style = getStyle("custom_freeform", "Brand kami memakai #112233 dan #445566.");
  assert.equal(style.accent, "#112233");
  assert.equal(style.accent2, "#445566");
  assert.deepEqual(style.projectPalette, ["#112233", "#445566"]);
});

test("custom_freeform renders a valid deck and keeps honoring explicit-hex overrides end to end", () => {
  const b64 = buildDeckPptxBase64(SPEC, "custom_freeform", "Brand kami memakai #112233 dan #445566.");
  assert.ok(b64.length > 1000);
  const raw = Buffer.from(b64, "base64").toString("latin1");
  assert.ok(raw.includes("112233"));
  assert.ok(raw.includes("445566"));
});

// In-place slide text edit: write improved text into the slide's EXISTING
// shapes so the deck's master, colours and footer are untouched. The improved
// content is mapped onto the slide's real structure (title + one body, or
// title + N column bodies with optional headings). Anything that does not map
// cleanly is a refusal, not a guess — a wrong shape rewritten is damage with
// no undo, and a stale heading left beside new text is a wrong slide.
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeSlideStructure,
  planInPlaceWrites,
  readSlideShapeTexts,
  writeSlideShapeTexts
} from "../src/officeClient.js";

const ONE_BODY = [
  { name: "Title 1", text: "How to Read This Case" },
  { name: "Content Placeholder 2", text: "Read it twice\nCite the exhibit" },
  { name: "Footer Placeholder 3", text: "Deck · 3/8" }
];
// The live slide from 2026-09-03: title, two column headings, two column bodies, a footer text box.
const TWO_COLUMNS = [
  { name: "Title 1", text: "How to Read This Case" },
  { name: "TextBox 2", text: "Read it twice" },
  { name: "TextBox 3", text: "First pass for the story: who did what, and when.\nSecond pass with Exhibit 4 open.\nCite the exhibit you rely on." },
  { name: "TextBox 4", text: "Work with the gap" },
  { name: "TextBox 5", text: "The case is built from public sources.\nSeveral figures have never been published.\nNaming a missing number scores higher than inventing one." },
  { name: "TextBox 6", text: "Sahabat-AI: Giving the Weights Away · MBAS6305 Assignment Brief" }
];
const bullets = { type: "bullets", headline: "How to Read This Case", bullets: ["Read it twice.", "Cite the exhibit you rely on."] };
const columns = {
  type: "columns", headline: "How to Read This Case",
  columns: [
    { title: "Read it twice", points: ["First pass: who did what, and when.", "Second pass with Exhibit 4 open."] },
    { title: "", points: ["Built from public sources; deliberately incomplete.", "Name the missing number instead of inventing one."] }
  ]
};

test("describeSlideStructure counts bodies and headings, ignoring the title and chrome", () => {
  assert.deepEqual(describeSlideStructure(ONE_BODY), { title: "How to Read This Case", bodies: 1, headings: [], blocks: [["Read it twice", "Cite the exhibit"]] });
  assert.deepEqual(describeSlideStructure(TWO_COLUMNS), {
    title: "How to Read This Case",
    bodies: 2,
    headings: ["Read it twice", "Work with the gap"],
    blocks: [
      ["First pass for the story: who did what, and when.", "Second pass with Exhibit 4 open.", "Cite the exhibit you rely on."],
      ["The case is built from public sources.", "Several figures have never been published.", "Naming a missing number scores higher than inventing one."]
    ]
  });
  assert.deepEqual(describeSlideStructure([]), { title: "", bodies: 0, headings: [], blocks: [] });
});

test("title + one body: bullets are written into the body, headline into the title, footer untouched", () => {
  assert.deepEqual(planInPlaceWrites(ONE_BODY, bullets), [
    { index: 0, text: "How to Read This Case" },
    { index: 1, text: "Read it twice.\nCite the exhibit you rely on." }
  ]);
});

test("title + one body: a columns/cards result is flattened into that one body", () => {
  const flat = planInPlaceWrites(ONE_BODY, columns);
  assert.equal(flat.length, 2);
  assert.equal(flat[1].text, [
    "Read it twice", "First pass: who did what, and when.", "Second pass with Exhibit 4 open.",
    "Built from public sources; deliberately incomplete.", "Name the missing number instead of inventing one."
  ].join("\n"));
  const cards = planInPlaceWrites(ONE_BODY, { type: "cards", headline: "H", cards: [{ title: "A", desc: "a" }, { title: "B" }] });
  assert.equal(cards[1].text, "A: a\nB");
});

test("two-column slide + two-column result: each column lands in its own body; an empty title keeps the existing heading", () => {
  assert.deepEqual(planInPlaceWrites(TWO_COLUMNS, columns), [
    { index: 0, text: "How to Read This Case" },
    { index: 1, text: "Read it twice" },
    { index: 2, text: "First pass: who did what, and when.\nSecond pass with Exhibit 4 open." },
    { index: 4, text: "Built from public sources; deliberately incomplete.\nName the missing number instead of inventing one." }
  ]);
});

test("a result that does not fit the slide's structure is refused, never squeezed into one shape", () => {
  // bullets onto a two-column slide would leave one column stale
  assert.equal(planInPlaceWrites(TWO_COLUMNS, bullets), null);
  // three columns onto a two-column slide
  assert.equal(planInPlaceWrites(TWO_COLUMNS, { ...columns, columns: [...columns.columns, { title: "C", points: ["c"] }] }), null);
  // nothing to write into
  assert.equal(planInPlaceWrites([{ name: "Title 1", text: "Judul" }], bullets), null);
  assert.equal(planInPlaceWrites([], bullets), null);
  assert.equal(planInPlaceWrites(ONE_BODY, { type: "visualization", headline: "x", data: [{ label: "a", value: 1 }] }), null);
});

function installMock(slides) {
  const built = slides.map((s) => ({
    id: s.id, load() {},
    shapes: { load() {}, items: s.shapes.map((sh) => ({ name: sh.name, left: sh.left, top: sh.top, width: sh.width, height: sh.height, load() {}, textFrame: { textRange: { text: sh.text, load() {} } } })) }
  }));
  const previous = globalThis.PowerPoint;
  globalThis.PowerPoint = { run: async (fn) => fn({ presentation: { slides: { load() {}, items: built } }, sync: async () => {} }) };
  return { built, restore() { globalThis.PowerPoint = previous; } };
}

test("readSlideShapeTexts returns the target slide's shapes in order, by id or by index", async () => {
  const mock = installMock([{ id: "257#b", shapes: ONE_BODY }, { id: "258#c", shapes: TWO_COLUMNS }]);
  try {
    const byId = await readSlideShapeTexts({ slideId: "258", slideIndex: 1 });
    assert.deepEqual(byId.shapes.map((s) => s.name), TWO_COLUMNS.map((s) => s.name));
    assert.equal(byId.found, true);
    const gone = await readSlideShapeTexts({ slideId: "999" });
    assert.equal(gone.found, false);
  } finally { mock.restore(); }
});

test("writeSlideShapeTexts writes exactly the planned shapes and nothing else", async () => {
  const mock = installMock([{ id: "257#b", shapes: ONE_BODY }, { id: "258#c", shapes: TWO_COLUMNS }]);
  try {
    const outcome = await writeSlideShapeTexts({ slideId: "258" }, planInPlaceWrites(TWO_COLUMNS, columns));
    assert.deepEqual(outcome, { updated: true });
    const t = mock.built[1].shapes.items.map((s) => s.textFrame.textRange.text);
    assert.equal(t[1], "Read it twice");
    assert.equal(t[2], "First pass: who did what, and when.\nSecond pass with Exhibit 4 open.");
    assert.equal(t[3], "Work with the gap", "heading kept when the result had no title");
    assert.equal(t[5], TWO_COLUMNS[5].text, "footer untouched");
    assert.equal(mock.built[0].shapes.items[1].textFrame.textRange.text, ONE_BODY[1].text, "other slide untouched");
    const gone = await writeSlideShapeTexts({ slideId: "999" }, [{ index: 0, text: "x" }]);
    assert.equal(gone.updated, false);
    assert.match(gone.reason, /tidak ditemukan/);
  } finally { mock.restore(); }
});

// --- Inline headings (live, 2026-09-03) ------------------------------------
// The real slide 3 has each column as ONE shape: paragraph 1 is the heading
// ("Read it twice"), the rest are bullets. Writing the shape's whole text
// erased the heading and gave every line the heading's bold style with no
// bullets. An inline heading must be kept, and only the paragraphs after it
// replaced — through a substring range, so the bullet formatting is inherited.
const INLINE_COLUMNS = [
  { name: "Title 1", text: "How to Read This Case" },
  { name: "TextBox 2", text: "Read it twice\rFirst pass for the story: who did what, and when.\rCite the exhibit you rely on." },
  { name: "TextBox 3", text: "Work with the gap\rThe case is built from public sources.\rNaming a missing number scores higher than inventing one." },
  { name: "TextBox 4", text: "Sahabat-AI: Giving the Weights Away · MBAS6305 Assignment Brief" }
];

test("describeSlideStructure treats a short first paragraph of a multi-line shape as that column's heading", () => {
  assert.deepEqual(describeSlideStructure(INLINE_COLUMNS), {
    title: "How to Read This Case",
    bodies: 2,
    headings: ["Read it twice", "Work with the gap"],
    blocks: [
      ["First pass for the story: who did what, and when.", "Cite the exhibit you rely on."],
      ["The case is built from public sources.", "Naming a missing number scores higher than inventing one."]
    ]
  });
  // A first paragraph that reads as a sentence is a bullet, not a heading.
  assert.deepEqual(describeSlideStructure([
    { name: "Title 1", text: "T" },
    { name: "Content 2", text: "Read it twice.\nCite the exhibit." }
  ]).headings, []);
});

test("planInPlaceWrites keeps an inline heading and replaces only the paragraphs after it", () => {
  assert.deepEqual(planInPlaceWrites(INLINE_COLUMNS, columns), [
    { index: 0, text: "How to Read This Case" },
    { index: 1, text: "First pass: who did what, and when.\nSecond pass with Exhibit 4 open.", afterFirstParagraph: true },
    { index: 2, text: "Built from public sources; deliberately incomplete.\nName the missing number instead of inventing one.", afterFirstParagraph: true }
  ]);
});

function installSubstringMock(slides) {
  const built = slides.map((s) => ({
    id: s.id, load() {},
    shapes: { load() {}, items: s.shapes.map((sh) => {
      const range = { text: sh.text, load() {} };
      range.getSubstring = (start, length) => ({
        load() {},
        set text(value) { range.text = range.text.slice(0, start) + value + range.text.slice(start + length); }
      });
      return { name: sh.name, load() {}, textFrame: { textRange: range } };
    }) }
  }));
  const previous = globalThis.PowerPoint;
  globalThis.PowerPoint = { run: async (fn) => fn({ presentation: { slides: { load() {}, items: built } }, sync: async () => {} }) };
  return { built, restore() { globalThis.PowerPoint = previous; } };
}

test("writeSlideShapeTexts replaces the substring after the first paragraph, leaving the heading paragraph untouched", async () => {
  const mock = installSubstringMock([{ id: "258#c", shapes: INLINE_COLUMNS }]);
  try {
    const outcome = await writeSlideShapeTexts({ slideId: "258" }, planInPlaceWrites(INLINE_COLUMNS, columns));
    assert.deepEqual(outcome, { updated: true });
    const t = mock.built[0].shapes.items.map((s) => s.textFrame.textRange.text);
    assert.equal(t[1], "Read it twice\rFirst pass: who did what, and when.\nSecond pass with Exhibit 4 open.");
    assert.equal(t[2], "Work with the gap\rBuilt from public sources; deliberately incomplete.\nName the missing number instead of inventing one.");
    assert.equal(t[3], INLINE_COLUMNS[3].text);
  } finally { mock.restore(); }
});

test("without getSubstring the heading paragraph is still kept by re-writing it in front of the new body", async () => {
  const mock = installMock([{ id: "258#c", shapes: INLINE_COLUMNS }]);
  try {
    const outcome = await writeSlideShapeTexts({ slideId: "258" }, planInPlaceWrites(INLINE_COLUMNS, columns));
    assert.deepEqual(outcome, { updated: true });
    const t = mock.built[0].shapes.items[1].textFrame.textRange.text;
    assert.equal(t, "Read it twice\nFirst pass: who did what, and when.\nSecond pass with Exhibit 4 open.");
  } finally { mock.restore(); }
});

// --- Builder layout: one text box per bullet (live, 2026-09-05) ---------------
// A Deck Studio slide draws every bullet as its own text box. The reader saw
// six "bodies", steered the model to six columns, and the writer refused the
// mismatch. Six same-column boxes under one title are ONE bullets body split
// across slots: steer to bullets, write one bullet per box, clear the rest.
const SPLIT = [
  { name: "Title 1", text: "DATA PENDAFTARAN OBAT", left: 60, top: 60, width: 800, height: 60 },
  { name: "TextBox 2", text: "Pendaftaran Tanggal Penerimaan Kode Evaluasi dd / mm / yyyy A.", left: 90, top: 160, width: 760, height: 40 },
  { name: "TextBox 3", text: "URAIAN OBAT #) Kategori registrasi Jenis obat *) Baru Generik Produk Biologi", left: 90, top: 210, width: 760, height: 40 },
  { name: "TextBox 4", text: "KETERANGAN LENGKAP PENDAFTAR #) Nama Pendaftar Alamat Pendaftar", left: 90, top: 260, width: 760, height: 40 },
  { name: "TextBox 5", text: "STATUS PRODUKSI #) Status Produksi *) Produksi dalam negeri", left: 90, top: 310, width: 760, height: 40 },
  { name: "TextBox 6", text: "Zat Aktif Satuan Dosis **) CAS NO.", left: 90, top: 360, width: 760, height: 40 },
  { name: "TextBox 7", text: "Tantular Deck Studio · 20/30", left: 60, top: 480, width: 300, height: 20 }
];

test("describeSlideStructure reads same-column text boxes under one title as ONE bullets body with slots", () => {
  const s = describeSlideStructure(SPLIT);
  assert.equal(s.bodies, 1);
  assert.deepEqual(s.headings, []);
  assert.equal(s.blocks.length, 1);
  assert.equal(s.blocks[0].length, 5);
  assert.equal(s.slots, 5);
  assert.equal(s.layout, "split_bullets");
  assert.equal(s.deckStudio, true, "the builder footer identifies a Deck Studio slide");
});

test("planInPlaceWrites distributes bullets one per box, joins the overflow into the last box, and clears unused boxes", () => {
  const five = { type: "bullets", headline: "Data Pendaftaran Obat", bullets: ["a", "b", "c", "d", "e"] };
  const w5 = planInPlaceWrites(SPLIT, five);
  assert.deepEqual(w5.map((w) => [w.index, w.text]), [[0, "Data Pendaftaran Obat"], [1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]]);
  const seven = { ...five, bullets: ["a", "b", "c", "d", "e", "f", "g"] };
  assert.equal(planInPlaceWrites(SPLIT, seven).at(-1).text, "e\nf\ng");
  const three = { ...five, bullets: ["a", "b", "c"] };
  const w3 = planInPlaceWrites(SPLIT, three);
  assert.deepEqual(w3.filter((w) => w.clear).map((w) => w.index), [4, 5]);
  assert.ok(w3.every((w) => w.index !== 6), "the footer box is never touched");
  // a columns/cards result is flattened into the slots, never refused
  const cols = { type: "columns", headline: "H", columns: [{ title: "A", points: ["1", "2"] }, { title: "B", points: ["3"] }] };
  assert.deepEqual(planInPlaceWrites(SPLIT, cols).filter((w) => !w.clear && w.index > 0).map((w) => w.text), ["A", "1", "2", "B", "3"]);
});

test("writeSlideShapeTexts clears a box when the plan says so", async () => {
  const mock = installMock([{ id: "300#x", shapes: SPLIT }]);
  try {
    const outcome = await writeSlideShapeTexts({ slideId: "300" }, [{ index: 1, text: "baru" }, { index: 5, text: "", clear: true }]);
    assert.deepEqual(outcome, { updated: true });
    const t = mock.built[0].shapes.items.map((s) => s.textFrame.textRange.text);
    assert.equal(t[1], "baru");
    assert.equal(t[5], "");
    assert.equal(t[6], SPLIT[6].text);
  } finally { mock.restore(); }
});

// Live (2026-09-05, host31): the in-place path reads shapes with
// readSlideShapeTexts, which returned name and text only. Without geometry the
// same-left-edge rule can never match, the builder slide read as five bodies,
// and the model was steered to columns. The reader must supply geometry.
test("readSlideShapeTexts returns geometry, so the split-bullet layout is recognised on the live path", async () => {
  const mock = installMock([{ id: "300#x", shapes: SPLIT }]);
  try {
    const read = await readSlideShapeTexts({ slideId: "300" });
    assert.equal(read.shapes[1].left, 90);
    assert.equal(read.shapes[1].width, 760);
    const s = describeSlideStructure(read.shapes);
    assert.equal(s.layout, "split_bullets");
    assert.equal(s.slots, 5);
  } finally { mock.restore(); }
});

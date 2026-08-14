import test from "node:test";
import assert from "node:assert/strict";
import { extractPptxSlides, extractRequestedSlideIndex, sanitizePptActions, TYPE_RULES, orderPptActions, resolveDeleteTarget, deckContextToPromptText, buildDeckSlidesFromExtractor } from "../src/chat/pptTools.js";
import { SLIDE_TYPES } from "../src/deck/deckPlanner.js";

test("extractRequestedSlideIndex finds slide numbers in Indonesian and English", () => {
  assert.equal(extractRequestedSlideIndex("perbaiki slide 4"), 4);
  assert.equal(extractRequestedSlideIndex("halaman 12 terlalu panjang"), 12);
  assert.equal(extractRequestedSlideIndex("improve slide #7"), 7);
  assert.equal(extractRequestedSlideIndex("lihat #3"), 3);
  assert.equal(extractRequestedSlideIndex("tidak ada angka"), 0);
  assert.equal(extractRequestedSlideIndex("slide 0"), 0);
  assert.equal(extractRequestedSlideIndex(""), 0);
  assert.equal(extractRequestedSlideIndex(null), 0);
});

test("extractPptxSlides parses labelled extractor output", () => {
  const text = [
    "[Slide 1 | id 257]",
    "Judul Deck",
    "Subjudul",
    "[Slide 2 | id 258]",
    "Agenda",
    ""
  ].join("\n");
  const slides = extractPptxSlides(text);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].index, "1");
  assert.equal(slides[0].id, "257");
  assert.equal(slides[0].text, "Judul Deck\nSubjudul");
  assert.equal(slides[1].label, "Slide 2 | id 258");
  assert.equal(slides[1].text, "Agenda");
});

test("extractPptxSlides tolerates missing ids and returns empty for junk", () => {
  const slides = extractPptxSlides("[Slide 1]\nHanya teks");
  assert.equal(slides.length, 1);
  assert.equal(slides[0].id, "");
  assert.deepEqual(extractPptxSlides("tidak ada label slide"), []);
});

const bulletsSlide = { type: "bullets", headline: "Judul", bullets: ["satu", "dua"] };

test("sanitize accepts one valid action of every op", () => {
  const { actions, rejected } = sanitizePptActions([
    { op: "improve_slide", slideIndex: 4 },
    { op: "replace_slide", slideIndex: 3, slide: bulletsSlide },
    { op: "add_slide", afterIndex: 5, slide: bulletsSlide },
    { op: "delete_slide", slideIndex: 7 }
  ], 10);
  assert.equal(rejected.length, 0);
  assert.equal(actions.length, 4);
  assert.deepEqual(actions.map((a) => a.op),
    ["improve_slide", "replace_slide", "add_slide", "delete_slide"]);
});

test("sanitize rejects unknown ops and out-of-range indexes", () => {
  const { actions, rejected } = sanitizePptActions([
    { op: "reorder_slide", slideIndex: 2 },
    { op: "improve_slide", slideIndex: 0 },
    { op: "improve_slide", slideIndex: 11 },
    { op: "improve_slide", slideIndex: "3" },
    { op: "improve_slide", slideIndex: 3.5 }
  ], 10);
  assert.equal(actions.length, 0);
  assert.equal(rejected.length, 5);
  assert.match(rejected[0], /reorder_slide/);
});

test("sanitize rejects afterIndex 0 with the front-insert message", () => {
  const { actions, rejected } = sanitizePptActions(
    [{ op: "add_slide", afterIndex: 0, slide: bulletsSlide }], 10);
  assert.equal(actions.length, 0);
  assert.match(rejected[0], /paling depan belum didukung/);
});

test("sanitize caps a turn at 8 actions", () => {
  const raw = Array.from({ length: 9 }, (_, i) => ({ op: "improve_slide", slideIndex: i + 1 }));
  const { actions, rejected } = sanitizePptActions(raw, 20);
  assert.equal(actions.length, 8);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /maksimum 8/i);
});

test("sanitize strips unknown slide fields", () => {
  const { actions } = sanitizePptActions([{
    op: "add_slide",
    afterIndex: 1,
    slide: { ...bulletsSlide, animation: "fade", notes: "rahasia" }
  }], 10);
  assert.deepEqual(Object.keys(actions[0].slide).sort(), ["bullets", "headline", "type"]);
});

test("sanitize tolerates non-array input", () => {
  assert.deepEqual(sanitizePptActions(null, 10), { actions: [], rejected: [] });
  assert.deepEqual(sanitizePptActions("bukan array", 10), { actions: [], rejected: [] });
});

function addSlide(slide) {
  return sanitizePptActions([{ op: "add_slide", afterIndex: 1, slide }], 10);
}

test("quote slides need quote or headline, not both", () => {
  assert.equal(addSlide({ type: "quote", quote: "Kutipan penting" }).actions.length, 1);
  assert.equal(addSlide({ type: "quote", headline: "Judul saja" }).actions.length, 1);
  const empty = addSlide({ type: "quote", subhead: "Nama" });
  assert.equal(empty.actions.length, 0);
  assert.match(empty.rejected[0], /quote|headline/);
});

test("non-quote slides require a headline", () => {
  const missing = addSlide({ type: "bullets", bullets: ["satu"] });
  assert.equal(missing.actions.length, 0);
  assert.match(missing.rejected[0], /headline/);
});

test("each content type requires its own non-empty array", () => {
  assert.equal(addSlide({ type: "bullets", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "agenda", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "cards", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "columns", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "metrics", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "visualization", headline: "H" }).actions.length, 0);
});

test("title and closing need only a headline", () => {
  assert.equal(addSlide({ type: "title", headline: "Judul", subhead: "Sub" }).actions.length, 1);
  assert.equal(addSlide({ type: "closing", headline: "Terima kasih" }).actions.length, 1);
});

test("metrics and visualization keep their builder fields", () => {
  const metrics = addSlide({
    type: "metrics", headline: "Angka",
    metrics: [{ value: "92%", label: "Akurasi" }, { value: "3x", label: "Lebih cepat" }]
  });
  assert.deepEqual(metrics.actions[0].slide.metrics,
    [{ value: "92%", label: "Akurasi" }, { value: "3x", label: "Lebih cepat" }]);

  const viz = addSlide({
    type: "visualization", headline: "Tren", chartType: "bar",
    data: [{ label: "Q1", value: 10 }, { label: "Q2", value: 20 }],
    bullets: ["naik dua kali lipat"]
  });
  assert.equal(viz.actions[0].slide.chartType, "bar");
  assert.deepEqual(viz.actions[0].slide.data, [{ label: "Q1", value: 10 }, { label: "Q2", value: 20 }]);
  assert.deepEqual(viz.actions[0].slide.bullets, ["naik dua kali lipat"]);
});

test("cards and columns keep their nested shapes", () => {
  const cards = addSlide({
    type: "cards", headline: "Fitur",
    cards: [{ title: "Cepat", desc: "Lokal" }, { title: "Privat" }]
  });
  assert.deepEqual(cards.actions[0].slide.cards, [{ title: "Cepat", desc: "Lokal" }, { title: "Privat" }]);

  const columns = addSlide({
    type: "columns", headline: "Banding",
    columns: [{ title: "Sebelum", points: ["a", "b"] }, { title: "Sesudah", points: ["c"] }]
  });
  assert.equal(columns.actions[0].slide.columns.length, 2);
  assert.deepEqual(columns.actions[0].slide.columns[0].points, ["a", "b"]);
});

test("invalid nested entries are dropped, siblings survive", () => {
  const cards = addSlide({
    type: "cards", headline: "Fitur",
    cards: [{ desc: "tanpa judul" }, { title: "Valid", desc: "ok" }]
  });
  assert.deepEqual(cards.actions[0].slide.cards, [{ title: "Valid", desc: "ok" }]);
});

test("dropping every nested entry rejects the slide", () => {
  const cards = addSlide({ type: "cards", headline: "Fitur", cards: [{ desc: "x" }, { desc: "y" }] });
  assert.equal(cards.actions.length, 0);
  assert.match(cards.rejected[0], /cards/);

  const metrics = addSlide({ type: "metrics", headline: "M", metrics: [{ label: "tanpa nilai" }] });
  assert.equal(metrics.actions.length, 0);
});

test("TYPE_RULES stays in sync with SLIDE_TYPES", () => {
  const ruleKeys = Object.keys(TYPE_RULES).sort();
  const slideTypes = [...SLIDE_TYPES].sort();
  assert.deepEqual(ruleKeys, slideTypes,
    `TYPE_RULES keys and SLIDE_TYPES have drifted: TYPE_RULES has ${JSON.stringify(ruleKeys)}, ` +
    `SLIDE_TYPES has ${JSON.stringify(slideTypes)}`);
});

const slideFor = (name) => ({ type: "bullets", headline: name, bullets: ["x"] });

test("replaces and deletes run descending by slideIndex", () => {
  const ordered = orderPptActions([
    { op: "replace_slide", slideIndex: 2, slide: slideFor("A") },
    { op: "delete_slide", slideIndex: 9 },
    { op: "improve_slide", slideIndex: 5 }
  ]);
  assert.deepEqual(ordered.map((a) => a.slideIndex), [9, 5, 2]);
});

test("two same-anchor inserts land in model order in the final deck", () => {
  const ordered = orderPptActions([
    { op: "add_slide", afterIndex: 5, slide: slideFor("A") },
    { op: "add_slide", afterIndex: 5, slide: slideFor("B") }
  ]);
  // Each insert lands immediately after slide 5, so executing B then A
  // produces the deck order 5, A, B — which is the model's intent.
  assert.deepEqual(ordered.map((a) => a.slide.headline), ["B", "A"]);
});

test("three same-anchor inserts land in model order in the final deck", () => {
  const ordered = orderPptActions([
    { op: "add_slide", afterIndex: 3, slide: slideFor("A") },
    { op: "add_slide", afterIndex: 3, slide: slideFor("B") },
    { op: "add_slide", afterIndex: 3, slide: slideFor("C") }
  ]);
  assert.deepEqual(ordered.map((a) => a.slide.headline), ["C", "B", "A"]);
});

test("an insert anchored on a replaced slide runs before that replace", () => {
  const ordered = orderPptActions([
    { op: "replace_slide", slideIndex: 5, slide: slideFor("baru") },
    { op: "add_slide", afterIndex: 5, slide: slideFor("tambahan") }
  ]);
  assert.deepEqual(ordered.map((a) => a.op), ["add_slide", "replace_slide"]);
});

test("at equal index the tie-break is add, then replace, then delete", () => {
  const ordered = orderPptActions([
    { op: "delete_slide", slideIndex: 4 },
    { op: "replace_slide", slideIndex: 4, slide: slideFor("R") },
    { op: "add_slide", afterIndex: 4, slide: slideFor("A") }
  ]);
  assert.deepEqual(ordered.map((a) => a.op), ["add_slide", "replace_slide", "delete_slide"]);
});

test("a mixed list produces one deterministic sequence", () => {
  const ordered = orderPptActions([
    { op: "improve_slide", slideIndex: 2 },
    { op: "add_slide", afterIndex: 7, slide: slideFor("A") },
    { op: "delete_slide", slideIndex: 4 },
    { op: "add_slide", afterIndex: 7, slide: slideFor("B") }
  ]);
  assert.deepEqual(
    ordered.map((a) => `${a.op}:${a.slideIndex ?? a.afterIndex}:${a.slide?.headline ?? ""}`),
    ["add_slide:7:B", "add_slide:7:A", "delete_slide:4:", "improve_slide:2:"]
  );
});

test("orderPptActions does not mutate its input", () => {
  const input = [
    { op: "improve_slide", slideIndex: 1 },
    { op: "improve_slide", slideIndex: 9 }
  ];
  orderPptActions(input);
  assert.deepEqual(input.map((a) => a.slideIndex), [1, 9]);
});

test("resolveDeleteTarget prefers id over index", () => {
  const result = resolveDeleteTarget(["257", "258", "259"], { slideIndex: 1, id: "259" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "259");
  assert.equal(result.index, 3);
});

test("resolveDeleteTarget matches ids across API surfaces", () => {
  const result = resolveDeleteTarget(["257#abc", "258#def"], { slideIndex: 2, id: "258" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "258#def");
});

test("resolveDeleteTarget refuses a positional fallback when the id is gone", () => {
  const result = resolveDeleteTarget(["257", "258"], { slideIndex: 2, id: "999", title: "Penutup" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /berubah/i);
});

test("resolveDeleteTarget falls back to index only when no id was captured", () => {
  const result = resolveDeleteTarget(["257", "258", "259"], { slideIndex: 2, id: "" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "258");
});

test("resolveDeleteTarget rejects an index outside the live deck", () => {
  const result = resolveDeleteTarget(["257"], { slideIndex: 4, id: "" });
  assert.equal(result.ok, false);
});

test("resolveDeleteTarget refuses an ambiguous fuzzy id match rather than guessing which slide to delete", () => {
  const result = resolveDeleteTarget(["257#a", "257#b"], { slideIndex: 1, id: "257" });
  assert.equal(result.ok, false);
});

test("resolveDeleteTarget still resolves a fuzzy id match when only one live slide qualifies", () => {
  const result = resolveDeleteTarget(["257#a", "258#b"], { slideIndex: 1, id: "257" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "257#a");
});

test("resolveDeleteTarget refuses slideIndex 0 on the index-only path instead of deleting an off-by-one slide", () => {
  const result = resolveDeleteTarget(["257", "258"], { slideIndex: 0, id: "" });
  assert.equal(result.ok, false);
});

test("resolveDeleteTarget refuses a non-integer slideIndex on the index-only path instead of rounding onto a live slide", () => {
  const result = resolveDeleteTarget(["257", "258"], { slideIndex: 1.5, id: "" });
  assert.equal(result.ok, false);
});

test("deckContextToPromptText states slide count and the global truncation notice", () => {
  const text = deckContextToPromptText({
    source: "extractor",
    slides: [
      { index: 1, id: "257", title: "Judul", text: "Judul\nSubjudul", truncated: false },
      { index: 2, id: "258", title: "Agenda", text: "Agenda", truncated: false }
    ]
  });
  assert.match(text, /2 slide/);
  assert.match(text, /Konten slide dipotong untuk konteks/);
  assert.match(text, /\[Slide 1 \| id 257\]/);
  assert.match(text, /\[Slide 2 \| id 258\]/);
});

test("deckContextToPromptText marks only the slides it actually cut", () => {
  const long = "x".repeat(900);
  const text = deckContextToPromptText({
    source: "host",
    slides: [
      { index: 1, id: "257", title: "Pendek", text: "singkat", truncated: false },
      { index: 2, id: "258", title: "Panjang", text: long, truncated: false }
    ]
  });
  const [first, second] = text.split("[Slide 2");
  assert.equal(/\[dipotong\]/.test(first), false);
  assert.match(second, /\[dipotong\]/);
});

test("deckContextToPromptText respects the total ceiling", () => {
  const slides = Array.from({ length: 60 }, (_, i) => ({
    index: i + 1, id: String(257 + i), title: `Slide ${i + 1}`,
    text: "y".repeat(500), truncated: false
  }));
  const text = deckContextToPromptText({ source: "extractor", slides });
  assert.ok(text.length < 11000, `snapshot too long: ${text.length}`);
  assert.match(text, /60 slide/);
});

test("buildDeckSlidesFromExtractor turns labelled text into snapshot slides", () => {
  const slides = buildDeckSlidesFromExtractor([
    "[Slide 1 | id 257]",
    "Judul Deck",
    "Baris kedua",
    "[Slide 2 | id 258]",
    "Agenda",
    ""
  ].join("\n"));
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0], {
    index: 1, id: "257", title: "Judul Deck", text: "Judul Deck\nBaris kedua", truncated: false
  });
  assert.equal(slides[1].title, "Agenda");
});

test("buildDeckSlidesFromExtractor titles an empty slide honestly", () => {
  const slides = buildDeckSlidesFromExtractor("[Slide 1 | id 257]\n\n");
  assert.equal(slides[0].title, "(tanpa teks)");
  assert.equal(slides[0].text, "");
});

import test from "node:test";
import assert from "node:assert/strict";
import { extractPptxSlides, extractRequestedSlideIndex, sanitizePptActions } from "../src/chat/pptTools.js";

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

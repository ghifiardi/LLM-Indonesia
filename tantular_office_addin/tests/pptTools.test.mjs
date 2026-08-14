import test from "node:test";
import assert from "node:assert/strict";
import { extractPptxSlides, extractRequestedSlideIndex, sanitizePptActions, TYPE_RULES, orderPptActions, resolveDeleteTarget, deckContextToPromptText, buildDeckSlidesFromExtractor, deckReadErrorMessage, resolveActionTarget, snapshotIndexSpace, abortReportLine, improveResultNote, SNAPSHOT_CEILING_CHARS } from "../src/chat/pptTools.js";
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

test("deckReadErrorMessage forwards an actionable error message", () => {
  const error = new Error("Document extractor belum berjalan. Jalankan di terminal: npm run doc-server");
  assert.equal(
    deckReadErrorMessage(error),
    "Document extractor belum berjalan. Jalankan di terminal: npm run doc-server"
  );
});

test("deckReadErrorMessage falls back to the generic message for an empty error message", () => {
  const error = new Error("");
  assert.equal(
    deckReadErrorMessage(error),
    "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan, " +
    "lalu klik Muat ulang deck."
  );
});

test("deckReadErrorMessage falls back to the generic message for null/undefined", () => {
  const generic =
    "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan, " +
    "lalu klik Muat ulang deck.";
  assert.equal(deckReadErrorMessage(null), generic);
  assert.equal(deckReadErrorMessage(undefined), generic);
});

test("deckReadErrorMessage falls back to the generic message for a non-Error thrown value", () => {
  const generic =
    "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan, " +
    "lalu klik Muat ulang deck.";
  assert.equal(deckReadErrorMessage("some string thrown"), generic);
  assert.equal(deckReadErrorMessage({ code: "ENOENT" }), generic);
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
  assert.match(text, /\[Slide 1 \| id 257 \| Judul\]/);
  assert.match(text, /\[Slide 2 \| id 258 \| Agenda\]/);
});

test("deckContextToPromptText says the count is of READABLE slides, not deck length", () => {
  // Extractor skips image-only slides while its counter keeps advancing: 2
  // entries whose indexes reach 5. The header must not claim the deck has 2.
  const text = deckContextToPromptText({
    source: "extractor",
    slides: [
      { index: 1, id: "257", title: "Judul", text: "Judul", truncated: false },
      { index: 5, id: "261", title: "Penutup", text: "Terima kasih", truncated: false }
    ]
  });
  assert.match(text, /2 slide terbaca/);
  assert.match(text, /tidak muncul di daftar ini/);
  assert.match(text, /\[Slide 5 \| id 261 \| Penutup\]/);
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

test("deckContextToPromptText keeps EVERY slide in a 60-slide deck under the ceiling", () => {
  // The old behavior stopped emitting slides once the budget ran out, so the
  // model could plan a replace_slide on a slide it had never read. Now the
  // per-slide body shrinks instead and no slide is ever dropped.
  const slides = Array.from({ length: 60 }, (_, i) => ({
    index: i + 1, id: String(257 + i), title: `Slide ${i + 1}`,
    text: "y".repeat(500), truncated: false
  }));
  const text = deckContextToPromptText({ source: "extractor", slides });
  assert.ok(text.length <= SNAPSHOT_CEILING_CHARS, `snapshot too long: ${text.length}`);
  assert.match(text, /60 slide/);
  for (const slide of slides) {
    assert.ok(
      text.includes(`[Slide ${slide.index} | id ${slide.id} | Slide ${slide.index}]`),
      `slide ${slide.index} missing from the snapshot`
    );
  }
  // No tail line about omitted slides can exist any more, so it can never print
  // a negative count.
  assert.equal(/tidak ditampilkan karena batas konteks/.test(text), false);
  assert.equal(/-\d+ slide/.test(text), false);
});

test("snapshotIndexSpace uses the snapshot's real deck positions, not its length", () => {
  const space = snapshotIndexSpace({ slides: [{ index: 1 }, { index: 44 }, { index: 60 }] });
  assert.equal(space.has(44), true);
  assert.equal(space.has(2), false);
  assert.equal(space.max, 60);
  const byCount = snapshotIndexSpace(10);
  assert.equal(byCount.has(10), true);
  assert.equal(byCount.has(11), false);
});

const gappySnapshot = {
  source: "extractor",
  slides: [
    { index: 1, id: "257", title: "Judul", text: "a", truncated: false },
    { index: 44, id: "300", title: "Data", text: "b", truncated: false }
  ]
};

test("sanitize accepts a true deck position beyond the snapshot's array length", () => {
  const { actions, rejected } = sanitizePptActions(
    [{ op: "improve_slide", slideIndex: 44 }], gappySnapshot);
  assert.equal(rejected.length, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].slideIndex, 44);
});

test("sanitize rejects an index inside the deck but absent from the snapshot, and says why", () => {
  const { actions, rejected } = sanitizePptActions(
    [{ op: "replace_slide", slideIndex: 12, slide: bulletsSlide }], gappySnapshot);
  assert.equal(actions.length, 0);
  assert.match(rejected[0], /tidak ada di snapshot deck/);
  assert.equal(/di luar jangkauan 1-2\b/.test(rejected[0]), false);
});

test("sanitize still rejects an index beyond the deck entirely", () => {
  const { rejected } = sanitizePptActions(
    [{ op: "improve_slide", slideIndex: 61 }], gappySnapshot);
  assert.match(rejected[0], /di luar jangkauan 1-44/);
});

test("cleanData drops points with a null or non-numeric value instead of charting a fake zero", () => {
  const { actions } = addSlide({
    type: "visualization", headline: "Tren", chartType: "bar",
    data: [
      { label: "Q1", value: 10 },
      { label: "Q2", value: null },
      { label: "Q3" },
      { label: "Q4", value: "tidak ada data" },
      { label: "Q5", value: "" },
      { label: "Q6", value: true },
      { label: "Q7", value: "20" }
    ]
  });
  assert.deepEqual(actions[0].slide.data, [{ label: "Q1", value: 10 }, { label: "Q7", value: 20 }]);
});

test("cleanData rejects the slide when every data point was fabricated", () => {
  const { actions, rejected } = addSlide({
    type: "visualization", headline: "Tren",
    data: [{ label: "Q1", value: null }, { label: "Q2" }]
  });
  assert.equal(actions.length, 0);
  assert.match(rejected[0], /data/);
});

test("abortReportLine names how many actions were skipped", () => {
  assert.match(abortReportLine(3), /3 aksi berikutnya tidak dijalankan/);
  assert.match(abortReportLine(0), /tidak ada aksi lain yang tersisa/);
  assert.match(abortReportLine(undefined), /tidak ada aksi lain yang tersisa/);
});

test("improveResultNote qualifies a fallback and stays silent for a real model result", () => {
  assert.equal(improveResultNote("model-grounded"), "");
  assert.match(improveResultNote("fallback"), /fallback — model lokal tidak menjawab/);
  assert.match(improveResultNote("fallback-grounded"), /fallback/);
  assert.match(improveResultNote(""), /fallback/);
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

const ctx = {
  source: "extractor",
  slides: [
    { index: 1, id: "257", title: "Judul", text: "a", truncated: false },
    { index: 2, id: "258", title: "Agenda", text: "b", truncated: false },
    { index: 3, id: "", title: "Tanpa id", text: "c", truncated: false }
  ]
};

test("resolveActionTarget maps an index to the snapshot id", () => {
  assert.deepEqual(resolveActionTarget(ctx, 2), { id: "258", index: 2, title: "Agenda", text: "b" });
});

test("resolveActionTarget still resolves a slide with no id", () => {
  assert.deepEqual(resolveActionTarget(ctx, 3), { id: "", index: 3, title: "Tanpa id", text: "c" });
});

test("resolveActionTarget returns null outside the snapshot", () => {
  assert.equal(resolveActionTarget(ctx, 0), null);
  assert.equal(resolveActionTarget(ctx, 9), null);
});

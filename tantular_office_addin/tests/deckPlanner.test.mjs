import test from "node:test";
import assert from "node:assert/strict";
import {
  expandSlidesToCount,
  inferRequestedSlideCount,
  isThinContent,
  looksLikePresentationBrief,
  planDeck,
  summarizeDeckSections,
  summarizeSlideBullets,
  improveExistingSlide
} from "../src/deck/deckPlanner.js";

test("long instruction-style deck brief is not mistaken for a title", () => {
  const brief = "Kamu adalah konsultan strategi senior sekaligus desainer keynote ala TED Talk. Buatlah presentasi dua puluh slide untuk audiens non-teknis dan semi-teknis di Indonesia. Tujuannya mengubah mindset tentang sovereign AI.";
  assert.equal(looksLikePresentationBrief(brief), true);
  assert.equal(isThinContent(brief), false);
});

test("plain short title remains thin content", () => {
  assert.equal(isThinContent("Sovereign AI Indonesia"), true);
});

test("infers numeric and Indonesian-word slide counts", () => {
  assert.equal(inferRequestedSlideCount("Buat deck 20 slide untuk direksi."), 20);
  assert.equal(inferRequestedSlideCount("Buatlah presentasi dua puluh slide untuk pemerintah."), 20);
  assert.equal(inferRequestedSlideCount("Susun 35 slide."), 30);
});

test("does not infer counts from unrelated years", () => {
  assert.equal(inferRequestedSlideCount("Roadmap sovereign AI Indonesia dari 2026 sampai 2031."), 0);
});

test("expands dense model output to the requested slide count", () => {
  const slides = [
    { type: "title", headline: "Judul" },
    { type: "agenda", headline: "Agenda", bullets: ["A", "B", "C", "D"] },
    {
      type: "cards",
      headline: "Peran",
      cards: [
        { title: "Pemerintah", desc: "A" },
        { title: "BUMN", desc: "B" },
        { title: "Kampus", desc: "C" },
        { title: "Startup", desc: "D" }
      ]
    },
    { type: "closing", headline: "Penutup", bullets: ["Aksi"] }
  ];
  const expanded = expandSlidesToCount(slides, 8);
  assert.equal(expanded.length, 8);
  assert.equal(expanded[0].type, "title");
  assert.equal(expanded.at(-1).type, "closing");
  assert.equal(expanded.filter((slide) => slide.type === "agenda").length, 1);
});

test("detects instruction-style briefs and keeps them off the slides", async () => {
  const { briefLooksLikeInstruction, fallbackDeck } = await import("../src/deck/deckPlanner.js");
  const promptBrief = "“Kamu adalah konsultan strategi senior sekaligus desainer keynote ala TED Talk. Buatlah 20 slide tentang ekosistem AI Indonesia.";
  assert.equal(briefLooksLikeInstruction(promptBrief), true);
  assert.equal(briefLooksLikeInstruction("Ekosistem AI Indonesia tumbuh pesat sejak 2020. Data menunjukkan..."), false);
  const spec = fallbackDeck(promptBrief, 20);
  const allText = JSON.stringify(spec);
  assert.ok(!allText.includes("Kamu adalah konsultan"), "fallback must not quote the prompt");
  assert.match(spec.slides[0].headline, /Model Studio diperlukan/);
});

// --- Verified fix: a user's Cancel click must stop the run, not silently
// turn into a retry. runTantular's AbortError message contains "terlalu
// lama" (tantularClient.js), the exact phrase planDeck used to detect a
// timeout worth retrying with a smaller core plan — so a genuine cancel and
// a genuine timeout used to be indistinguishable here, and Cancel would have
// been "quietly try again" instead of "stop".

test("planDeck does not retry after the caller's signal was aborted, even though the error message looks like a timeout", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  try {
    const controller = new AbortController();
    controller.abort();
    // A cancelled run must REJECT, not resolve into a usable fallback deck —
    // a fallback deck is exactly what would get built into a .pptx and
    // inserted into the presentation, which Cancel must prevent.
    await assert.rejects(
      planDeck({
        brief: "Ekosistem AI Indonesia tumbuh pesat sejak 2020.",
        slideCount: 6,
        signal: controller.signal
      }),
      "planDeck must reject after the caller's signal is aborted, not resolve to a fallback deck"
    );
    assert.equal(calls, 1, "an aborted run must not retry with a compact core plan");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarizeSlideBullets rejects (does not silently keep the original bullets) once the signal is aborted", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      summarizeSlideBullets("Judul", ["Poin satu", "Poin dua"], "", "", controller.signal),
      "an aborted summarize call must reject, not silently return the original bullets"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("summarizeDeckSections stops at the currently-aborted slide and never summarizes the ones after it", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) {
      // Simulate the user clicking Cancel while the SECOND slide's request
      // is in flight — the third slide must never be reached.
      controller.abort();
    }
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  const spec = {
    slides: [
      { type: "bullets", headline: "Slide 1", bullets: ["A"] },
      { type: "bullets", headline: "Slide 2", bullets: ["B"] },
      { type: "bullets", headline: "Slide 3", bullets: ["C"] }
    ]
  };

  try {
    await assert.rejects(
      summarizeDeckSections(spec, "", "", () => {}, controller.signal),
      "summarizeDeckSections must reject once the signal is aborted mid-loop, not finish the remaining slides"
    );
    assert.equal(calls, 2, "the loop must stop at the aborted slide — a 3rd call means it kept going after Cancel");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("improveExistingSlide rejects (does not fall back to a synthetic slide) once the signal is aborted", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      improveExistingSlide({ slideText: "Headline\nBullet satu", signal: controller.signal }),
      "an aborted improve-slide call must reject, not resolve into a fallback slide that then gets inserted"
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- "Buat lebih visual" guardrails --------------------------------------
// Chat now sends "lebih visual" as steering text into improveExistingSlide.
// The grounding gate behind it is what keeps that request honest: a chart is
// allowed only when its numbers came from the slide, otherwise the slide
// becomes a non-chart shape. Both entry points (chat and the Lanjutan card)
// end in this function, so this is where the promise is pinned down.
function withModelReply(content, fn) {
  return async () => {
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
      text: async () => ""
    });
    try { await fn(); } finally { globalThis.fetch = originalFetch; }
  };
}

test("'lebih visual' on a slide WITHOUT numbers never becomes a chart", withModelReply(
  JSON.stringify({
    title: "Roadmap",
    slide: {
      type: "visualization", headline: "Roadmap keamanan", chartType: "bar",
      data: [{ label: "Fase satu", value: 40 }, { label: "Fase dua", value: 60 }],
      bullets: ["Fase satu: audit akses", "Fase dua: pelatihan tim"]
    }
  }),
  async () => {
    const result = await improveExistingSlide({
      slideText: "Roadmap keamanan\nFase satu: audit akses\nFase dua: pelatihan tim",
      instruction: "Bentuk slide: buat lebih visual."
    });
    const slide = result.spec.slides[0];
    assert.notEqual(slide.type, "visualization");
    assert.ok(!slide.data, "no invented data points may survive");
    assert.match(JSON.stringify(slide), /Fase/);
  }
));

test("a chart keeps only the numbers and labels that exist on the source slide", withModelReply(
  JSON.stringify({
    title: "Angka kunci",
    slide: {
      type: "visualization", headline: "Angka kunci", chartType: "bar",
      data: [
        { label: "Mitra aktif", value: 41 },
        { label: "Kepuasan mitra", value: 92 },
        { label: "Target tahun depan", value: 120 } // invented
      ]
    }
  }),
  async () => {
    const result = await improveExistingSlide({
      slideText: "Angka kunci\nMitra aktif: 41\nKepuasan mitra: 92%",
      instruction: "Bentuk slide: buat lebih visual."
    });
    const slide = result.spec.slides[0];
    assert.equal(slide.type, "visualization");
    assert.deepEqual(slide.data.map((d) => d.value).sort((a, b) => a - b), [41, 92]);
    assert.ok(!slide.data.some((d) => /Target/.test(d.label)));
  }
));

// --- Label leak (live, 2026-09-03) ----------------------------------------
// A cards request whose cards all failed grounding came back as the mechanical
// fallback slide (headline repeated as bullet one, "Dirapikan dari teks slide
// asli" subhead) while the result still said "model-grounded", so the chat
// reported a cards improvement that never happened. Grounding that gives up
// must surface as a fallback, never as a model result.
test("grounding that discards every card reports fallback-grounded, not model-grounded", withModelReply(
  JSON.stringify({
    title: "How to Read This Case",
    slide: {
      type: "cards", headline: "How to Read This Case",
      cards: [
        { title: "Quarterly revenue hit 300%", desc: "Benchmark against 12 peers" },
        { title: "Deadline 2027", desc: "Budget 45 juta" }
      ]
    }
  }),
  async () => {
    const result = await improveExistingSlide({
      slideText: "How to Read This Case\nRead it twice\nCite the exhibit you rely on",
      instruction: 'Bentuk slide: prioritaskan type "cards".'
    });
    assert.equal(result.source, "fallback-grounded");
    assert.ok(result.spec, "a fallback spec is still returned for callers that only preview/download");
  }
));

// --- Output language (live, 2026-09-03) -----------------------------------
// "Perbaiki slide ini" on an ENGLISH slide was refused twice. The model had
// rewritten it faithfully — in Indonesian. Grounding compares words with the
// source, so a translation looks like invented content and every line is
// dropped. The prompt never said which language to write in, and this model
// is Indonesian-first. The slide's own language must be stated explicitly.
import { detectSlideLanguage } from "../src/deck/deckPlanner.js";

test("detectSlideLanguage tells English from Indonesian slide text", () => {
  assert.equal(detectSlideLanguage("How to Read This Case\nRead it twice\nCite the exhibit or paragraph you rely on in every answer."), "en");
  assert.equal(detectSlideLanguage("Roadmap keamanan\nFase satu: audit akses dan pelatihan tim untuk seluruh cabang"), "id");
  assert.equal(detectSlideLanguage(""), "id");
});

test("improveExistingSlide states the source slide's language in the prompt", async () => {
  const seen = [];
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), text: async () => "" };
  };
  try {
    await improveExistingSlide({ slideText: "How to Read This Case\nRead it twice\nCite the exhibit or paragraph you rely on in every answer." });
    await improveExistingSlide({ slideText: "Roadmap keamanan\nFase satu: audit akses dan pelatihan tim untuk seluruh cabang" });
  } finally { globalThis.fetch = originalFetch; }
  const prompt = (i) => seen[i].messages.map((m) => m.content).join("\n");
  assert.match(prompt(0), /BAHASA OUTPUT: English/);
  assert.match(prompt(0), /jangan menerjemahkan/i);
  assert.match(prompt(1), /BAHASA OUTPUT: Bahasa Indonesia/);
});

// --- Rewrites must not be mistaken for inventions (live, 2026-09-03) ------
// With the language fixed, a faithful English rewrite of a two-column slide
// still lost three of four points in one column: grounding needs 82% exact
// token overlap, so "arguments are won" failed against "argument is won" and
// "relied upon" failed against "rely on". Two guards: inflections count as the
// same word, and a point that still fails is REPLACED by the source line in
// that position (when the model kept the block's point count) — never dropped.
const TWO_COL_TEXT = [
  "How to Read This Case",
  "Read it twice",
  "First pass for the story: who did what, and when.",
  "Second pass with Exhibit 4 open — the numbers are where the argument is won.",
  "Cite the exhibit or paragraph you rely on in every answer.",
  "Work with the gap",
  "The case is built from public sources and is deliberately incomplete.",
  "Naming a missing number scores higher than inventing one."
].join("\n");
const TWO_COL_BLOCKS = [
  ["First pass for the story: who did what, and when.", "Second pass with Exhibit 4 open — the numbers are where the argument is won.", "Cite the exhibit or paragraph you rely on in every answer."],
  ["The case is built from public sources and is deliberately incomplete.", "Naming a missing number scores higher than inventing one."]
];

test("inflected forms of source words count as grounded", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "bullets", headline: "How to Read This Case", bullets: [
    "Second pass with Exhibit 4 open: the numbers are where arguments are won.",
    "Cite the exhibits or paragraphs you rely on in every answer."
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: TWO_COL_TEXT });
    assert.equal(result.source, "model-grounded");
    assert.deepEqual(result.spec.slides[0].bullets, [
      "Second pass with Exhibit 4 open: the numbers are where arguments are won.",
      "Cite the exhibits or paragraphs you rely on in every answer."
    ]);
  }
));

test("an ungrounded rewritten point is replaced by the source line in its position, not dropped", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "columns", headline: "How to Read This Case", columns: [
    { title: "Read it twice", points: [
      "First pass: identify who did what and when.",
      "Second pass with Exhibit 4 open — the numbers are where the argument is won.",
      "Cite the specific evidence relied upon in every response, without exception." // invented wording
    ] },
    { title: "Work with the gap", points: [
      "Quarterly revenue grew 300% year on year.", // invented fact
      "Naming a missing number scores higher than inventing one."
    ] }
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: TWO_COL_TEXT, sourceBlocks: TWO_COL_BLOCKS });
    assert.equal(result.source, "model-grounded");
    const cols = result.spec.slides[0].columns;
    assert.deepEqual(cols[0].points, [
      "First pass: identify who did what and when.",
      "Second pass with Exhibit 4 open — the numbers are where the argument is won.",
      "Cite the exhibit or paragraph you rely on in every answer."
    ]);
    assert.deepEqual(cols[1].points, [
      "The case is built from public sources and is deliberately incomplete.",
      "Naming a missing number scores higher than inventing one."
    ]);
  }
));

test("without matching source blocks an ungrounded point is still dropped (no positional guess)", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "columns", headline: "How to Read This Case", columns: [
    { title: "Read it twice", points: ["First pass: identify who did what and when.", "Quarterly revenue grew 300% year on year."] },
    { title: "Work with the gap", points: ["Naming a missing number scores higher than inventing one."] }
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: TWO_COL_TEXT, sourceBlocks: TWO_COL_BLOCKS });
    assert.deepEqual(result.spec.slides[0].columns[0].points, ["First pass: identify who did what and when."]);
  }
));

// --- Facts vs wording (owner decision, 2026-09-03) ------------------------
// The 82% exact-overlap rule made improve a no-op on English editorial slides:
// every rewording was rejected and the source line put back. The guard is now
// split: FACTS stay strict (any number, or a capitalised name mid-sentence,
// must exist on the source slide); WORDING passes when about half of the
// content words are covered after stemming.
test("a rewording that keeps the facts passes even below 82% word overlap", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "bullets", headline: "How to Read This Case", bullets: [
    "Cite the specific exhibits or paragraphs relied upon in every answer.",
    "Acknowledge that the case is built from public sources and is deliberately incomplete."
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: TWO_COL_TEXT });
    assert.deepEqual(result.spec.slides[0].bullets, [
      "Cite the specific exhibits or paragraphs relied upon in every answer.",
      "Acknowledge that the case is built from public sources and is deliberately incomplete."
    ]);
  }
));

test("a new number or a new name is still rejected even when the wording overlaps", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "bullets", headline: "How to Read This Case", bullets: [
    "Cite the exhibit or paragraph you rely on in every answer, as Porter recommends.",
    "Second pass with Exhibit 5 open — the numbers are where the argument is won.",
    "Naming a missing number scores higher than inventing one."
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: TWO_COL_TEXT });
    assert.deepEqual(result.spec.slides[0].bullets, ["Naming a missing number scores higher than inventing one."]);
  }
));

// --- Card labels (live, 2026-09-03) ----------------------------------------
// "Buat slide lebih visual" made three cards; two lost their titles because a
// short label must have EVERY word on the slide. A label built from the
// slide's own topic words ("Evidence Discrimination" on a slide about
// evidence types) is a heading, not a claim: half its words on the slide is
// enough. A label carrying a number the slide never states is still blocked.
const ASSESSED = [
  "How This Is Assessed",
  "First. Is your reasoning traceable?",
  "A claim tied to an exhibit beats a confident assertion; show the reader where numbers originate.",
  "Second. Do you distinguish what the sources establish from what the companies assert about themselves? Both appear in the case; they are different kinds of evidence.",
  "And. Do you name what is missing? An answer that names a gap scores higher than one that invents a number."
].join("\n");

test("a short card label built from the slide's topic words keeps its title; a label with a new number does not", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "cards", headline: "How This Is Assessed", cards: [
    { title: "Traceable Reasoning", desc: "Tie every claim to an exhibit and show where numbers originate." },
    { title: "Evidence Discrimination", desc: "Distinguish what sources establish from what companies assert about themselves." },
    { title: "Gap Handling", desc: "Name what is missing; a named gap scores higher than an invented number." },
    { title: "Top 5 Criteria", desc: "Name what is missing." }
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: ASSESSED });
    const cards = result.spec.slides[0].cards;
    assert.deepEqual(cards.slice(0, 3).map((c) => c.title), ["Traceable Reasoning", "Evidence Discrimination", "Gap Handling"]);
    assert.ok(!/5/.test(cards[3].title), "a label with a number the slide never states is not kept");
    assert.equal(cards[3].title, "Name what is missing", "...and is replaced by a label from the card's own text");
  }
));

test("a card whose title fails grounding gets a label derived from its own grounded text, never a blank", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "cards", headline: "How This Is Assessed", cards: [
    { title: "Traceable Reasoning", desc: "Tie every claim to an exhibit and show where numbers originate." },
    { title: "Acknowledge Uncertainty Openly", desc: "Name what is missing; a named gap scores higher than an invented number." },
    { title: "Top 5 Criteria", desc: "Distinguish what the sources establish from what the companies assert about themselves." }
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: ASSESSED });
    const cards = result.spec.slides[0].cards;
    assert.equal(cards[0].title, "Traceable Reasoning");
    assert.equal(cards[1].title, "Name what is missing");
    assert.equal(cards[2].title, "Distinguish what the sources establish");
    assert.ok(cards.every((c) => c.title), "no card is left without a title");
  }
));

test("a derived card label stops before a connective instead of cutting mid-clause", withModelReply(
  JSON.stringify({ title: "t", slide: { type: "cards", headline: "How This Is Assessed", cards: [
    { title: "Identify Missing Elements", desc: "Score answers that name missing gaps and propose alternatives higher than those that invent numbers." },
    { title: "Traceable Reasoning", desc: "Tie every claim to an exhibit." }
  ] } }),
  async () => {
    const result = await improveExistingSlide({ slideText: ASSESSED });
    assert.equal(result.spec.slides[0].cards[0].title, "Score answers");
  }
));

test("the improve prompt asks for card titles as short labels made of the slide's own words", async () => {
  const seen = [];
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), text: async () => "" };
  };
  try { await improveExistingSlide({ slideText: ASSESSED }); } finally { globalThis.fetch = originalFetch; }
  assert.match(seen[0].messages[0].content, /Judul kartu.*2.4 kata.*kata-kata yang ada di slide sumber/s);
});

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

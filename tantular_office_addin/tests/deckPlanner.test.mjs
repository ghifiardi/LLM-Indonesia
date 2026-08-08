import test from "node:test";
import assert from "node:assert/strict";
import {
  expandSlidesToCount,
  inferRequestedSlideCount,
  isThinContent,
  looksLikePresentationBrief
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

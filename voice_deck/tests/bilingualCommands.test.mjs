import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDeterministic } from "../intentRouter.js";
import { matchTopic } from "../topicMatcher.js";

const slides = (() => {
  const d = JSON.parse(fs.readFileSync(new URL("../slides.json", import.meta.url), "utf8"));
  return Array.isArray(d) ? d : d.slides;
})();

const act = (phrase) => parseDeterministic(phrase)?.action ?? "noop";

// Topic navigation was English-only: "go to pricing" worked while every
// Indonesian phrasing fell through to noop, including the phrase the module
// was demoed with. These run offline — no Ollama — because the whole point is
// that the common case never leaves the machine.
test("Indonesian topic navigation resolves without Ollama", () => {
  for (const phrase of [
    "buka bagian keamanan", "buka bagian harga", "ke bagian harga",
    "buka harga", "buka topik privasi", "tampilkan bagian penutup",
  ]) {
    const cmd = parseDeterministic(phrase);
    assert.ok(cmd, `"${phrase}" did not parse at all`);
    assert.equal(cmd.action, "goto_topic", `"${phrase}" -> ${cmd.action}`);
    assert.ok(cmd.query && cmd.query.length, `"${phrase}" produced an empty query`);
  }
});

test("the section word is not captured as part of the topic", () => {
  // "buka bagian keamanan" must query "keamanan", not "bagian keamanan",
  // or the matcher scores against a word every slide lacks.
  assert.equal(parseDeterministic("buka bagian keamanan").query, "keamanan");
  assert.equal(parseDeterministic("ke bagian harga").query, "harga");
  assert.equal(parseDeterministic("go to the section on pricing").query, "pricing");
});

test("English topic navigation covers the natural phrasings", () => {
  for (const phrase of [
    "go to pricing", "jump to pricing", "navigate to pricing",
    "take me to pricing", "open the section on pricing", "show me pricing",
  ]) {
    assert.equal(act(phrase), "goto_topic", `"${phrase}"`);
  }
});

test("blank and end work in both languages", () => {
  for (const phrase of ["blank the screen", "go dark", "layar hitam", "hitamkan layar"]) {
    assert.equal(act(phrase), "blank", `"${phrase}"`);
  }
  for (const phrase of ["end the presentation", "finish", "akhiri", "akhiri presentasi", "selesai"]) {
    assert.equal(act(phrase), "end", `"${phrase}"`);
  }
});

test("a bare topic verb never swallows a slide number or the notes command", () => {
  // "buka (.+)" is deliberately broad, so the rules that must win are pinned.
  assert.equal(parseDeterministic("buka slide lima").action, "goto_slide");
  assert.equal(parseDeterministic("buka slide lima").slide, 5);
  assert.equal(act("buka catatan"), "show_notes");
  assert.equal(act("open notes"), "show_notes");
});

test("movement commands still work in both languages", () => {
  for (const [phrase, want] of [
    ["next slide", "next"], ["lanjutkan", "next"], ["selanjutnya", "next"],
    ["previous slide", "previous"], ["kembali", "previous"],
    ["go to slide five", "goto_slide"], ["ke slide tiga", "goto_slide"],
  ]) assert.equal(act(phrase), want, `"${phrase}"`);
});

// Parsing an Indonesian command is useless if the query then matches nothing:
// the failure looks identical to the feature not existing.
test("Indonesian topic queries resolve to a real slide", () => {
  for (const [phrase, expectedTitle] of [
    ["buka bagian harga", /Pricing/i],
    ["buka prinsip desain", /Design Principles/i],
    ["buka bagian privasi", /Intent Routing/i],
    ["tampilkan bagian penutup", /Thank You/i],
  ]) {
    const cmd = parseDeterministic(phrase);
    const n = matchTopic(cmd.query, slides);
    assert.ok(n !== null, `"${phrase}" parsed but matched no slide`);
    assert.match(slides[n - 1].title, expectedTitle, `"${phrase}" -> ${slides[n - 1].title}`);
  }
});

test("every slide carries Indonesian tags, not only English", () => {
  // Checked against actual Indonesian vocabulary. A looser test (/[a-z]/, say)
  // passes on English tags too and can never fail, which is worse than no test.
  const ID_WORDS = /\b(pendahuluan|pembuka|ikhtisar|suara|masalah|latar|kendala|remot|penunjuk|prinsip|keandalan|keamanan|tekan|bicara|arsitektur|kontrak|perintah|perutean|niat|lokal|privasi|dwibahasa|bahasa|harga|penetapan|peluncuran|peta|jalan|bisnis|lisensi|dek|purwarupa|risiko|strategi|penutup|terima|kasih|pertanyaan|tanya|jawab)\b/;
  for (const slide of slides) {
    assert.ok(Array.isArray(slide.tags) && slide.tags.length >= 5,
      `slide ${slide.id} has too few tags for bilingual matching`);
    assert.ok(slide.tags.some((t) => ID_WORDS.test(t)),
      `slide ${slide.id} ("${slide.title}") has no Indonesian tag: ${JSON.stringify(slide.tags)}`);
  }
});

// Chat as the primary entry point for improving ONE selected slide.
// Everything here is pure: no Office, no DOM, no model calls.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DECK_SETTINGS_NOTE,
  SELECT_ONE_SLIDE_MESSAGE,
  mentionsSelectedSlide,
  resolveSelectedSlideIndex,
  rewriteSelectedSlideMessage,
  pinActionsToSlide,
  visualPreferenceFor,
  visualPreferenceInstruction,
  refineVisualModeInstruction,
  REFINE_VISUAL_MODES,
  pptQuickChips
} from "../src/chat/pptSelectedSlide.js";

// --- 1. resolving "slide ini" from the live selection -----------------------

test("mentionsSelectedSlide matches the Indonesian and English phrasings without an explicit number", () => {
  for (const msg of [
    "Perbaiki slide ini",
    "jadikan slide terpilih lebih executive",
    "Slide yang dipilih terlalu padat, ringkas",
    "make this slide more visual",
    "improve the selected slide"
  ]) assert.equal(mentionsSelectedSlide(msg), true, msg);
});

test("an explicit slide number wins over the selected-slide phrasing", () => {
  assert.equal(mentionsSelectedSlide("perbaiki slide 4"), false);
  assert.equal(mentionsSelectedSlide("slide ini dan slide 3 digabung"), false);
  assert.equal(mentionsSelectedSlide("Apa isi deck ini?"), false);
  assert.equal(mentionsSelectedSlide(""), false);
});

test("exactly one selected slide resolves to its index", () => {
  const resolved = resolveSelectedSlideIndex({ slideIds: ["258"], slideIndexes: [3] });
  assert.deepEqual(resolved, { ok: true, index: 3 });
});

test("no selection resolves to nothing and carries the user-facing message", () => {
  for (const selected of [
    null,
    {},
    { slideIds: [], slideIndexes: [] },
    { slideIds: ["258"], slideIndexes: [] } // id known, position unknown: still cannot target
  ]) {
    const resolved = resolveSelectedSlideIndex(selected);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.index, 0);
    assert.equal(resolved.reason, SELECT_ONE_SLIDE_MESSAGE);
  }
  assert.equal(SELECT_ONE_SLIDE_MESSAGE, "Pilih satu slide terlebih dahulu, lalu coba lagi.");
});

test("two selected slides ask the user to pick one", () => {
  const resolved = resolveSelectedSlideIndex({ slideIds: ["257", "258"], slideIndexes: [2, 3] });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, SELECT_ONE_SLIDE_MESSAGE);
});

test("rewriteSelectedSlideMessage replaces the phrase with the resolved slide number for the planner", () => {
  assert.equal(rewriteSelectedSlideMessage("Perbaiki slide ini", 3), "Perbaiki slide 3");
  assert.equal(rewriteSelectedSlideMessage("Buat slide terpilih lebih visual.", 7), "Buat slide 7 lebih visual.");
  assert.equal(rewriteSelectedSlideMessage("improve this slide", 2), "improve slide 2");
});

test("pinActionsToSlide retargets improve/replace to the selected slide and drops the rest", () => {
  const { actions, rejected } = pinActionsToSlide([
    { op: "improve_slide", slideIndex: 1, instruction: "lebih ringkas" },
    { op: "replace_slide", slideIndex: 5, slide: { type: "bullets", headline: "x", bullets: ["a"] } },
    { op: "add_slide", afterIndex: 3, slide: { type: "bullets", headline: "y", bullets: ["b"] } },
    { op: "delete_slide", slideIndex: 3 }
  ], 3);
  assert.deepEqual(actions.map((a) => `${a.op}@${a.slideIndex}`), ["improve_slide@3", "replace_slide@3"]);
  assert.equal(actions[0].instruction, "lebih ringkas");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((line) => /slide terpilih/.test(line)));
});

// --- 2. PowerPoint-only chips ------------------------------------------------

test("the two improve chips exist only on PowerPoint", () => {
  const ppt = pptQuickChips("PowerPoint");
  const labels = ppt.map((chip) => chip.label);
  assert.ok(labels.includes("🛠 Perbaiki slide terpilih"));
  assert.ok(labels.includes("▥ Buat slide lebih visual"));
  assert.ok(labels.includes("🔍 Usulkan perbaikan slide ini"));
  assert.ok(labels.includes("✨ Tata ulang slide ini"));
  for (const host of ["Word", "Excel", "Office", "", undefined]) {
    assert.deepEqual(pptQuickChips(host), [], String(host));
  }
});

test("improve chips submit a selected-slide request; they never carry an action or write", () => {
  for (const chip of pptQuickChips("PowerPoint").filter((c) => c.submit)) {
    assert.equal(typeof chip.message, "string");
    assert.equal(mentionsSelectedSlide(chip.message), true, chip.label);
    // A chip is a message, nothing else: no op, no slide, no write hook.
    assert.deepEqual(Object.keys(chip).sort(), ["label", "message", "submit"]);
  }
  // The read-only question chips stay as they were: fill the box, do not send.
  const questions = pptQuickChips("PowerPoint").filter((c) => !c.submit);
  assert.equal(questions.length, 3);
  assert.ok(questions.every((c) => c.message.endsWith("?")));
});

// --- 4. visual preference as instruction text, not schema -------------------

test("visualPreferenceFor maps intent words to a supported slide shape", () => {
  assert.equal(visualPreferenceFor("supaya lebih ringkas"), "bullets");
  assert.equal(visualPreferenceFor("padatkan"), "bullets");
  assert.equal(visualPreferenceFor("simplify this"), "bullets");
  assert.equal(visualPreferenceFor("jadikan kartu"), "cards");
  assert.equal(visualPreferenceFor("use cards"), "cards");
  assert.equal(visualPreferenceFor("bandingkan dalam kolom"), "columns");
  assert.equal(visualPreferenceFor("perbandingan A vs B"), "columns");
  assert.equal(visualPreferenceFor("compare"), "columns");
  assert.equal(visualPreferenceFor("buat lebih visual"), "visual");
  assert.equal(visualPreferenceFor("ubah jadi chart"), "visual");
  assert.equal(visualPreferenceFor("tambahkan grafik / diagram"), "visual");
  assert.equal(visualPreferenceFor("jadikan lebih executive"), "");
  assert.equal(visualPreferenceFor(""), "");
});

test("visualPreferenceInstruction never allows numbers the source does not have", () => {
  const visual = visualPreferenceInstruction("visual");
  assert.match(visual, /angka eksplisit/i);
  assert.match(visual, /cards|columns/);
  assert.match(visual, /jangan (membuat|mengarang)/i);
  assert.equal(visualPreferenceInstruction(""), "");
  assert.match(visualPreferenceInstruction("bullets"), /bullets/);
  assert.match(visualPreferenceInstruction("cards"), /cards/);
  assert.match(visualPreferenceInstruction("columns"), /columns/);
});

test("the Lanjutan visual-mode select converts to the same instruction text", () => {
  assert.deepEqual(Object.keys(REFINE_VISUAL_MODES), ["auto", "concise", "cards", "columns", "chart"]);
  assert.equal(refineVisualModeInstruction("auto"), "");
  assert.equal(refineVisualModeInstruction("concise"), visualPreferenceInstruction("bullets"));
  assert.equal(refineVisualModeInstruction("cards"), visualPreferenceInstruction("cards"));
  assert.equal(refineVisualModeInstruction("columns"), visualPreferenceInstruction("columns"));
  assert.equal(refineVisualModeInstruction("chart"), visualPreferenceInstruction("visual"));
  assert.equal(refineVisualModeInstruction("nonsense"), "");
});

test("the proposal note names Deck Studio", () => {
  assert.equal(DECK_SETTINGS_NOTE, "Menggunakan pengaturan Deck Studio.");
});

test("a table request is steered to columns — the closest supported shape", () => {
  assert.equal(visualPreferenceFor("Apakah bisa dibuat tabel sehingga lebih terstruktur"), "columns");
  assert.equal(visualPreferenceFor("turn this into a table"), "columns");
});

// --- Planner-invented intent (traced live, 2026-09-03) ----------------------
// The user clicked "Perbaiki slide terpilih"; the planner emitted
// instruction "perbaiki slide supaya lebih ringkas" — copied from the example
// in its own prompt. With a "ringkas" intent the improve model played safe
// and returned the slide verbatim. An intent must be backed by the user's
// own words, or the user's message is used instead.
import { groundActionIntent } from "../src/chat/pptSelectedSlide.js";

test("groundActionIntent keeps a planner intent only when the user's message backs it", () => {
  assert.equal(groundActionIntent("supaya lebih ringkas", "perbaiki slide 4 supaya lebih ringkas"), "supaya lebih ringkas");
  assert.equal(groundActionIntent("jadikan kartu", "ubah slide 3 menjadi kartu"), "jadikan kartu");
  assert.equal(groundActionIntent("perbaiki slide supaya lebih ringkas", "Perbaiki slide 3."), "Perbaiki slide 3.");
  assert.equal(groundActionIntent("buat lebih visual", "rapikan slide ini"), "rapikan slide ini");
  assert.equal(groundActionIntent("", "Perbaiki slide 3."), "Perbaiki slide 3.");
});

test("a negated shape word is not a layout request", () => {
  assert.equal(visualPreferenceFor("warna kartu atau warna font disesuaikan agar terbaca dan 2 kolom tidak diperlukan karena bullet point"), "bullets");
  assert.equal(visualPreferenceFor("jangan pakai kartu, cukup rapikan"), "");
  assert.equal(visualPreferenceFor("bukan chart, tetapi daftar poin"), "bullets");
  assert.equal(visualPreferenceFor("jadikan kartu"), "cards");
});

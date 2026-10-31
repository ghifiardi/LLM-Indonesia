// "Usulkan perbaikan slide ini": the chat analyses the selected slide, offers
// concrete changes from a FIXED catalogue (each with the exact current text
// and the exact proposed text), the user ticks one or more, and only those
// are applied — in place, design untouched. Everything here is pure.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUGGEST_TYPES,
  wantsSuggestions,
  parseSuggestions,
  applySuggestions,
  suggestionsToSlide,
  requestSuggestions,
  describeSuggestion
} from "../src/chat/pptSuggest.js";
import { executeSuggestionPlan } from "../src/chat/pptTools.js";

const STRUCTURE = {
  title: "How to Read This Case",
  bodies: 2,
  headings: ["Read it twice", "Work with the gap"],
  blocks: [
    ["First pass for the story: who did what, and when.", "Second pass with Exhibit 4 open — the numbers are where the argument is won.", "Cite the exhibit or paragraph you rely on in every answer."],
    ["The case is built from public sources and is deliberately incomplete.", "Several figures you would want in order to judge the decision have never been published.", "Naming a missing number scores higher than inventing one."]
  ]
};

const RAW = JSON.stringify({ suggestions: [
  { type: "sharpen_headline", before: "How to Read This Case", after: "How to Read This Case: Two Passes, One Argument" },
  { type: "shorten_point", column: 1, before: "Second pass with Exhibit 4 open — the numbers are where the argument is won.", after: "Second pass with Exhibit 4 open: the numbers decide the argument." },
  { type: "merge_points", column: 2, before: ["The case is built from public sources and is deliberately incomplete.", "Several figures you would want in order to judge the decision have never been published."], after: "Built from public sources, the case is deliberately incomplete: key figures were never published." },
  { type: "split_point", column: 1, before: "First pass for the story: who did what, and when.", after: ["First pass: follow the story.", "Note who did what, and when."] },
  { type: "move_point", column: 1, toColumn: 2, before: "Cite the exhibit or paragraph you rely on in every answer." },
  { type: "shorten_point", column: 2, before: "This line is not on the slide.", after: "Whatever." },
  { type: "shorten_point", column: 1, before: "Cite the exhibit or paragraph you rely on in every answer.", after: "Cite Exhibit 7 in every answer." },
  { type: "sharpen_headline", before: "How to Read This Case", after: "How Porter Would Read This Case" },
  { type: "delete_point", column: 1, before: "Cite the exhibit or paragraph you rely on in every answer." }
] });

test("the catalogue is exactly the five agreed change types", () => {
  assert.deepEqual(SUGGEST_TYPES, ["sharpen_headline", "shorten_point", "merge_points", "split_point", "move_point"]);
});

test("wantsSuggestions recognises a request for options, not an instruction to change", () => {
  assert.equal(wantsSuggestions("Usulkan perbaikan untuk slide terpilih."), true);
  assert.equal(wantsSuggestions("apa yang bisa diperbaiki di slide ini?"), true);
  assert.equal(wantsSuggestions("beri saran untuk slide ini"), true);
  assert.equal(wantsSuggestions("suggest improvements for this slide"), true);
  assert.equal(wantsSuggestions("Perbaiki slide ini"), false);
  assert.equal(wantsSuggestions("Apa isi deck ini?"), false);
});

test("parseSuggestions keeps only catalogue items whose 'before' text exists on the slide and whose 'after' adds no new facts", () => {
  const list = parseSuggestions(RAW, STRUCTURE);
  assert.deepEqual(list.map((s) => s.type), ["sharpen_headline", "shorten_point", "merge_points", "split_point", "move_point"]);
  // unknown 'before', an invented number (Exhibit 7), an invented name (Porter) and an off-catalogue type are all dropped
  assert.ok(!list.some((s) => /Exhibit 7|Porter|not on the slide/.test(JSON.stringify(s))));
  assert.ok(list.every((s, i) => s.id === `s${i + 1}`));
  assert.equal(list[1].column, 1);
  assert.equal(list[2].before.length, 2);
  assert.equal(list[4].toColumn, 2);
});

test("describeSuggestion renders a checklist line with the exact before and after", () => {
  const [headline, shorten, merge, split, move] = parseSuggestions(RAW, STRUCTURE);
  assert.match(describeSuggestion(headline), /^Pertajam judul: "How to Read This Case" → "How to Read This Case: Two Passes, One Argument"$/);
  assert.match(describeSuggestion(shorten), /^Perpendek poin \(kolom 1\): ".*" → ".*"$/);
  assert.match(describeSuggestion(merge), /^Gabungkan 2 poin \(kolom 2\)/);
  assert.match(describeSuggestion(split), /^Pecah poin \(kolom 1\)/);
  assert.match(describeSuggestion(move), /^Pindahkan poin dari kolom 1 ke kolom 2: "Cite the exhibit/);
});

test("applySuggestions applies ONLY the ticked items and leaves everything else exactly as it was", () => {
  const list = parseSuggestions(RAW, STRUCTURE);
  const ids = (...types) => list.filter((s) => types.includes(s.type)).map((s) => s.id);

  const none = applySuggestions(STRUCTURE, list, []);
  assert.deepEqual(none, { title: STRUCTURE.title, blocks: STRUCTURE.blocks });

  const shortened = applySuggestions(STRUCTURE, list, ids("shorten_point"));
  assert.equal(shortened.blocks[0][1], "Second pass with Exhibit 4 open: the numbers decide the argument.");
  assert.deepEqual(shortened.blocks[1], STRUCTURE.blocks[1]);

  const merged = applySuggestions(STRUCTURE, list, ids("merge_points"));
  assert.deepEqual(merged.blocks[1], [
    "Built from public sources, the case is deliberately incomplete: key figures were never published.",
    "Naming a missing number scores higher than inventing one."
  ]);

  const split = applySuggestions(STRUCTURE, list, ids("split_point"));
  assert.deepEqual(split.blocks[0].slice(0, 2), ["First pass: follow the story.", "Note who did what, and when."]);
  assert.equal(split.blocks[0].length, 4);

  const moved = applySuggestions(STRUCTURE, list, ids("move_point"));
  assert.equal(moved.blocks[0].length, 2);
  assert.equal(moved.blocks[1][3], "Cite the exhibit or paragraph you rely on in every answer.");

  const all = applySuggestions(STRUCTURE, list, list.map((s) => s.id));
  assert.equal(all.title, "How to Read This Case: Two Passes, One Argument");
  assert.equal(all.blocks[0].length, 3); // split (+1) and move (-1) and shorten (0)
  assert.equal(all.blocks[1].length, 3); // merge (-1) and move (+1)
});

test("suggestionsToSlide builds the in-place slide shape for the writer: columns keep their headings", () => {
  const applied = applySuggestions(STRUCTURE, parseSuggestions(RAW, STRUCTURE), ["s1"]);
  const slide = suggestionsToSlide(STRUCTURE, applied);
  assert.equal(slide.type, "columns");
  assert.equal(slide.headline, "How to Read This Case: Two Passes, One Argument");
  assert.deepEqual(slide.columns.map((c) => c.title), ["Read it twice", "Work with the gap"]);
  const one = suggestionsToSlide({ title: "T", bodies: 1, headings: [], blocks: [["a", "b"]] }, { title: "T", blocks: [["a2", "b"]] });
  assert.deepEqual(one, { type: "bullets", headline: "T", bullets: ["a2", "b"] });
});

test("requestSuggestions locks the output language to the slide's and parses the model's answer", async () => {
  const seen = [];
  const list = await requestSuggestions({
    structure: STRUCTURE, tone: "executive", instruction: "style guide X",
    run: async (args) => { seen.push(args); return RAW; }
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0].user, /BAHASA OUTPUT: English/);
  assert.match(seen[0].user, /Read it twice/);
  assert.match(seen[0].user, /style guide X/);
  assert.match(seen[0].system, /sharpen_headline/);
  assert.equal(list.length, 5);
});

test("executeSuggestionPlan reads the live shapes, applies the ticked items, and writes only the changed shapes", async () => {
  const shapes = [
    { name: "Title 1", text: "How to Read This Case" },
    { name: "TextBox 2", text: "Read it twice\rFirst pass for the story: who did what, and when.\rSecond pass with Exhibit 4 open — the numbers are where the argument is won.\rCite the exhibit or paragraph you rely on in every answer." },
    { name: "TextBox 3", text: "Work with the gap\rThe case is built from public sources and is deliberately incomplete.\rSeveral figures you would want in order to judge the decision have never been published.\rNaming a missing number scores higher than inventing one." }
  ];
  const calls = [];
  const list = parseSuggestions(RAW, STRUCTURE);
  const { lines } = await executeSuggestionPlan(
    { slideId: "258", slideIndex: 3, suggestions: list, selectedIds: ["s2"] },
    {
      readLiveIds: () => ["256", "257", "258"],
      readSlideShapes: () => ({ found: true, shapes }),
      writeShapeTexts: (target, writes) => { calls.push({ target, writes }); return { updated: true }; }
    }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].writes, [
    { index: 1, text: "First pass for the story: who did what, and when.\nSecond pass with Exhibit 4 open: the numbers decide the argument.\nCite the exhibit or paragraph you rely on in every answer.", afterFirstParagraph: true }
  ]);
  assert.match(lines[0], /^✅ Slide 3: 1 perubahan diterapkan/);
  assert.match(lines[1], /Perpendek poin/);
});

test("executeSuggestionPlan with nothing ticked writes nothing", async () => {
  const calls = [];
  const { lines } = await executeSuggestionPlan(
    { slideId: "258", slideIndex: 3, suggestions: parseSuggestions(RAW, STRUCTURE), selectedIds: [] },
    { readLiveIds: () => ["258"], readSlideShapes: () => ({ found: true, shapes: [] }), writeShapeTexts: () => { calls.push(1); return { updated: true }; } }
  );
  assert.deepEqual(calls, []);
  assert.match(lines[0], /tidak ada/i);
});

// Formatting requests in chat (2026-09-05): "perbesar font", "ukuran 20",
// "sesuaikan proporsional" act on the slide's own text boxes through the
// shape API — deterministic, no model, confirm-gated like every other write.
import test from "node:test";
import assert from "node:assert/strict";
import { parseFormatRequest, planFormatWrites } from "../src/chat/pptFormat.js";
import { executeFormat } from "../src/chat/pptTools.js";

const SHAPES = [
  { name: "Title 1", text: "Judul", left: 54, top: 60, width: 852, height: 60, fontSize: 28 },
  { name: "Rectangle 2", text: "", left: 54, top: 160, width: 10, height: 10 },
  { name: "TextBox 3", text: "Poin satu", left: 84, top: 150, width: 822, height: 30, fontSize: 16 },
  { name: "TextBox 4", text: "Poin dua", left: 84, top: 200, width: 822, height: 30, fontSize: 16 },
  { name: "TextBox 9", text: "Tantular Deck Studio · 2/8", left: 54, top: 500, width: 300, height: 20, fontSize: 9 }
];

test("parseFormatRequest understands bigger/smaller/exact/proportional and ignores unrelated text", () => {
  assert.deepEqual(parseFormatRequest("Apakah font size bisa diperbesar dan disesuaikan sehingga proporsional dengan ukuran slide"), { kind: "fit" });
  assert.deepEqual(parseFormatRequest("perbesar font"), { kind: "font", delta: 2 });
  assert.deepEqual(parseFormatRequest("kecilkan hurufnya sedikit"), { kind: "font", delta: -2 });
  assert.deepEqual(parseFormatRequest("ukuran font 20"), { kind: "font", size: 20 });
  assert.deepEqual(parseFormatRequest("font size 18 pt untuk isi"), { kind: "font", size: 18 });
  assert.deepEqual(parseFormatRequest("sesuaikan agar proporsional"), { kind: "fit" });
  assert.equal(parseFormatRequest("apa isi deck ini?"), null);
  assert.equal(parseFormatRequest("perbaiki slide ini"), null);
});

test("planFormatWrites changes body text sizes only: never the title, footer, or markers; clamps to 8–60", () => {
  const up = planFormatWrites(SHAPES, { kind: "font", delta: 2 });
  assert.deepEqual(up.map((w) => [w.index, w.fontSize]), [[2, 18], [3, 18]]);
  const exact = planFormatWrites(SHAPES, { kind: "font", size: 22 });
  assert.deepEqual(exact.map((w) => w.fontSize), [22, 22]);
  const clamped = planFormatWrites(SHAPES, { kind: "font", size: 99 });
  assert.ok(clamped.every((w) => w.fontSize === 60));
  assert.deepEqual(planFormatWrites([SHAPES[0], SHAPES[4]], { kind: "font", delta: 2 }), []);
});

test("executeFormat applies font writes with a report line, and routes 'fit' to the re-layout", async () => {
  const applied = [];
  const { lines } = await executeFormat({ slideId: "2", slideIndex: 2 }, { kind: "font", delta: 2 }, {
    readLiveIds: () => ["1", "2"],
    readSlideShapes: () => ({ found: true, shapes: SHAPES }),
    applySlideLayout: (_t, writes) => { applied.push(writes); return { updated: true }; }
  });
  assert.equal(applied.length, 1);
  assert.match(lines[0], /^🔠 Slide 2: ukuran huruf isi 16 → 18/);
  const relaid = [];
  const fit = await executeFormat({ slideId: "2", slideIndex: 2 }, { kind: "fit" }, {
    readLiveIds: () => ["1", "2"],
    relayout: async (target) => { relaid.push(target); return { ok: true, line: "✨ Slide 2 ditata ulang" }; }
  });
  assert.equal(relaid.length, 1);
  assert.match(fit.lines[0], /ditata ulang/);
});

// Deterministic layout repair (2026-09-05). The model only sees text; the
// pane can see geometry. After an in-place rewrite the builder's fixed-height
// bullet boxes overlapped. Audit → reflow → apply, keeping the design: same
// fonts, colours, order, left edges and widths. Pure module + mocked host.
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTextHeight, auditSlideLayout, reflowSlideLayout, describeLayoutRepair } from "../src/deck/slideLayout.js";
import { applySlideLayout } from "../src/officeClient.js";
import { executeLayoutTidy } from "../src/chat/pptTools.js";

// The live slide 21 (builder bullets, 960×540): two boxes 46pt apart, the
// first now holding four lines at 14pt — it needs ~78pt and overlaps the next.
const SLIDE = [
  { name: "Title 1", text: "Detail Spesifikasi dan Sumber Pelarut", left: 54, top: 60, width: 852, height: 60, fontSize: 28 },
  { name: "Rectangle 2", text: "", left: 54, top: 160, width: 12, height: 12 },
  { name: "TextBox 3", text: "Nama Pelarut\nJumlah dan Satuan\nSumber (Hewan/Manusia)\nProdusen", left: 84, top: 150, width: 822, height: 46, fontSize: 14 },
  { name: "Rectangle 4", text: "", left: 54, top: 206, width: 12, height: 12 },
  { name: "TextBox 5", text: "Pemerian obat\nNegara Produsen\nSpesifikasi dan Metode Analisis\nIndikasi\nPosologi\nRute Pemberian", left: 84, top: 196, width: 822, height: 46, fontSize: 14 },
  { name: "TextBox 6", text: "Tantular Deck Studio · 21/30", left: 54, top: 500, width: 300, height: 20, fontSize: 9 }
];

test("estimateTextHeight grows with lines and wrapping, never below one line", () => {
  const one = estimateTextHeight("Nama Pelarut", 822, 14);
  const four = estimateTextHeight("a\nb\nc\nd", 822, 14);
  assert.ok(one >= 14 * 1.25 && one < four);
  assert.ok(four >= 4 * 14 * 1.25);
  const wrapped = estimateTextHeight("x".repeat(400), 200, 14);
  assert.ok(wrapped > four, "a long single paragraph wraps into many lines");
});

test("auditSlideLayout flags the overlapping stack on the live slide and leaves title and footer alone", () => {
  const audit = auditSlideLayout(SLIDE);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.overlaps, [{ a: 2, b: 4 }]);
  assert.deepEqual(audit.stack, [2, 4], "the content stack is the two bullet boxes");
  assert.equal(audit.overflow, false);
  assert.equal(auditSlideLayout([SLIDE[0], SLIDE[5]]).ok, true, "nothing to stack is fine");
});

test("reflowSlideLayout re-stacks boxes top to bottom with the original gap, moves markers, keeps left/width/order", () => {
  const plan = reflowSlideLayout(SLIDE);
  assert.equal(plan.ok, true);
  const box3 = plan.writes.find((w) => w.index === 2);
  const box5 = plan.writes.find((w) => w.index === 4);
  assert.equal(box3.top, 150, "the first box stays where it was");
  assert.ok(box3.height >= estimateTextHeight(SLIDE[2].text, 822, 14));
  assert.equal(box5.top, box3.top + box3.height + plan.gap);
  assert.ok(box5.height >= estimateTextHeight(SLIDE[4].text, 822, 14));
  assert.ok(plan.writes.every((w) => w.left === undefined && w.width === undefined), "left and width never change");
  const marker = plan.writes.find((w) => w.index === 3);
  assert.equal(marker.top, box5.top + 10, "the bullet marker follows its box");
  assert.equal(plan.fontSize, 14, "no shrink needed: the stack fits above the footer");
  assert.ok(box5.top + box5.height <= plan.contentBottom);
});

test("reflow shrinks the body font step by step to a floor before merging boxes", () => {
  const tall = SLIDE.map((s) => (s.name.startsWith("TextBox") && s.fontSize === 14
    ? { ...s, text: Array.from({ length: 10 }, (_, i) => `Baris ${i + 1}`).join("\n") } : s));
  const plan = reflowSlideLayout(tall);
  assert.equal(plan.ok, true);
  assert.ok(plan.fontSize < 14 && plan.fontSize >= 10, `font shrunk to ${plan.fontSize}`);
  const last = plan.writes.filter((w) => w.height !== undefined).at(-1);
  assert.ok(last.top + last.height <= plan.contentBottom, "fits after shrinking");
  assert.ok(plan.writes.every((w) => w.fontSize === undefined || w.fontSize === plan.fontSize));
  // beyond the floor: merge the tail into fewer boxes rather than overflow
  const huge = SLIDE.map((s) => (s.name.startsWith("TextBox") && s.fontSize === 14
    ? { ...s, text: Array.from({ length: 40 }, (_, i) => `Baris ${i + 1}`).join("\n") } : s));
  const merged = reflowSlideLayout(huge);
  assert.equal(merged.fontSize, 10);
  assert.ok(merged.merged >= 1, "tail merged");
  assert.ok(merged.writes.some((w) => w.text !== undefined), "a merge rewrites text");
});

test("describeLayoutRepair reports what moved in the user's terms", () => {
  const plan = reflowSlideLayout(SLIDE);
  assert.match(describeLayoutRepair(plan), /2 kotak teks digeser/);
  assert.match(describeLayoutRepair({ ...plan, fontSize: 12, originalFontSize: 14 }), /ukuran huruf 14 → 12/);
});

function installHost(shapes) {
  const items = shapes.map((sh, i) => ({ id: `sh${i}`, ...sh, load() {}, textFrame: { textRange: { text: sh.text, load() {}, font: { size: sh.fontSize, load() {} } } } }));
  const previous = globalThis.PowerPoint;
  globalThis.PowerPoint = { run: async (fn) => fn({ presentation: { slides: { load() {}, items: [{ id: "270#a", load() {}, shapes: { load() {}, items } }] } }, sync: async () => {} }) };
  return { items, restore() { globalThis.PowerPoint = previous; } };
}

test("applySlideLayout writes only top, height, font size and merged text, verified by read-back", async () => {
  const host = installHost(SLIDE);
  try {
    const plan = reflowSlideLayout(SLIDE);
    const outcome = await applySlideLayout({ slideId: "270" }, plan.writes);
    assert.equal(outcome.updated, true);
    assert.equal(host.items[4].top, plan.writes.find((w) => w.index === 4).top);
    assert.equal(host.items[4].left, 84, "left untouched");
    assert.equal(host.items[0].top, 60, "title untouched");
    assert.equal(host.items[5].top, 500, "footer untouched");
  } finally { host.restore(); }
});

test("executeLayoutTidy: audit → reflow → apply with a report line; a tidy slide is reported as already tidy", async () => {
  const calls = [];
  const hooks = {
    readLiveIds: () => ["270"],
    readSlideShapes: () => ({ found: true, shapes: SLIDE }),
    applySlideLayout: (_t, writes) => { calls.push(writes.length); return { updated: true }; }
  };
  const { lines } = await executeLayoutTidy({ slideId: "270", slideIndex: 1 }, hooks);
  assert.equal(calls.length, 1);
  assert.match(lines[0], /^📐 Slide 1: tata letak dirapikan/);
  const tidy = await executeLayoutTidy({ slideId: "270", slideIndex: 1 }, { ...hooks, readSlideShapes: () => ({ found: true, shapes: [SLIDE[0], SLIDE[2], SLIDE[5]] }) });
  assert.match(tidy.lines[0], /sudah rapi/);
  assert.equal(calls.length, 1, "nothing applied when nothing overlaps");
});

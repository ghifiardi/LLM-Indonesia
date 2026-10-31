// Automatic re-layout ("tata ulang", 2026-09-05): a great-looking slide in the
// slide's OWN design. Content shape is analysed deterministically, a layout
// pattern is chosen, and a geometry plan is produced for the native renderer:
// panels with heading bars, one marker per bullet line, even distribution,
// font size from the line count. Pure — no Office, no model.
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyseSlideContent, choosePattern, planSlideComposition, fontSizeFor, describeComposition
} from "../src/deck/slideComposer.js";

// The live slide 21 after the tidy: title, two bullet boxes of five labels.
const SLIDE21 = [
  { name: "Title 1", text: "Detail Spesifikasi dan Sumber Pelarut", left: 54, top: 60, width: 852, height: 60, fontSize: 28 },
  { name: "Rectangle 2", text: "", left: 54, top: 160, width: 12, height: 12 },
  { name: "TextBox 3", text: "Nama Pelarut\nJumlah dan Satuan\nSumber (Hewan/Manusia)\nProdusen\nNegara Produsen", left: 84, top: 150, width: 822, height: 100, fontSize: 14 },
  { name: "Rectangle 4", text: "", left: 54, top: 270, width: 12, height: 12 },
  { name: "TextBox 5", text: "Pemerian obat\nSpesifikasi dan Metode Analisis\nIndikasi\nPosologi\nRute Pemberian", left: 84, top: 260, width: 822, height: 100, fontSize: 14 },
  { name: "TextBox 6", text: "Tantular Deck Studio · 21/30", left: 54, top: 500, width: 300, height: 20, fontSize: 9 }
];
const STYLE = { accent: "#1F3A5F", accent2: "#A6351D", titleFont: "Segoe UI", titleColor: "#1F3A5F", bodyFont: "Segoe UI", bodyColor: "#222222", bodySize: 14, panel: "#F6F7F9", onAccent: "#FFFFFF" };

test("analyseSlideContent groups the stacked boxes, keeps the title and footer apart, and reads an inline heading", () => {
  const c = analyseSlideContent(SLIDE21);
  assert.equal(c.title, "Detail Spesifikasi dan Sumber Pelarut");
  assert.equal(c.groups.length, 2);
  assert.deepEqual(c.groups[0].items, ["Nama Pelarut", "Jumlah dan Satuan", "Sumber (Hewan/Manusia)", "Produsen", "Negara Produsen"]);
  assert.equal(c.groups[0].heading, "");
  assert.deepEqual(c.deleteIndexes, [1, 2, 3, 4], "old boxes and their markers are what gets replaced");
  assert.equal(c.box.top, 150);
  assert.ok(c.box.bottom <= 488 && c.box.left === 54 && c.box.right === 906);
  const withHeading = analyseSlideContent([SLIDE21[0], { name: "TextBox 2", text: "Sumber pelarut\nNama pelarut yang digunakan dalam sediaan akhir\nProdusen dan negara asal produsen pelarut", left: 84, top: 150, width: 822, height: 100, fontSize: 14 }, SLIDE21[5]]);
  assert.equal(withHeading.groups[0].heading, "Sumber pelarut");
  assert.equal(withHeading.groups[0].items.length, 2);
});

test("choosePattern: one short list ⇒ stack; two or three groups ⇒ panels; four to six ⇒ panels in two rows; prose ⇒ prose", () => {
  const items = (n) => Array.from({ length: n }, (_, i) => `Item ${i + 1}`);
  assert.equal(choosePattern([{ items: items(5) }]), "stack");
  assert.equal(choosePattern([{ items: items(3) }, { items: items(4) }]), "panels");
  assert.equal(choosePattern([{ items: items(2) }, { items: items(2) }, { items: items(2) }]), "panels");
  assert.equal(choosePattern(Array.from({ length: 5 }, () => ({ items: items(2) }))), "panels-2rows");
  assert.equal(choosePattern([{ items: ["x ".repeat(120), "y ".repeat(110)] }]), "prose");
  assert.equal(choosePattern([{ items: items(12) }]), "panels", "a long single list is split into two panels");
});

test("fontSizeFor follows the line count with a floor", () => {
  assert.equal(fontSizeFor(3), 18);
  assert.equal(fontSizeFor(7), 16);
  assert.equal(fontSizeFor(10), 14);
  assert.equal(fontSizeFor(20), 12);
});

test("panels plan: one panel per group filling the content box, heading bar, one marker per item, even spacing", () => {
  const content = analyseSlideContent(SLIDE21);
  const plan = planSlideComposition({ content, pattern: "panels", style: STYLE, headings: ["Sumber pelarut", "Spesifikasi obat"] });
  const panels = plan.filter((s) => s.kind === "panel");
  assert.equal(panels.length, 2);
  assert.equal(panels[0].left, 54);
  assert.ok(Math.abs(panels[1].left + panels[1].width - 906) < 1, "row fills the content width");
  assert.equal(panels[0].top, 150);
  assert.ok(panels[0].top + panels[0].height <= 488);
  const bars = plan.filter((s) => s.kind === "bar");
  assert.deepEqual(bars.map((b) => b.fill), ["#1F3A5F", "#A6351D"], "bars alternate the slide's two accents");
  const headings = plan.filter((s) => s.kind === "heading");
  assert.deepEqual(headings.map((h) => h.text), ["Sumber pelarut", "Spesifikasi obat"]);
  assert.equal(headings[0].font.color, "#FFFFFF");
  const markers = plan.filter((s) => s.kind === "marker");
  const lines = plan.filter((s) => s.kind === "line");
  assert.equal(markers.length, 10);
  assert.equal(lines.length, 10);
  const firstPanelLines = lines.filter((l) => l.left > panels[0].left && l.left < panels[0].left + panels[0].width);
  const gaps = firstPanelLines.slice(1).map((l, i) => l.top - firstPanelLines[i].top);
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) < 0.5), "even vertical distribution");
  assert.ok(lines.every((l) => l.font.size >= 16 && l.font.name === "Segoe UI"), "fitted size, never below 16 for five short lines");
  assert.ok(markers.every((m) => m.fill === "#1F3A5F" || m.fill === "#A6351D"));
});

test("stack plan: a single list spans the content area with one marker per line, larger type", () => {
  const content = analyseSlideContent([SLIDE21[0], SLIDE21[1], SLIDE21[2], SLIDE21[5]]);
  const plan = planSlideComposition({ content, pattern: "stack", style: STYLE, headings: [] });
  const lines = plan.filter((s) => s.kind === "line");
  assert.equal(lines.length, 5);
  assert.equal(lines[0].top, 150);
  assert.ok(lines.at(-1).top + lines.at(-1).height <= 488);
  assert.ok(lines.every((l) => l.font.size === 24), "five short lines fit at the largest size");
  assert.equal(plan.filter((s) => s.kind === "marker").length, 5);
  assert.equal(plan.filter((s) => s.kind === "panel").length, 0);
});

test("two-row panels and prose patterns keep everything inside the content box", () => {
  const groups = Array.from({ length: 5 }, (_, g) => ({ heading: "", items: [`A${g}`, `B${g}`] }));
  const content = { title: "T", groups, box: { left: 54, top: 150, right: 906, bottom: 488 }, deleteIndexes: [] };
  const plan = planSlideComposition({ content, pattern: "panels-2rows", style: STYLE, headings: ["1", "2", "3", "4", "5"] });
  const panels = plan.filter((s) => s.kind === "panel");
  assert.equal(panels.length, 5);
  assert.equal(new Set(panels.map((p) => p.top)).size, 2);
  assert.ok(panels.every((p) => p.top + p.height <= 488 && p.left >= 54 && p.left + p.width <= 906.5));
  const prose = planSlideComposition({ content: { ...content, groups: [{ heading: "", items: ["x ".repeat(200)] }] }, pattern: "prose", style: STYLE, headings: [] });
  const text = prose.find((s) => s.kind === "text");
  assert.ok(text && text.top + text.height <= 488 && text.font.size >= 12);
});

test("describeComposition names the pattern in the user's terms", () => {
  assert.match(describeComposition("panels", 2), /2 panel/);
  assert.match(describeComposition("stack", 1), /daftar/);
});

// --- live host36 (2026-09-05): six one-sentence boxes are a LIST -------------
const SLOTTED = [
  { name: "Title 1", text: "Komponen Data Pendaftaran Obat", left: 54, top: 60, width: 852, height: 60, fontSize: 28 },
  { name: "Rectangle 90", text: "", left: 60, top: 150, width: 400, height: 300 },
  { name: "Rectangle 91", text: "", left: 60, top: 150, width: 400, height: 34 },
  { name: "TextBox 3", text: "Format pendaftaran mencakup Tanggal Penerimaan, Kode Evaluasi, dan Subkode Evaluasi (dd/mm/yyyy).", left: 84, top: 150, width: 822, height: 40, fontSize: 14 },
  { name: "TextBox 4", text: "Uraian obat meliputi Nomor urut (#), Kategori registrasi, Jenis obat (*), serta status Baru atau Generik.", left: 84, top: 196, width: 822, height: 40, fontSize: 14 },
  { name: "TextBox 5", text: "Klasifikasi Produk Biologi terdiri dari Status Produk Tunggal, Produk Kombinasi, atau Produk Combipack.", left: 84, top: 242, width: 822, height: 40, fontSize: 14 },
  { name: "TextBox 6", text: "Informasi Pendaftar lengkap mencakup Nama dan Alamat (Nama jalan, nomor, Kota, Negara).", left: 84, top: 288, width: 822, height: 40, fontSize: 14 },
  { name: "TextBox 7", text: "Detail Surat-menyurat mencatat alamat spesifik pendaftar (Nama jalan, nomor, Kota, Negara).", left: 84, top: 334, width: 822, height: 40, fontSize: 14 },
  { name: "TextBox 8", text: "Status produksi (*) dicatat termasuk kategori Produksi dalam negeri.", left: 84, top: 380, width: 822, height: 40, fontSize: 14 },
  { name: "Picture 12", text: "", left: 700, top: 150, width: 200, height: 150 },
  { name: "TextBox 9", text: "Tantular Deck Studio · 20/30", left: 54, top: 500, width: 300, height: 20, fontSize: 9 }
];

test("same-column single-line boxes merge into ONE list group, and long single sentences are bullets, not prose", () => {
  const c = analyseSlideContent(SLOTTED);
  assert.equal(c.groups.length, 1);
  assert.equal(c.groups[0].items.length, 6);
  assert.equal(choosePattern(c.groups), "stack");
});

test("with includeDecorations, stray filled rectangles in the content area are replaced too; pictures never are", () => {
  const plain = analyseSlideContent(SLOTTED);
  assert.ok(!plain.deleteIndexes.includes(1) && !plain.deleteIndexes.includes(2), "by default only text boxes and markers");
  const studio = analyseSlideContent(SLOTTED, { includeDecorations: true });
  assert.ok(studio.deleteIndexes.includes(1) && studio.deleteIndexes.includes(2), "leftover panel and bar are removed");
  assert.ok(!studio.deleteIndexes.includes(10), "the picture stays");
  assert.ok(!studio.deleteIndexes.includes(0) && !studio.deleteIndexes.includes(11), "title and footer stay");
});

// --- proportional type (live host37, 2026-09-05) ------------------------------
// Six bullets at 16 pt left a third of the slide empty. The size must be the
// largest that fits the box once wrapping is accounted for.
import { fitFontSize } from "../src/deck/slideComposer.js";

test("fitFontSize picks the largest size whose wrapped lines fit the box", () => {
  const six = Array.from({ length: 6 }, (_, i) => `Kalimat panjang nomor ${i + 1} yang mencakup beberapa keterangan sekaligus dan cukup panjang untuk membungkus.`);
  const size = fitFontSize(six, 822, 338);
  assert.ok(size >= 18 && size <= 22, `got ${size}`);
  assert.equal(fitFontSize(["a", "b", "c"], 822, 338), 24, "three short lines take the largest size");
  assert.equal(fitFontSize(Array.from({ length: 16 }, () => "x ".repeat(60)), 822, 338), 12, "never below the floor");
});

test("the stack plan uses the fitted size and gives wrapped items their own height, still inside the box", () => {
  const six = Array.from({ length: 6 }, (_, i) => `Kalimat panjang nomor ${i + 1} yang mencakup beberapa keterangan sekaligus dan cukup panjang untuk membungkus.`);
  const content = { title: "T", groups: [{ heading: "", items: six }], box: { left: 54, top: 150, right: 906, bottom: 488 }, deleteIndexes: [] };
  const plan = planSlideComposition({ content, pattern: "stack", style: STYLE, headings: [] });
  const lines = plan.filter((s) => s.kind === "line");
  assert.ok(lines[0].font.size >= 18, `size ${lines[0].font.size}`);
  assert.ok(lines.every((l) => l.height >= l.font.size * 1.3 * 2 - 1), "wrapped items get two lines of height");
  assert.ok(lines.at(-1).top + lines.at(-1).height <= 488.5);
});

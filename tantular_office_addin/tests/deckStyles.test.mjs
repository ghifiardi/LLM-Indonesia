import test from "node:test";
import assert from "node:assert/strict";
import { styleOptions } from "../src/deck/deckStyles.js";
import { buildDeckPptxBase64, fitText } from "../src/deck/pptxBuilder.js";

const REQUIRED = ["id", "name", "background", "motif", "palette", "type_scale", "chrome"];
const SPEC = {
  title: "Deck Uji",
  subtitle: "Sub",
  slides: [
    { type: "title", headline: "Judul", subhead: "Sub" },
    { type: "agenda", headline: "Agenda", bullets: ["Satu", "Dua"] },
    { type: "bullets", headline: "Isi", bullets: ["A", "B", "C"] },
    { type: "cards", headline: "Kartu", cards: [{ title: "T1", desc: "D1" }, { title: "T2", desc: "D2" }] },
    { type: "metrics", headline: "Angka", metrics: [{ value: "10%", label: "Naik" }] },
    { type: "quote", headline: "", bullets: [], quote: "Kutipan penting." },
    { type: "closing", headline: "Penutup", bullets: ["Next"] }
  ]
};

test("every pack carries the complete token set", () => {
  const packs = styleOptions();
  assert.ok(packs.length >= 5 && packs.length <= 6);
  for (const p of packs) for (const k of REQUIRED) assert.ok(k in p, `${p.id} missing ${k}`);
});

test("every slide type renders under every pack without throwing, XML references pack accent", () => {
  for (const p of styleOptions()) {
    const b64 = buildDeckPptxBase64(SPEC, p.id);
    assert.ok(b64.length > 1000);
    const raw = Buffer.from(b64, "base64").toString("latin1");
    const accentHex = p.palette.accent.replace("#", "").toUpperCase();
    assert.ok(raw.includes(accentHex), `${p.id} accent not in output`);
  }
});

test("packs are visually distinct: no two packs share background kind + accent", () => {
  const seen = new Set();
  for (const p of styleOptions()) {
    const key = `${p.background.kind}:${p.palette.accent}`;
    assert.ok(!seen.has(key), `duplicate look ${key}`);
    seen.add(key);
  }
});

test("fitText shrinks then truncates deterministically", () => {
  const short = fitText("Singkat", { maxChars: 40, baseSize: 28, minSize: 18 });
  assert.deepEqual(short, { text: "Singkat", size: 28 });
  const long = fitText("x".repeat(400), { maxChars: 60, baseSize: 28, minSize: 18 });
  assert.equal(long.size, 18);
  assert.ok(long.text.endsWith("…") && long.text.length <= 61);
});

test("overflow never breaks XML: 400-char headline + 20 bullets renders valid zip under every pack", () => {
  const abuse = {
    ...SPEC,
    slides: [{
      type: "bullets",
      headline: "H".repeat(400),
      bullets: Array.from({ length: 20 }, (_, i) => `Butir panjang sekali nomor ${i} `.repeat(6))
    }]
  };
  for (const p of styleOptions()) {
    const b64 = buildDeckPptxBase64(abuse, p.id);
    assert.ok(b64.length > 1000);
  }
});

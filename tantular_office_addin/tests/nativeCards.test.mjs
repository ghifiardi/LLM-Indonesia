// Native visual cards: "Buat slide lebih visual" draws card panels ON the
// user's own slide with the PowerPoint shape API, so master, background,
// title, footer, fonts and colours are the deck's. This ADDS a visual layout;
// the in-place text path (planInPlaceWrites/writeSlideShapeTexts) is untouched.
// Conditions from the design review, each pinned here:
//  1. empty font/colour reads fall back explicitly and the wording says so;
//  2. body identification is conservative: ambiguous ⇒ refuse, never guess-and-delete;
//  3. feature-detect each method, not just the API version;
//  4. create → sync → verify → delete LAST; failed create removes the new shapes;
//  6. text is fitted to its panel.
import test from "node:test";
import assert from "node:assert/strict";
import { planNativeCards, resolveCardStyle, describeCardStyle } from "../src/deck/nativeCards.js";
import { planNativeCardTargets, buildNativeCardsOnSlide, readSlideDesign } from "../src/officeClient.js";

const BOX = { left: 60, top: 150, width: 800, height: 300 };
const CARDS = [
  { title: "Traceable Reasoning", lines: ["Tie every claim to an exhibit."] },
  { title: "Evidence vs. Claim", lines: ["Separate what sources establish from what companies assert."] },
  { title: "Gap Handling", lines: ["Name what is missing.", "Say what you would do instead."] }
];
const STYLE = { accent: "#1F5F4A", titleFont: "Georgia", titleColor: "#1F5F4A", bodyFont: "Segoe UI", bodyColor: "#222222", bodySize: 12 };

test("planNativeCards lays panels side by side inside the body box, each with bar, title and text", () => {
  const plan = planNativeCards({ box: BOX, cards: CARDS, style: STYLE });
  const panels = plan.filter((s) => s.kind === "panel");
  assert.equal(panels.length, 3);
  const gap = panels[1].left - (panels[0].left + panels[0].width);
  assert.ok(gap > 0 && gap < 40, "panels are separated by a small gap");
  assert.equal(panels[0].left, BOX.left);
  assert.ok(Math.abs(panels[2].left + panels[2].width - (BOX.left + BOX.width)) < 1, "row fills the box width");
  assert.ok(panels.every((p) => p.top === BOX.top && p.height === BOX.height));
  for (const kind of ["bar", "title", "text"]) assert.equal(plan.filter((s) => s.kind === kind).length, 3, kind);
  const [t] = plan.filter((s) => s.kind === "title");
  assert.equal(t.font.name, "Georgia"); assert.equal(t.font.color, "#1F5F4A"); assert.equal(t.font.bold, true);
  const [b] = plan.filter((s) => s.kind === "bar");
  assert.equal(b.fill, "#1F5F4A");
  const [x] = plan.filter((s) => s.kind === "text");
  assert.equal(x.text, "Tie every claim to an exhibit.");
  assert.equal(plan.filter((s) => s.kind === "text")[2].text, "Name what is missing.\nSay what you would do instead.");
});

test("planNativeCards wraps to two rows for four to six cards and fits long text to the panel", () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ title: `C${i}`, lines: ["x ".repeat(400)] }));
  const plan = planNativeCards({ box: BOX, cards: six, style: STYLE });
  const panels = plan.filter((s) => s.kind === "panel");
  assert.equal(new Set(panels.map((p) => p.top)).size, 2, "two rows");
  const text = plan.find((s) => s.kind === "text");
  assert.ok(text.font.size < STYLE.bodySize, "long text gets a smaller size");
  assert.ok(text.text.length < 800, "and is trimmed rather than overflowing");
});

test("resolveCardStyle uses the slide's fonts and colours when read, and explicit fallbacks when the reads are empty", () => {
  const full = resolveCardStyle({ title: { name: "Georgia", color: "#1F5F4A", size: 32 }, body: { name: "Segoe UI", color: "#222222", size: 14 }, headingColor: "#A6351D" });
  assert.deepEqual(full, { accent: "#A6351D", titleFont: "Georgia", titleColor: "#1F5F4A", bodyFont: "Segoe UI", bodyColor: "#222222", bodySize: 14, fallbacks: [] });
  const empty = resolveCardStyle({ title: { name: "", color: "", size: 0 }, body: { name: "", color: "", size: 0 }, headingColor: "" });
  assert.equal(empty.accent, "#1F3A5F");
  assert.equal(empty.titleFont, "Calibri");
  assert.deepEqual(empty.fallbacks.sort(), ["accent", "bodyColor", "bodyFont", "bodySize", "titleColor", "titleFont"]);
  // partial: title colour readable, heading colour not ⇒ accent = title colour, no accent fallback
  const partial = resolveCardStyle({ title: { name: "Georgia", color: "#1F5F4A", size: 32 }, body: { name: "", color: "", size: 0 }, headingColor: "" });
  assert.equal(partial.accent, "#1F5F4A");
  assert.ok(!partial.fallbacks.includes("accent"));
  assert.match(describeCardStyle(full), /warna dan font mengikuti slide ini/);
  assert.match(describeCardStyle(empty), /tidak terbaca/);
});

// --- Office side (mocked host) ----------------------------------------------
const TITLE = { name: "Title 1", text: "How This Is Assessed", left: 60, top: 60, width: 800, height: 60 };
const BODY = { name: "Content Placeholder 2", text: "First.\rA claim tied to an exhibit.\rSecond.\rDistinguish sources.", left: 60, top: 150, width: 800, height: 300 };
const FOOTER = { name: "TextBox 9", text: "Sahabat-AI · MBAS6305", left: 60, top: 480, width: 500, height: 20 };
const PICTURE = { name: "Picture 5", text: "", left: 700, top: 150, width: 160, height: 120 };

test("planNativeCardTargets: one body ⇒ its box and index; decorative/non-text shapes are never targets", () => {
  const t = planNativeCardTargets([TITLE, BODY, FOOTER, PICTURE]);
  assert.deepEqual(t, { ok: true, box: { left: 60, top: 150, width: 800, height: 300 }, deleteIndexes: [1] });
});

test("planNativeCardTargets: two column bodies with two headings ⇒ union box, bodies + headings deleted", () => {
  const H1 = { name: "TextBox 2", text: "Read it twice", left: 60, top: 150, width: 380, height: 30 };
  const B1 = { name: "TextBox 3", text: "a\rb", left: 60, top: 190, width: 380, height: 260 };
  const H2 = { name: "TextBox 4", text: "Work with the gap", left: 480, top: 150, width: 380, height: 30 };
  const B2 = { name: "TextBox 5", text: "c\rd", left: 480, top: 190, width: 380, height: 260 };
  const t = planNativeCardTargets([TITLE, H1, B1, H2, B2, FOOTER]);
  assert.equal(t.ok, true);
  assert.deepEqual(t.box, { left: 60, top: 150, width: 800, height: 300 });
  assert.deepEqual(t.deleteIndexes, [1, 2, 3, 4]);
});

test("planNativeCardTargets refuses when the body mapping is ambiguous — no guess, no delete", () => {
  // three single-line text shapes but two bodies: cannot tell headings from captions
  const H1 = { name: "TextBox 2", text: "Read it twice", left: 60, top: 150, width: 380, height: 30 };
  const B1 = { name: "TextBox 3", text: "a\rb", left: 60, top: 190, width: 380, height: 260 };
  const CAP = { name: "TextBox 6", text: "Source: internal analysis", left: 60, top: 460, width: 380, height: 20 };
  const H2 = { name: "TextBox 4", text: "Work with the gap", left: 480, top: 150, width: 380, height: 30 };
  const B2 = { name: "TextBox 5", text: "c\rd", left: 480, top: 190, width: 380, height: 260 };
  assert.equal(planNativeCardTargets([TITLE, H1, B1, CAP, H2, B2]).ok, false);
  assert.match(planNativeCardTargets([TITLE, H1, B1, CAP, H2, B2]).reason, /tidak yakin/);
  // no body at all
  assert.equal(planNativeCardTargets([TITLE, FOOTER]).ok, false);
  // a body without geometry cannot be replaced safely
  assert.equal(planNativeCardTargets([TITLE, { ...BODY, width: 0, height: 0 }]).ok, false);
});

function installHost({ slides, missing = [], failOn = null }) {
  const created = [];
  const deleted = [];
  const log = [];
  const built = slides.map((s) => {
    const items = s.shapes.map((sh, i) => ({
      id: `sh${i}`, name: sh.name, left: sh.left, top: sh.top, width: sh.width, height: sh.height, load() {},
      fill: { foregroundColor: sh.fillColor || "", load() {} },
      textFrame: { textRange: { text: sh.text, load() {}, font: { name: sh.font?.name ?? "", color: sh.font?.color ?? "", size: sh.font?.size ?? 0, load() {} } } },
      delete() { log.push(`delete:${this.id}`); deleted.push(this.id); const at = items.indexOf(this); if (at >= 0) items.splice(at, 1); }
    }));
    const shapes = {
      items, load() {},
      addGeometricShape(type, opts) {
        if (failOn === "create" && created.length >= 2) throw new Error("host refused shape");
        const sh = { id: `new${created.length}`, type, ...opts, fill: { setSolidColor(c) { sh.fillColor = c; } }, lineFormat: { visible: true }, textFrame: { textRange: { text: "", font: {} } }, load() {}, delete() { log.push(`delete:${sh.id}`); const at = items.indexOf(sh); if (at >= 0) items.splice(at, 1); } };
        items.push(sh); created.push(sh); log.push(`create:${sh.id}`); return sh;
      },
      addTextBox(text, opts) {
        const sh = { id: `new${created.length}`, text, ...opts, fill: { setSolidColor(c) { sh.fillColor = c; } }, textFrame: { textRange: { text, font: {} }, wordWrap: true }, load() {}, delete() { log.push(`delete:${sh.id}`); const at = items.indexOf(sh); if (at >= 0) items.splice(at, 1); } };
        items.push(sh); created.push(sh); log.push(`create:${sh.id}`); return sh;
      }
    };
    for (const m of missing) delete shapes[m];
    return { id: s.id, load() {}, shapes };
  });
  const previous = globalThis.PowerPoint;
  const prevOffice = globalThis.Office;
  globalThis.Office = { context: { requirements: { isSetSupported: () => true } } };
  globalThis.PowerPoint = { run: async (fn) => fn({ presentation: { slides: { load() {}, items: built } }, sync: async () => { log.push("sync"); } }) };
  return { built, created, deleted, log, restore() { globalThis.PowerPoint = previous; globalThis.Office = prevOffice; } };
}

const SLIDE = { id: "280#a", shapes: [
  { ...TITLE, font: { name: "Georgia", color: "#1F5F4A", size: 32 } },
  { ...BODY, font: { name: "Segoe UI", color: "", size: 14 } },
  FOOTER
] };

test("readSlideDesign returns geometry, fonts (empty when unreadable) and per-method feature flags", async () => {
  const host = installHost({ slides: [SLIDE], missing: ["addTextBox"] });
  try {
    const d = await readSlideDesign({ slideId: "280" });
    assert.equal(d.found, true);
    assert.equal(d.shapes[1].width, 800);
    assert.deepEqual(d.title, { name: "Georgia", color: "#1F5F4A", size: 32 });
    assert.deepEqual(d.body, { name: "Segoe UI", color: "", size: 14 });
    assert.deepEqual(d.api, { addGeometricShape: true, addTextBox: false });
  } finally { host.restore(); }
});

test("buildNativeCardsOnSlide: create → sync → verify → delete old bodies LAST", async () => {
  const host = installHost({ slides: [SLIDE] });
  try {
    const plan = planNativeCards({ box: BOX, cards: CARDS, style: STYLE });
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, plan, [1]);
    assert.deepEqual(outcome, { updated: true, created: plan.length });
    const firstDelete = host.log.indexOf("delete:sh1");
    const lastCreate = host.log.lastIndexOf(`create:new${plan.length - 1}`);
    assert.ok(lastCreate < firstDelete, "every new shape exists before any old body is deleted");
    assert.ok(host.log.slice(lastCreate, firstDelete).includes("sync"), "a sync (and verify) sits between create and delete");
    assert.deepEqual(host.deleted, ["sh1"]);
    assert.ok(host.built[0].shapes.items.some((s) => s.id === "sh0"), "title kept");
    assert.ok(host.built[0].shapes.items.some((s) => s.id === "sh2"), "footer kept");
    const bar = host.created.find((s) => s.fillColor === "#1F5F4A");
    assert.ok(bar, "bar fill applied through fill.setSolidColor");
  } finally { host.restore(); }
});

test("buildNativeCardsOnSlide: a failed create removes the shapes it made and deletes nothing old", async () => {
  const host = installHost({ slides: [SLIDE], failOn: "create" });
  try {
    const plan = planNativeCards({ box: BOX, cards: CARDS, style: STYLE });
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, plan, [1]);
    assert.equal(outcome.updated, false);
    assert.match(outcome.reason, /host refused shape/);
    assert.deepEqual(host.deleted, []);
    assert.ok(!host.built[0].shapes.items.some((s) => String(s.id).startsWith("new")), "partial shapes cleaned up");
  } finally { host.restore(); }
});

test("buildNativeCardsOnSlide refuses up front when a required method is missing", async () => {
  const host = installHost({ slides: [SLIDE], missing: ["addGeometricShape"] });
  try {
    const plan = planNativeCards({ box: BOX, cards: CARDS, style: STYLE });
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, plan, [1]);
    assert.equal(outcome.updated, false);
    assert.match(outcome.reason, /addGeometricShape/);
    assert.ok(!host.log.some((l) => /^(create|delete):/.test(l)), "nothing created or deleted");
  } finally { host.restore(); }
});

// --- composer kinds (2026-09-05): marker, heading, line -------------------------
test("buildNativeCardsOnSlide renders marker squares as rectangles and heading/line kinds as text boxes", async () => {
  const host = installHost({ slides: [SLIDE] });
  try {
    const plan = [
      { kind: "panel", left: 60, top: 150, width: 400, height: 300, fill: "#F6F7F9", line: false },
      { kind: "bar", left: 60, top: 150, width: 400, height: 34, fill: "#1F5F4A", line: false },
      { kind: "heading", left: 74, top: 157, width: 372, height: 22, text: "Sumber pelarut", font: { name: "Georgia", color: "#FFFFFF", size: 16, bold: true } },
      { kind: "marker", left: 74, top: 205, width: 10, height: 10, fill: "#1F5F4A", line: false },
      { kind: "line", left: 96, top: 198, width: 350, height: 22, text: "Nama Pelarut", font: { name: "Segoe UI", color: "#222222", size: 16, bold: false } }
    ];
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, plan, [1]);
    assert.deepEqual(outcome, { updated: true, created: 5 });
    const rects = host.created.filter((s) => s.type === "Rectangle");
    assert.equal(rects.length, 3, "panel, bar and marker are rectangles");
    assert.ok(rects.some((r) => r.fillColor === "#1F5F4A" && r.width === 10));
    const boxes = host.created.filter((s) => s.text !== undefined);
    assert.deepEqual(boxes.map((b) => b.text), ["Sumber pelarut", "Nama Pelarut"]);
  } finally { host.restore(); }
});

test("readSlideDesign reports the accent fills of small marker shapes", async () => {
  const host = installHost({ slides: [{ id: "281#b", shapes: [
    { ...TITLE, font: { name: "Georgia", color: "#1F5F4A", size: 32 } },
    { name: "Rectangle 2", text: "", left: 54, top: 160, width: 12, height: 12, fillColor: "#1F3A5F" },
    { ...BODY, font: { name: "Segoe UI", color: "", size: 14 } },
    { name: "Rectangle 4", text: "", left: 54, top: 260, width: 12, height: 12, fillColor: "#A6351D" }
  ] }] });
  try {
    const d = await readSlideDesign({ slideId: "281" });
    assert.deepEqual(d.accents, ["#1F3A5F", "#A6351D"]);
  } finally { host.restore(); }
});

// --- Mac host reality (live, 2026-09-05): InvalidArgument mid-batch -----------
// A just-added shape's text frame is not addressable until after a sync on
// this host, so font writes queued in the creation batch threw, the fills had
// already landed, and the one-shot cleanup threw too — leaving a panel and a
// bar over the user's content. Rules: create → sync → style → sync; a style
// failure retries in smaller batches, then removes everything it created; a
// cleanup whose sync throws retries by id on a fresh read.
function installStrictHost({ slides, styleFailsForever = false, cleanupThrowsOnce = false }) {
  const created = [];
  const log = [];
  let syncCount = 0;
  let cleanupThrown = false;
  const built = slides.map((s) => {
    const pending = { fontWritesOnUnsynced: 0, loadOnUnsynced: 0, styleQueued: 0, deletesQueued: [] };
    const items = s.shapes.map((sh, i) => ({
      id: `sh${i}`, name: sh.name, left: sh.left, top: sh.top, width: sh.width, height: sh.height, load() {},
      textFrame: { textRange: { text: sh.text, load() {}, font: {} } },
      delete() { log.push(`delete:${this.id}`); pending.deletesQueued.push(this); }
    }));
    const mk = (kind, opts, text) => {
      const sh = { id: `new${created.length}`, kind, ...opts, synced: false, fillColor: undefined,
        load() { if (!sh.synced) pending.loadOnUnsynced += 1; },
        fill: { setSolidColor(c) { sh.fillColor = c; } },
        lineFormat: {},
        delete() { log.push(`delete:${sh.id}`); pending.deletesQueued.push(sh); } };
      // A queued style write that has not been synced yet; like the real
      // host, a failed sync discards the queue, so a later cleanup sync passes.
      const font = new Proxy({}, { set(t, k, v) { t[k] = v; pending.styleQueued += 1; return true; } });
      sh.textFrame = { textRange: { text: text ?? "", get font() { if (!sh.synced) pending.fontWritesOnUnsynced += 1; return font; } } };
      items.push(sh); created.push(sh); log.push(`create:${sh.id}`); return sh;
    };
    const shapes = {
      items, load() {},
      addGeometricShape: (type, opts) => mk(type, opts),
      addTextBox: (text, opts) => mk("TextBox", opts, text)
    };
    shapes.__pending = pending;
    return { id: s.id, load() {}, shapes };
  });
  const previous = globalThis.PowerPoint;
  const prevOffice = globalThis.Office;
  globalThis.Office = { context: { requirements: { isSetSupported: () => true } } };
  globalThis.PowerPoint = { run: async (fn) => fn({
    presentation: { slides: { load() {}, items: built } },
    sync: async () => {
      syncCount += 1; log.push("sync");
      const p = built[0].shapes.__pending;
      const items = built[0].shapes.items;
      if (p.deletesQueued.length && cleanupThrowsOnce && !cleanupThrown) { cleanupThrown = true; p.deletesQueued = []; throw new Error("InvalidArgument"); }
      if (p.fontWritesOnUnsynced || p.loadOnUnsynced) { p.fontWritesOnUnsynced = 0; p.loadOnUnsynced = 0; p.styleQueued = 0; p.deletesQueued = []; throw new Error("InvalidArgument"); }
      if (styleFailsForever && p.styleQueued) { p.styleQueued = 0; p.deletesQueued = []; throw new Error("InvalidArgument"); }
      p.styleQueued = 0;
      for (const sh of p.deletesQueued) { const at = items.indexOf(sh); if (at >= 0) items.splice(at, 1); }
      p.deletesQueued = [];
      for (const c of created) c.synced = true;
    }
  }) };
  return { built, created, log, restore() { globalThis.PowerPoint = previous; globalThis.Office = prevOffice; }, get syncCount() { return syncCount; } };
}

const PLAN = () => planNativeCards({ box: BOX, cards: CARDS, style: STYLE });

test("styling is applied only AFTER the creation sync, so a strict host accepts the build", async () => {
  const host = installStrictHost({ slides: [SLIDE] });
  try {
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, PLAN(), [1]);
    assert.equal(outcome.updated, true);
    assert.ok(host.built[0].shapes.items.every((s) => s.id !== "sh1"), "old body deleted last");
    assert.ok(host.created.every((c) => c.synced));
    const firstSync = host.log.indexOf("sync");
    const firstDelete = host.log.findIndex((l) => l === "delete:sh1");
    assert.ok(firstSync < firstDelete);
  } finally { host.restore(); }
});

test("when styling keeps failing, every created shape is removed and the old content is untouched", async () => {
  const host = installStrictHost({ slides: [SLIDE], styleFailsForever: true });
  try {
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, PLAN(), [1]);
    assert.equal(outcome.updated, false);
    assert.match(outcome.reason, /InvalidArgument/);
    assert.ok(!host.built[0].shapes.items.some((s) => String(s.id).startsWith("new")), "no partial shapes left");
    assert.ok(host.built[0].shapes.items.some((s) => s.id === "sh1"), "old body still there");
  } finally { host.restore(); }
});

test("a cleanup whose sync throws is retried until the created shapes are really gone", async () => {
  const host = installStrictHost({ slides: [SLIDE], styleFailsForever: true, cleanupThrowsOnce: true });
  try {
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, PLAN(), [1]);
    assert.equal(outcome.updated, false);
    assert.ok(!host.built[0].shapes.items.some((s) => String(s.id).startsWith("new")), "no partial shapes left after retry");
  } finally { host.restore(); }
});

test("creation is synced BEFORE any load on the new shapes (live host35: load on an unsynced shape is InvalidArgument)", async () => {
  const host = installStrictHost({ slides: [SLIDE] });
  try {
    const outcome = await buildNativeCardsOnSlide({ slideId: "280" }, PLAN(), [1]);
    assert.equal(outcome.updated, true, outcome.reason);
  } finally { host.restore(); }
});

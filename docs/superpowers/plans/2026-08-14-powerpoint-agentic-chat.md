# Agentic PowerPoint Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PowerPoint the chat pane Word and Excel already have — whole-deck context, plus improve/replace/add slide actions and a confirm-gated delete.

**Architecture:** One model call per turn returns `{reply, actions[]}`. A pure sanitizer is the only thing that knows the action schema; a pure orderer decides execution sequence; an executor resolves every target to a slide id from an immutable turn snapshot and applies changes through the existing `pptxBuilder` → `replaceSlideInActivePresentation` path. `src/chat/pptTools.js` owns all Office access and pure logic; `src/chat/pptChat.js` owns the pane and never touches an Office API.

**Tech Stack:** Vanilla ES modules, no build step. Tests are `node --test tests/*.test.mjs`. Office.js / PowerPoint JS API. Local model via `runTantular`.

**Spec:** `docs/superpowers/specs/2026-08-14-powerpoint-agentic-chat-design.md`

## Global Constraints

- **ES modules only.** No TypeScript, no JSX, no build step. Files are served from `src/` as-is.
- **All user-facing strings in Bahasa Indonesia.** Error messages, chips, confirmations, rejections.
- **`src/chat/pptTools.js` must never import from `src/taskpane.js`.** Allowed imports: `../officeClient.js`, `../deck/*`, `../tantularClient.js`. No cycles.
- **`src/chat/pptChat.js` must contain no `Office` or `PowerPoint` reference.** All host access goes through `pptTools.js`. It may read the DOM.
- **Host API floor:** `getSelectedSlides()` and `setSelectedSlides()` (PowerPointApi 1.5) are NOT available. `presentation.slides`, `insertSlidesFromBase64`, and `Slide.delete()` are. `Shape.textFrame` (1.4) is unverified until Task 7.
- **Never report a false success.** Every mutation verifies its outcome before reporting `✅`.
- **`afterIndex: 0` is rejected in v1.** Valid range is `1..slideCount`.
- **Slide type validation order:** drop invalid nested entries FIRST, then reject the slide if its required array is now empty.
- **Run `npm test` before every commit.** All existing tests must stay green.

---

### Task 1: Move pure pptx helpers out of taskpane.js

Pure refactor, no behavior change. `extractPptxSlides` and `extractRequestedSlideIndex` are private helpers in `taskpane.js` that the chat also needs. They have never had tests.

**Files:**
- Create: `src/chat/pptTools.js`
- Create: `tests/pptTools.test.mjs`
- Modify: `src/taskpane.js:1266-1289` (delete both functions), `src/taskpane.js:1-30` (add import)

**Interfaces:**
- Consumes: nothing.
- Produces: `extractPptxSlides(text) → [{ label, index, id, text }]`, `extractRequestedSlideIndex(text) → number` (0 when absent).

- [ ] **Step 1: Write the failing test**

Create `tests/pptTools.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractPptxSlides, extractRequestedSlideIndex } from "../src/chat/pptTools.js";

test("extractRequestedSlideIndex finds slide numbers in Indonesian and English", () => {
  assert.equal(extractRequestedSlideIndex("perbaiki slide 4"), 4);
  assert.equal(extractRequestedSlideIndex("halaman 12 terlalu panjang"), 12);
  assert.equal(extractRequestedSlideIndex("improve slide #7"), 7);
  assert.equal(extractRequestedSlideIndex("lihat #3"), 3);
  assert.equal(extractRequestedSlideIndex("tidak ada angka"), 0);
  assert.equal(extractRequestedSlideIndex("slide 0"), 0);
  assert.equal(extractRequestedSlideIndex(""), 0);
  assert.equal(extractRequestedSlideIndex(null), 0);
});

test("extractPptxSlides parses labelled extractor output", () => {
  const text = [
    "[Slide 1 | id 257]",
    "Judul Deck",
    "Subjudul",
    "[Slide 2 | id 258]",
    "Agenda",
    ""
  ].join("\n");
  const slides = extractPptxSlides(text);
  assert.equal(slides.length, 2);
  assert.equal(slides[0].index, "1");
  assert.equal(slides[0].id, "257");
  assert.equal(slides[0].text, "Judul Deck\nSubjudul");
  assert.equal(slides[1].label, "Slide 2 | id 258");
  assert.equal(slides[1].text, "Agenda");
});

test("extractPptxSlides tolerates missing ids and returns empty for junk", () => {
  const slides = extractPptxSlides("[Slide 1]\nHanya teks");
  assert.equal(slides.length, 1);
  assert.equal(slides[0].id, "");
  assert.deepEqual(extractPptxSlides("tidak ada label slide"), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/chat/pptTools.js'`

- [ ] **Step 3: Create pptTools.js with the moved functions**

Create `src/chat/pptTools.js`. Copy both functions verbatim from `src/taskpane.js:1266-1289` and export them:

```js
// Tantular PowerPoint chat tools — deck reading, action validation, execution.
// All Office/PowerPoint access for the PPT chat lives here so pptChat.js can
// stay a pure UI module (mirrors the excelChat.js / excelTools.js split).

export function extractRequestedSlideIndex(text) {
  const value = String(text || "");
  const match = value.match(/\b(?:slide|page|halaman|hlm|deck\s*page)\s*#?\s*(\d{1,3})\b/i)
    || value.match(/#\s*(\d{1,3})\b/);
  if (!match) return 0;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : 0;
}

export function extractPptxSlides(text) {
  const value = String(text || "");
  const re = /^\[Slide\s+(\d+)(?:\s+\|\s+id\s+([^\]]+))?\]\s*\n([\s\S]*?)(?=^\[Slide\s+\d+(?:\s+\|\s+id\s+[^\]]+)?\]\s*\n|\s*$)/gm;
  const slides = [];
  let match;
  while ((match = re.exec(value))) {
    slides.push({
      label: `Slide ${match[1]}${match[2] ? ` | id ${match[2]}` : ""}`,
      index: match[1],
      id: match[2] || "",
      text: match[3].trim()
    });
  }
  return slides;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — new `pptTools` tests green, all existing tests still green.

- [ ] **Step 5: Delete the originals from taskpane.js and import instead**

In `src/taskpane.js`, delete the two function bodies at lines 1266-1289. Add to the import block near the top (after the existing `src/chat/*` imports, matching their style):

```js
import { extractPptxSlides, extractRequestedSlideIndex } from "./chat/pptTools.js";
```

- [ ] **Step 6: Verify no duplicate definitions remain**

Run: `grep -n "function extractPptxSlides\|function extractRequestedSlideIndex" src/taskpane.js`
Expected: no output.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/chat/pptTools.js tests/pptTools.test.mjs src/taskpane.js
git commit -m "refactor: move pptx slide helpers into pptTools with first tests"
```

---

### Task 2: sanitizePptActions — the action contract

The only place that knows the action JSON schema. Pure, no Office, no DOM.

**Files:**
- Modify: `src/chat/pptTools.js`
- Modify: `tests/pptTools.test.mjs`

**Interfaces:**
- Consumes: `SLIDE_TYPES` from `../deck/deckPlanner.js`.
- Produces: `sanitizePptActions(raw, slideCount) → { actions, rejected }`. `actions` is an array of `{ op, slideIndex?, afterIndex?, slide? }`; `rejected` is an array of Indonesian reason strings.

- [ ] **Step 1: Write the failing test**

Append to `tests/pptTools.test.mjs`:

```js
import { sanitizePptActions } from "../src/chat/pptTools.js";

const bulletsSlide = { type: "bullets", headline: "Judul", bullets: ["satu", "dua"] };

test("sanitize accepts one valid action of every op", () => {
  const { actions, rejected } = sanitizePptActions([
    { op: "improve_slide", slideIndex: 4 },
    { op: "replace_slide", slideIndex: 3, slide: bulletsSlide },
    { op: "add_slide", afterIndex: 5, slide: bulletsSlide },
    { op: "delete_slide", slideIndex: 7 }
  ], 10);
  assert.equal(rejected.length, 0);
  assert.equal(actions.length, 4);
  assert.deepEqual(actions.map((a) => a.op),
    ["improve_slide", "replace_slide", "add_slide", "delete_slide"]);
});

test("sanitize rejects unknown ops and out-of-range indexes", () => {
  const { actions, rejected } = sanitizePptActions([
    { op: "reorder_slide", slideIndex: 2 },
    { op: "improve_slide", slideIndex: 0 },
    { op: "improve_slide", slideIndex: 11 },
    { op: "improve_slide", slideIndex: "3" },
    { op: "improve_slide", slideIndex: 3.5 }
  ], 10);
  assert.equal(actions.length, 0);
  assert.equal(rejected.length, 5);
  assert.match(rejected[0], /reorder_slide/);
});

test("sanitize rejects afterIndex 0 with the front-insert message", () => {
  const { actions, rejected } = sanitizePptActions(
    [{ op: "add_slide", afterIndex: 0, slide: bulletsSlide }], 10);
  assert.equal(actions.length, 0);
  assert.match(rejected[0], /paling depan belum didukung/);
});

test("sanitize caps a turn at 8 actions", () => {
  const raw = Array.from({ length: 9 }, (_, i) => ({ op: "improve_slide", slideIndex: i + 1 }));
  const { actions, rejected } = sanitizePptActions(raw, 20);
  assert.equal(actions.length, 8);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /maksimum 8/i);
});

test("sanitize strips unknown slide fields", () => {
  const { actions } = sanitizePptActions([{
    op: "add_slide",
    afterIndex: 1,
    slide: { ...bulletsSlide, animation: "fade", notes: "rahasia" }
  }], 10);
  assert.deepEqual(Object.keys(actions[0].slide).sort(), ["bullets", "headline", "type"]);
});

test("sanitize tolerates non-array input", () => {
  assert.deepEqual(sanitizePptActions(null, 10), { actions: [], rejected: [] });
  assert.deepEqual(sanitizePptActions("bukan array", 10), { actions: [], rejected: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `sanitizePptActions is not a function`.

- [ ] **Step 3: Implement sanitizePptActions**

Add to `src/chat/pptTools.js`:

```js
import { SLIDE_TYPES } from "../deck/deckPlanner.js";

const MAX_ACTIONS_PER_TURN = 8;
const OPS = ["improve_slide", "replace_slide", "add_slide", "delete_slide"];
const FRONT_INSERT_REJECTION =
  "Menyisipkan slide di posisi paling depan belum didukung. " +
  "Sisipkan setelah slide 1, lalu geser di panel thumbnail.";

function isIndex(value) {
  return Number.isInteger(value);
}

function str(value) {
  return String(value ?? "").trim();
}

export function sanitizePptActions(raw, slideCount) {
  if (!Array.isArray(raw)) return { actions: [], rejected: [] };
  const total = Number(slideCount) || 0;
  const actions = [];
  const rejected = [];

  for (const item of raw) {
    if (actions.length >= MAX_ACTIONS_PER_TURN) {
      rejected.push(`Melebihi maksimum 8 aksi per giliran; sisanya diabaikan.`);
      break;
    }
    const op = str(item?.op);
    if (!OPS.includes(op)) {
      rejected.push(`Aksi "${op || "(kosong)"}" tidak dikenal dan diabaikan.`);
      continue;
    }

    if (op === "add_slide") {
      const afterIndex = item?.afterIndex;
      if (afterIndex === 0) { rejected.push(FRONT_INSERT_REJECTION); continue; }
      if (!isIndex(afterIndex) || afterIndex < 1 || afterIndex > total) {
        rejected.push(`add_slide dengan afterIndex "${afterIndex}" di luar jangkauan 1-${total}.`);
        continue;
      }
      const slide = sanitizeSlide(item?.slide);
      if (!slide.ok) { rejected.push(`add_slide ditolak: ${slide.reason}`); continue; }
      actions.push({ op, afterIndex, slide: slide.slide });
      continue;
    }

    const slideIndex = item?.slideIndex;
    if (!isIndex(slideIndex) || slideIndex < 1 || slideIndex > total) {
      rejected.push(`${op} dengan slideIndex "${slideIndex}" di luar jangkauan 1-${total}.`);
      continue;
    }
    if (op === "replace_slide") {
      const slide = sanitizeSlide(item?.slide);
      if (!slide.ok) { rejected.push(`replace_slide ditolak: ${slide.reason}`); continue; }
      actions.push({ op, slideIndex, slide: slide.slide });
      continue;
    }
    actions.push({ op, slideIndex });
  }

  return { actions, rejected };
}
```

`sanitizeSlide` is written in Task 3. For this step, add a temporary permissive stub at the bottom of the file so these tests can pass:

```js
function sanitizeSlide(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "slide tidak ada." };
  const type = str(raw.type);
  if (!SLIDE_TYPES.includes(type)) return { ok: false, reason: `type "${type}" tidak dikenal.` };
  const slide = { type };
  if (str(raw.headline)) slide.headline = str(raw.headline);
  if (Array.isArray(raw.bullets)) slide.bullets = raw.bullets.map(str).filter(Boolean);
  return { ok: true, slide };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/pptTools.js tests/pptTools.test.mjs
git commit -m "feat: sanitizePptActions action contract for the PowerPoint chat"
```

---

### Task 3: Per-type slide validation

Replaces the Task 2 stub with the real per-type table from the spec. Nested entries are dropped first, then the slide is rejected if its required array is now empty.

**Files:**
- Modify: `src/chat/pptTools.js`
- Modify: `tests/pptTools.test.mjs`

**Interfaces:**
- Consumes: `SLIDE_TYPES`.
- Produces: `sanitizeSlide(raw) → { ok: true, slide } | { ok: false, reason }` (module-private; exercised through `sanitizePptActions`).

- [ ] **Step 1: Write the failing test**

Append to `tests/pptTools.test.mjs`:

```js
function addSlide(slide) {
  return sanitizePptActions([{ op: "add_slide", afterIndex: 1, slide }], 10);
}

test("quote slides need quote or headline, not both", () => {
  assert.equal(addSlide({ type: "quote", quote: "Kutipan penting" }).actions.length, 1);
  assert.equal(addSlide({ type: "quote", headline: "Judul saja" }).actions.length, 1);
  const empty = addSlide({ type: "quote", subhead: "Nama" });
  assert.equal(empty.actions.length, 0);
  assert.match(empty.rejected[0], /quote|headline/);
});

test("non-quote slides require a headline", () => {
  const missing = addSlide({ type: "bullets", bullets: ["satu"] });
  assert.equal(missing.actions.length, 0);
  assert.match(missing.rejected[0], /headline/);
});

test("each content type requires its own non-empty array", () => {
  assert.equal(addSlide({ type: "bullets", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "agenda", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "cards", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "columns", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "metrics", headline: "H" }).actions.length, 0);
  assert.equal(addSlide({ type: "visualization", headline: "H" }).actions.length, 0);
});

test("title and closing need only a headline", () => {
  assert.equal(addSlide({ type: "title", headline: "Judul", subhead: "Sub" }).actions.length, 1);
  assert.equal(addSlide({ type: "closing", headline: "Terima kasih" }).actions.length, 1);
});

test("metrics and visualization keep their builder fields", () => {
  const metrics = addSlide({
    type: "metrics", headline: "Angka",
    metrics: [{ value: "92%", label: "Akurasi" }, { value: "3x", label: "Lebih cepat" }]
  });
  assert.deepEqual(metrics.actions[0].slide.metrics,
    [{ value: "92%", label: "Akurasi" }, { value: "3x", label: "Lebih cepat" }]);

  const viz = addSlide({
    type: "visualization", headline: "Tren", chartType: "bar",
    data: [{ label: "Q1", value: 10 }, { label: "Q2", value: 20 }],
    bullets: ["naik dua kali lipat"]
  });
  assert.equal(viz.actions[0].slide.chartType, "bar");
  assert.deepEqual(viz.actions[0].slide.data, [{ label: "Q1", value: 10 }, { label: "Q2", value: 20 }]);
  assert.deepEqual(viz.actions[0].slide.bullets, ["naik dua kali lipat"]);
});

test("cards and columns keep their nested shapes", () => {
  const cards = addSlide({
    type: "cards", headline: "Fitur",
    cards: [{ title: "Cepat", desc: "Lokal" }, { title: "Privat" }]
  });
  assert.deepEqual(cards.actions[0].slide.cards, [{ title: "Cepat", desc: "Lokal" }, { title: "Privat" }]);

  const columns = addSlide({
    type: "columns", headline: "Banding",
    columns: [{ title: "Sebelum", points: ["a", "b"] }, { title: "Sesudah", points: ["c"] }]
  });
  assert.equal(columns.actions[0].slide.columns.length, 2);
  assert.deepEqual(columns.actions[0].slide.columns[0].points, ["a", "b"]);
});

test("invalid nested entries are dropped, siblings survive", () => {
  const cards = addSlide({
    type: "cards", headline: "Fitur",
    cards: [{ desc: "tanpa judul" }, { title: "Valid", desc: "ok" }]
  });
  assert.deepEqual(cards.actions[0].slide.cards, [{ title: "Valid", desc: "ok" }]);
});

test("dropping every nested entry rejects the slide", () => {
  const cards = addSlide({ type: "cards", headline: "Fitur", cards: [{ desc: "x" }, { desc: "y" }] });
  assert.equal(cards.actions.length, 0);
  assert.match(cards.rejected[0], /cards/);

  const metrics = addSlide({ type: "metrics", headline: "M", metrics: [{ label: "tanpa nilai" }] });
  assert.equal(metrics.actions.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — the permissive stub accepts slides it should reject (e.g. `bullets` with no bullets).

- [ ] **Step 3: Replace the stub with per-type validation**

In `src/chat/pptTools.js`, replace the `sanitizeSlide` stub with:

```js
// Field allowlist = exactly what pptxBuilder consumes. Anything else is
// stripped so a hallucinated field can never reach the renderer.
const TYPE_RULES = {
  title:         { requires: null },
  closing:       { requires: null },
  quote:         { requires: null },
  agenda:        { requires: "bullets" },
  bullets:       { requires: "bullets" },
  cards:         { requires: "cards" },
  columns:       { requires: "columns" },
  metrics:       { requires: "metrics" },
  visualization: { requires: "data" }
};

function cleanStrings(raw) {
  return Array.isArray(raw) ? raw.map(str).filter(Boolean) : [];
}

function cleanCards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((card) => {
    const title = str(card?.title);
    if (!title) return null;
    const desc = str(card?.desc);
    return desc ? { title, desc } : { title };
  }).filter(Boolean);
}

function cleanColumns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((column) => {
    const title = str(column?.title);
    if (!title) return null;
    const points = cleanStrings(column?.points);
    return points.length ? { title, points } : { title };
  }).filter(Boolean);
}

function cleanMetrics(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((metric) => {
    const value = str(metric?.value);
    if (!value) return null;
    return { value, label: str(metric?.label) };
  }).filter(Boolean);
}

function cleanData(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((point) => {
    const label = str(point?.label);
    const value = Number(point?.value);
    if (!label || !Number.isFinite(value)) return null;
    return { label, value };
  }).filter(Boolean);
}

function sanitizeSlide(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "objek slide tidak ada." };
  const type = str(raw.type);
  if (!TYPE_RULES[type]) return { ok: false, reason: `type slide "${type}" tidak dikenal.` };

  const headline = str(raw.headline);
  const quote = str(raw.quote);
  if (type === "quote") {
    if (!headline && !quote) return { ok: false, reason: "slide quote butuh \"quote\" atau \"headline\"." };
  } else if (!headline) {
    return { ok: false, reason: `slide ${type} butuh "headline".` };
  }

  const slide = { type };
  if (headline) slide.headline = headline;
  if (quote) slide.quote = quote;
  if (str(raw.subhead)) slide.subhead = str(raw.subhead);

  // Drop invalid nested entries FIRST, then check emptiness — an array that
  // only contained malformed entries must reject the slide, not render blank.
  const bullets = cleanStrings(raw.bullets);
  const cards = cleanCards(raw.cards);
  const columns = cleanColumns(raw.columns);
  const metrics = cleanMetrics(raw.metrics);
  const data = cleanData(raw.data);
  if (bullets.length) slide.bullets = bullets;
  if (cards.length) slide.cards = cards;
  if (columns.length) slide.columns = columns;
  if (metrics.length) slide.metrics = metrics;
  if (data.length) slide.data = data;
  if (type === "visualization" && str(raw.chartType)) {
    slide.chartType = str(raw.chartType).toLowerCase();
  }

  const required = TYPE_RULES[type].requires;
  if (required && !(slide[required] || []).length) {
    return { ok: false, reason: `slide ${type} butuh "${required}" yang tidak kosong.` };
  }
  return { ok: true, slide };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/pptTools.js tests/pptTools.test.mjs
git commit -m "feat: per-type slide validation matching the pptxBuilder field map"
```

---

### Task 4: orderPptActions — deterministic execution order

Two ordering traps, both from how `insertSlidesFromBase64` and `replaceSlideInActivePresentation` actually behave.

**Files:**
- Modify: `src/chat/pptTools.js`
- Modify: `tests/pptTools.test.mjs`

**Interfaces:**
- Consumes: sanitized actions from Task 2.
- Produces: `orderPptActions(actions) → actions[]` (new array, same objects, execution order).

- [ ] **Step 1: Write the failing test**

Append to `tests/pptTools.test.mjs`:

```js
import { orderPptActions } from "../src/chat/pptTools.js";

const slideFor = (name) => ({ type: "bullets", headline: name, bullets: ["x"] });

test("replaces and deletes run descending by slideIndex", () => {
  const ordered = orderPptActions([
    { op: "replace_slide", slideIndex: 2, slide: slideFor("A") },
    { op: "delete_slide", slideIndex: 9 },
    { op: "improve_slide", slideIndex: 5 }
  ]);
  assert.deepEqual(ordered.map((a) => a.slideIndex), [9, 5, 2]);
});

test("two same-anchor inserts land in model order in the final deck", () => {
  const ordered = orderPptActions([
    { op: "add_slide", afterIndex: 5, slide: slideFor("A") },
    { op: "add_slide", afterIndex: 5, slide: slideFor("B") }
  ]);
  // Each insert lands immediately after slide 5, so executing B then A
  // produces the deck order 5, A, B — which is the model's intent.
  assert.deepEqual(ordered.map((a) => a.slide.headline), ["B", "A"]);
});

test("three same-anchor inserts land in model order in the final deck", () => {
  const ordered = orderPptActions([
    { op: "add_slide", afterIndex: 3, slide: slideFor("A") },
    { op: "add_slide", afterIndex: 3, slide: slideFor("B") },
    { op: "add_slide", afterIndex: 3, slide: slideFor("C") }
  ]);
  assert.deepEqual(ordered.map((a) => a.slide.headline), ["C", "B", "A"]);
});

test("an insert anchored on a replaced slide runs before that replace", () => {
  const ordered = orderPptActions([
    { op: "replace_slide", slideIndex: 5, slide: slideFor("baru") },
    { op: "add_slide", afterIndex: 5, slide: slideFor("tambahan") }
  ]);
  assert.deepEqual(ordered.map((a) => a.op), ["add_slide", "replace_slide"]);
});

test("at equal index the tie-break is add, then replace, then delete", () => {
  const ordered = orderPptActions([
    { op: "delete_slide", slideIndex: 4 },
    { op: "replace_slide", slideIndex: 4, slide: slideFor("R") },
    { op: "add_slide", afterIndex: 4, slide: slideFor("A") }
  ]);
  assert.deepEqual(ordered.map((a) => a.op), ["add_slide", "replace_slide", "delete_slide"]);
});

test("a mixed list produces one deterministic sequence", () => {
  const ordered = orderPptActions([
    { op: "improve_slide", slideIndex: 2 },
    { op: "add_slide", afterIndex: 7, slide: slideFor("A") },
    { op: "delete_slide", slideIndex: 4 },
    { op: "add_slide", afterIndex: 7, slide: slideFor("B") }
  ]);
  assert.deepEqual(
    ordered.map((a) => `${a.op}:${a.slideIndex ?? a.afterIndex}:${a.slide?.headline ?? ""}`),
    ["add_slide:7:B", "add_slide:7:A", "delete_slide:4:", "improve_slide:2:"]
  );
});

test("orderPptActions does not mutate its input", () => {
  const input = [
    { op: "improve_slide", slideIndex: 1 },
    { op: "improve_slide", slideIndex: 9 }
  ];
  orderPptActions(input);
  assert.deepEqual(input.map((a) => a.slideIndex), [1, 9]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `orderPptActions is not a function`.

- [ ] **Step 3: Implement orderPptActions**

Add to `src/chat/pptTools.js`:

```js
// Execution order is load-bearing, for two reasons:
//  1. Mutating slide N shifts the position of everything after it, so the
//     highest index goes first.
//  2. replaceSlideInActivePresentation inserts after the original and THEN
//     deletes it (officeClient.js:603/645). An add_slide anchored on a slide
//     being replaced must therefore run BEFORE the replace, while its anchor
//     id still exists.
const OP_RANK = { add_slide: 0, replace_slide: 1, improve_slide: 1, delete_slide: 2 };

export function orderPptActions(actions) {
  const list = Array.isArray(actions) ? actions.slice() : [];
  return list
    .map((action, position) => ({ action, position }))
    .sort((a, b) => {
      const aIndex = a.action.op === "add_slide" ? a.action.afterIndex : a.action.slideIndex;
      const bIndex = b.action.op === "add_slide" ? b.action.afterIndex : b.action.slideIndex;
      if (aIndex !== bIndex) return bIndex - aIndex;
      const rank = OP_RANK[a.action.op] - OP_RANK[b.action.op];
      if (rank !== 0) return rank;
      // Same anchor, same op: reverse model order. Every insert lands
      // immediately after the anchor, so the last one executed ends up first.
      if (a.action.op === "add_slide") return b.position - a.position;
      return a.position - b.position;
    })
    .map((entry) => entry.action);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/pptTools.js tests/pptTools.test.mjs
git commit -m "feat: deterministic PowerPoint action ordering with anchor-safety tie-break"
```

---

### Task 5: resolveDeleteTarget and deckContextToPromptText

Two more pure functions: id-first delete targeting with stale detection, and the snapshot the model sees.

**Files:**
- Modify: `src/chat/pptTools.js`
- Modify: `tests/pptTools.test.mjs`

**Interfaces:**
- Consumes: `sameSlideId` from `../officeClient.js`.
- Produces:
  - `resolveDeleteTarget(liveIds, descriptor) → { ok: true, id, index } | { ok: false, reason }`
  - `deckContextToPromptText(ctx) → string`
  - Constants `PER_SLIDE_CHARS = 400`, `TOTAL_SNAPSHOT_CHARS = 9000`.

- [ ] **Step 1: Write the failing test**

Append to `tests/pptTools.test.mjs`:

```js
import { resolveDeleteTarget, deckContextToPromptText } from "../src/chat/pptTools.js";

test("resolveDeleteTarget prefers id over index", () => {
  const result = resolveDeleteTarget(["257", "258", "259"], { slideIndex: 1, id: "259" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "259");
  assert.equal(result.index, 3);
});

test("resolveDeleteTarget matches ids across API surfaces", () => {
  const result = resolveDeleteTarget(["257#abc", "258#def"], { slideIndex: 2, id: "258" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "258#def");
});

test("resolveDeleteTarget refuses a positional fallback when the id is gone", () => {
  const result = resolveDeleteTarget(["257", "258"], { slideIndex: 2, id: "999", title: "Penutup" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /berubah/i);
});

test("resolveDeleteTarget falls back to index only when no id was captured", () => {
  const result = resolveDeleteTarget(["257", "258", "259"], { slideIndex: 2, id: "" });
  assert.equal(result.ok, true);
  assert.equal(result.id, "258");
});

test("resolveDeleteTarget rejects an index outside the live deck", () => {
  const result = resolveDeleteTarget(["257"], { slideIndex: 4, id: "" });
  assert.equal(result.ok, false);
});

test("deckContextToPromptText states slide count and the global truncation notice", () => {
  const text = deckContextToPromptText({
    source: "extractor",
    slides: [
      { index: 1, id: "257", title: "Judul", text: "Judul\nSubjudul", truncated: false },
      { index: 2, id: "258", title: "Agenda", text: "Agenda", truncated: false }
    ]
  });
  assert.match(text, /2 slide/);
  assert.match(text, /Konten slide dipotong untuk konteks/);
  assert.match(text, /\[Slide 1 \| id 257\]/);
  assert.match(text, /\[Slide 2 \| id 258\]/);
});

test("deckContextToPromptText marks only the slides it actually cut", () => {
  const long = "x".repeat(900);
  const text = deckContextToPromptText({
    source: "host",
    slides: [
      { index: 1, id: "257", title: "Pendek", text: "singkat", truncated: false },
      { index: 2, id: "258", title: "Panjang", text: long, truncated: false }
    ]
  });
  const [first, second] = text.split("[Slide 2");
  assert.equal(/\[dipotong\]/.test(first), false);
  assert.match(second, /\[dipotong\]/);
});

test("deckContextToPromptText respects the total ceiling", () => {
  const slides = Array.from({ length: 60 }, (_, i) => ({
    index: i + 1, id: String(257 + i), title: `Slide ${i + 1}`,
    text: "y".repeat(500), truncated: false
  }));
  const text = deckContextToPromptText({ source: "extractor", slides });
  assert.ok(text.length < 11000, `snapshot too long: ${text.length}`);
  assert.match(text, /60 slide/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveDeleteTarget is not a function`.

- [ ] **Step 3: Implement both functions**

Add to `src/chat/pptTools.js` (extend the existing `officeClient` import if one is already present):

```js
import { sameSlideId } from "../officeClient.js";

export const PER_SLIDE_CHARS = 400;
export const TOTAL_SNAPSHOT_CHARS = 9000;

// A confirmed delete must hit the slide the user saw in the proposal. If the
// deck moved between proposal and confirmation, warn instead of deleting
// whatever now sits at that position.
export function resolveDeleteTarget(liveIds, descriptor) {
  const ids = Array.isArray(liveIds) ? liveIds.map((id) => String(id || "")) : [];
  const wanted = str(descriptor?.id);
  const index = Number(descriptor?.slideIndex) || 0;

  if (wanted) {
    let position = ids.findIndex((id) => id === wanted);
    if (position < 0) {
      const matches = ids
        .map((id, i) => (sameSlideId(id, wanted) ? i : -1))
        .filter((i) => i >= 0);
      if (matches.length === 1) position = matches[0];
    }
    if (position < 0) {
      const title = str(descriptor?.title);
      return {
        ok: false,
        reason: `Deck sudah berubah sejak penghapusan diusulkan${title ? ` (slide "${title}")` : ""}. ` +
          "Tidak ada yang dihapus. Minta ulang jika masih ingin menghapusnya."
      };
    }
    return { ok: true, id: ids[position], index: position + 1 };
  }

  if (!Number.isInteger(index) || index < 1 || index > ids.length) {
    return { ok: false, reason: `Slide ${index || "?"} tidak ada lagi di deck aktif. Tidak ada yang dihapus.` };
  }
  return { ok: true, id: ids[index - 1], index };
}

export function deckContextToPromptText(ctx) {
  const slides = Array.isArray(ctx?.slides) ? ctx.slides : [];
  const lines = [
    `Deck aktif: ${slides.length} slide. Sumber pembacaan: ${str(ctx?.source) || "tidak diketahui"}.`,
    "Konten slide dipotong untuk konteks; jangan anggap bagian yang tidak terlihat kosong.",
    ""
  ];
  let budget = TOTAL_SNAPSHOT_CHARS;
  for (const slide of slides) {
    const header = `[Slide ${slide.index}${slide.id ? ` | id ${slide.id}` : ""}]`;
    const room = Math.max(0, Math.min(PER_SLIDE_CHARS, budget));
    const body = str(slide.text);
    const cut = body.length > room;
    const shown = cut ? `${body.slice(0, room)} [dipotong]` : body;
    lines.push(`${header} ${shown}`.trim());
    budget -= Math.min(body.length, room);
    if (budget <= 0) {
      lines.push(`[… ${slides.length - slide.index} slide berikutnya tidak ditampilkan karena batas konteks]`);
      break;
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/pptTools.js tests/pptTools.test.mjs
git commit -m "feat: delete targeting with stale detection and the deck snapshot prompt"
```

---

### Task 6: Extract deleteSlidesInActivePresentation, thread signal into improveExistingSlide

Standalone delete does not exist today — the logic lives inside `replaceSlideInActivePresentation`. Extract it so both paths share one verified implementation.

**Files:**
- Modify: `src/officeClient.js:518-560` (extract helper), `src/officeClient.js:545-558` (remove inline copy)
- Modify: `src/deck/deckPlanner.js:715-740` (add `signal`)

**Interfaces:**
- Produces: `deleteSlidesInActivePresentation(ids) → { deleted: boolean, reason?: string }`, exported from `officeClient.js`.
- Produces: `improveExistingSlide({ slideText, tone, instruction, signal })` — `signal` is new and optional.

- [ ] **Step 1: Add the exported delete helper**

In `src/officeClient.js`, add after `replaceSlideInActivePresentation`:

```js
// Standalone slide delete, verified. Mac PowerPoint silently ignores
// Slide.delete() when the target is the active selection, and the usual
// workaround (setSelectedSlides) needs PowerPointApi 1.5 which this host
// lacks — so we re-read afterwards and never report an unverified success.
export async function deleteSlidesInActivePresentation(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean);
  if (!wanted.length) return { deleted: false, reason: "Tidak ada slide yang ditentukan." };
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    const readSlideIds = async () => {
      const collection = context.presentation.slides;
      collection.load("items");
      await context.sync();
      for (const slide of collection.items || []) slide.load("id");
      await context.sync();
      const items = collection.items || [];
      return { items, ids: items.map((slide) => String(slide.id || "")) };
    };

    const snapshot = await readSlideIds();
    const targets = snapshot.items.filter((_, index) => wanted.includes(snapshot.ids[index]));
    if (targets.length !== wanted.length) {
      return { deleted: false, reason: "Slide target tidak ditemukan lagi di deck aktif." };
    }
    if (targets.some((slide) => typeof slide.delete !== "function")) {
      return { deleted: false, reason: "Host PowerPoint ini belum mendukung penghapusan slide via API." };
    }
    targets.forEach((slide) => slide.delete());
    await context.sync();
    const verify = await readSlideIds();
    const survived = verify.ids.some((id) => wanted.includes(id));
    if (survived) {
      return {
        deleted: false,
        reason: "Slide tidak terhapus — kemungkinan sedang terpilih di panel thumbnail. " +
          "Pilih slide lain lalu coba lagi."
      };
    }
    return { deleted: true };
  });
}
```

- [ ] **Step 2: Point the inline copy at the shared verify logic**

Inside `replaceSlideInActivePresentation`, the local `deleteSlidesByIds` (lines 545-558) stays — it must run inside the *same* `PowerPoint.run` context as the insert, so it cannot call the new export. Instead, add a comment above it recording the shared contract so the two never drift:

```js
    // Same delete-and-verify contract as deleteSlidesInActivePresentation():
    // delete, re-read, and only report success when the ids are actually gone.
    // Kept inline because it must share this PowerPoint.run context with the
    // insert above.
    const deleteSlidesByIds = async (ids) => {
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm test`
Expected: PASS — `replaceSlideTarget.test.mjs` unchanged and green.

- [ ] **Step 4: Thread signal into improveExistingSlide**

In `src/deck/deckPlanner.js`, change the signature at line 715 and the `runTantular` call inside it:

```js
export async function improveExistingSlide({ slideText, tone = "", instruction = "", signal }) {
```

and add `signal` to the `runTantular({ ... })` options object in that function, next to `jsonMode: true`:

```js
      jsonMode: true,
      signal
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS — `deckPlanner.test.mjs` green; `signal` is optional so existing callers are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/officeClient.js src/deck/deckPlanner.js
git commit -m "feat: verified standalone slide delete, abortable improveExistingSlide"
```

---

### Task 7: getDeckContext — and the host-read probe

**This task is the gate.** It ships both read paths and answers whether the in-host fast path works on the Mac host. Do not start Task 8 until the probe has been run in real PowerPoint and its outcome recorded here.

**Files:**
- Modify: `src/chat/pptTools.js`
- Modify: `tests/pptTools.test.mjs`

**Interfaces:**
- Consumes: `getActivePresentationPptxFile` from `../officeClient.js`, `extractDocumentFile` from `../deck/documentExtract.js`, `extractPptxSlides` (Task 1).
- Produces:
  - `getDeckContext({ force }) → { slides: [{ index, id, title, text, truncated }], source, meta }`
  - `invalidateDeckContext()` → clears the module cache.
  - `buildDeckSlidesFromExtractor(text) → slides[]` (pure, exported for tests).

- [ ] **Step 1: Write the failing test for the pure part**

Append to `tests/pptTools.test.mjs`:

```js
import { buildDeckSlidesFromExtractor } from "../src/chat/pptTools.js";

test("buildDeckSlidesFromExtractor turns labelled text into snapshot slides", () => {
  const slides = buildDeckSlidesFromExtractor([
    "[Slide 1 | id 257]",
    "Judul Deck",
    "Baris kedua",
    "[Slide 2 | id 258]",
    "Agenda",
    ""
  ].join("\n"));
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0], {
    index: 1, id: "257", title: "Judul Deck", text: "Judul Deck\nBaris kedua", truncated: false
  });
  assert.equal(slides[1].title, "Agenda");
});

test("buildDeckSlidesFromExtractor titles an empty slide honestly", () => {
  const slides = buildDeckSlidesFromExtractor("[Slide 1 | id 257]\n\n");
  assert.equal(slides[0].title, "(tanpa teks)");
  assert.equal(slides[0].text, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildDeckSlidesFromExtractor is not a function`.

- [ ] **Step 3: Implement getDeckContext with both paths**

Add to `src/chat/pptTools.js`:

```js
import { getActivePresentationPptxFile } from "../officeClient.js";
import { extractDocumentFile } from "../deck/documentExtract.js";

let deckCache = null;

export function invalidateDeckContext() {
  deckCache = null;
}

function titleOf(text) {
  const first = str(text).split("\n").map(str).find(Boolean);
  return first || "(tanpa teks)";
}

export function buildDeckSlidesFromExtractor(text) {
  return extractPptxSlides(text).map((slide, position) => ({
    index: Number(slide.index) || position + 1,
    id: str(slide.id),
    title: titleOf(slide.text),
    text: str(slide.text),
    truncated: false
  }));
}

// Fast path: read the deck through the PowerPoint API. Requires Shape.textFrame
// (PowerPointApi 1.4), which is NOT confirmed on the Mac workshop host — this
// returns null rather than throwing so the caller falls back cleanly.
async function readDeckViaHost() {
  if (!globalThis.PowerPoint?.run) return null;
  try {
    return await PowerPoint.run(async (context) => {
      const collection = context.presentation.slides;
      collection.load("items");
      await context.sync();
      const items = collection.items || [];
      if (!items.length) return null;

      for (const slide of items) {
        slide.load("id");
        try { slide.shapes.load("items"); } catch (_) { /* older hosts */ }
      }
      await context.sync();

      const perSlide = items.map((slide) => {
        const ranges = [];
        for (const shape of slide.shapes?.items || []) {
          try {
            const range = shape.textFrame.textRange;
            range.load("text");
            ranges.push(range);
          } catch (_) { /* non-text shapes are expected */ }
        }
        return ranges;
      });
      await context.sync();

      const slides = items.map((slide, position) => {
        const text = perSlide[position]
          .map((range) => str(range.text))
          .filter(Boolean)
          .join("\n");
        return {
          index: position + 1,
          id: String(slide.id || ""),
          title: titleOf(text),
          text,
          truncated: false
        };
      });
      // A deck where every slide reads empty means textFrame silently gave us
      // nothing. Treat it as a failed read, not an empty deck.
      return slides.some((slide) => slide.text) ? slides : null;
    });
  } catch (error) {
    console.warn("[TantularChat/PPT] in-host deck read failed", error);
    return null;
  }
}

async function readDeckViaExtractor() {
  const file = await getActivePresentationPptxFile();
  const extracted = await extractDocumentFile(file);
  return buildDeckSlidesFromExtractor(extracted?.text || "");
}

export async function getDeckContext({ force = false } = {}) {
  if (deckCache && force !== true) return deckCache;

  let slides = await readDeckViaHost();
  let source = "host";
  if (!slides?.length) {
    slides = await readDeckViaExtractor();
    source = "extractor";
  }
  if (!slides?.length) {
    throw new Error(
      "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan, " +
      "lalu klik Muat ulang deck."
    );
  }

  deckCache = {
    slides,
    source,
    meta: `${slides.length} slide terbaca (${source}).`
  };
  return deckCache;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/pptTools.js tests/pptTools.test.mjs
git commit -m "feat: deck snapshot reader with in-host fast path and extractor fallback"
```

- [ ] **Step 6: Run Probe A in real PowerPoint**

The pane cannot call this yet, so probe from the dev server's page context:

1. Start the dev server: `node tools/dev-server.mjs`
2. Open PowerPoint with a deck of at least 3 slides, at least one with body text.
3. Open the Tantular pane.
4. Clear the WebKit cache first if the pane looks stale: delete `~/Library/Containers/com.microsoft.PowerPoint/Data/Library/Caches/WebKit` and `Cmd+Q` PowerPoint.
5. In the pane's browser console (right-click → Inspect Element on Mac), run:

```js
const t = await import("./chat/pptTools.js");
const ctx = await t.getDeckContext({ force: true });
console.log(ctx.source, ctx.slides.length, ctx.slides.map((s) => s.text.length));
```

Record the result:
- `source === "host"` → the fast path works. Keep both branches.
- `source === "extractor"` → the fast path is dead on this host. **Add a follow-up task to delete `readDeckViaHost` entirely** rather than shipping a branch nobody has proven.

- [ ] **Step 7: Run Probe B — no-anchor insert**

In the same console:

```js
const oc = await import("./officeClient.js");
const b = await import("./deck/pptxBuilder.js");
const base64 = b.buildDeckPptxBase64(
  { title: "Probe", slides: [{ type: "title", headline: "PROBE B" }] }, "nusantara", "");
await oc.insertDeckIntoActivePresentation(base64, {});
```

Record where "PROBE B" landed — first slide, last slide, or after the selection. This decides whether `afterIndex: 0` can be enabled later. Delete the probe slide afterwards. `afterIndex: 0` stays rejected in this plan either way.

- [ ] **Step 8: Record both outcomes in the spec**

Append the measured results to `docs/superpowers/specs/2026-08-14-powerpoint-agentic-chat-design.md` under the probe section, with the date. Commit:

```bash
git add docs/superpowers/specs/2026-08-14-powerpoint-agentic-chat-design.md
git commit -m "docs: record PowerPoint host probe results"
```

---

### Task 8: executePptActions and executeConfirmedDelete

**Files:**
- Modify: `src/chat/pptTools.js`
- Modify: `tests/pptTools.test.mjs`

**Interfaces:**
- Consumes: `buildDeckPptxBase64` from `../deck/pptxBuilder.js`, `improveExistingSlide` from `../deck/deckPlanner.js`, `replaceSlideInActivePresentation` / `insertDeckIntoActivePresentation` / `deleteSlidesInActivePresentation` / `toInsertTargetSlideId` from `../officeClient.js`, `orderPptActions` + `resolveDeleteTarget` + `invalidateDeckContext` (Tasks 4, 5, 7).
- Produces:
  - `executePptActions(actions, ctx, hooks) → { lines: string[], pendingDeletes: [{ op, slideIndex, id, title }] }`
  - `executeConfirmedDelete(descriptor) → string` (the report line)
  - `PPT_CHAT_BUILD` — build tag stamped on every write confirmation
  - `hooks` = `{ onProgress(text), signal, tone, instruction, styleId }`. `styleId` is not in the
    spec's hooks list; it is required because `buildDeckPptxBase64` needs a style id and
    `pptTools.js` must not read the DOM. `pptChat.js` supplies it from `#deck-style`.

- [ ] **Step 1: Write the failing test for target resolution**

`executePptActions` needs Office, so test only the pure resolution helper it uses. Append to `tests/pptTools.test.mjs`:

```js
import { resolveActionTarget } from "../src/chat/pptTools.js";

const ctx = {
  source: "extractor",
  slides: [
    { index: 1, id: "257", title: "Judul", text: "a", truncated: false },
    { index: 2, id: "258", title: "Agenda", text: "b", truncated: false },
    { index: 3, id: "", title: "Tanpa id", text: "c", truncated: false }
  ]
};

test("resolveActionTarget maps an index to the snapshot id", () => {
  assert.deepEqual(resolveActionTarget(ctx, 2), { id: "258", index: 2, title: "Agenda", text: "b" });
});

test("resolveActionTarget still resolves a slide with no id", () => {
  assert.deepEqual(resolveActionTarget(ctx, 3), { id: "", index: 3, title: "Tanpa id", text: "c" });
});

test("resolveActionTarget returns null outside the snapshot", () => {
  assert.equal(resolveActionTarget(ctx, 0), null);
  assert.equal(resolveActionTarget(ctx, 9), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveActionTarget is not a function`.

- [ ] **Step 3: Implement the executor**

Add to `src/chat/pptTools.js`:

```js
import { buildDeckPptxBase64 } from "../deck/pptxBuilder.js";
import { improveExistingSlide } from "../deck/deckPlanner.js";
import {
  deleteSlidesInActivePresentation,
  insertDeckIntoActivePresentation,
  replaceSlideInActivePresentation,
  toInsertTargetSlideId
} from "../officeClient.js";

export function resolveActionTarget(ctx, index) {
  const slides = Array.isArray(ctx?.slides) ? ctx.slides : [];
  const slide = slides.find((entry) => entry.index === index);
  if (!slide) return null;
  return { id: str(slide.id), index: slide.index, title: str(slide.title), text: str(slide.text) };
}

function specFor(slide, title) {
  return { title: title || str(slide.headline) || "Tantular", slides: [slide] };
}

// Stamped onto every write confirmation, same convention as DECK_STUDIO_BUILD
// in taskpane.js — a screenshot of the chat then identifies the code version.
export const PPT_CHAT_BUILD = "0.1.0-ppt-chat";

// ctx is IMMUTABLE for the whole turn: every target is resolved from the
// original snapshot before anything executes, so no action ever reads a deck
// state that a sibling action just changed.
export async function executePptActions(actions, ctx, hooks = {}) {
  const { onProgress = () => {}, signal, tone = "", instruction = "", styleId = "nusantara" } = hooks;
  const lines = [];
  const pendingDeletes = [];
  if (!actions.length) return { lines, pendingDeletes };

  const planned = orderPptActions(actions).map((action) => ({
    action,
    target: resolveActionTarget(ctx, action.op === "add_slide" ? action.afterIndex : action.slideIndex)
  }));

  let wrote = false;
  for (const { action, target } of planned) {
    if (signal?.aborted) { lines.push("⏹ Dihentikan oleh pengguna."); break; }
    if (!target) {
      lines.push(`❌ ${action.op}: slide tidak ada di snapshot deck.`);
      continue;
    }

    try {
      if (action.op === "delete_slide") {
        pendingDeletes.push({
          op: "delete_slide", slideIndex: target.index, id: target.id, title: target.title
        });
        lines.push(`⏸ Hapus slide ${target.index} ("${target.title}") menunggu konfirmasi.`);
        continue;
      }

      if (action.op === "improve_slide") {
        if (!target.text) {
          lines.push(`❌ Slide ${target.index} tidak punya teks yang bisa dibaca untuk diperbaiki.`);
          continue;
        }
        onProgress(`Menyusun versi lebih baik untuk slide ${target.index}...`);
        const result = await improveExistingSlide({
          slideText: target.text, tone, instruction, signal
        });
        if (!result?.spec) {
          lines.push(`❌ Slide ${target.index}: model tidak mengembalikan slide yang valid.`);
          continue;
        }
        onProgress(`Mengganti slide ${target.index}...`);
        const outcome = await replaceSlideInActivePresentation(
          buildDeckPptxBase64(result.spec, styleId, instruction),
          { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
        );
        if (outcome.replaced) { wrote = true; lines.push(`✅ Slide ${target.index} diperbaiki di tempat.`); }
        else lines.push(`❌ Slide ${target.index}: ${outcome.reason || "penggantian gagal."}`);
        continue;
      }

      if (action.op === "replace_slide") {
        onProgress(`Mengganti slide ${target.index}...`);
        const outcome = await replaceSlideInActivePresentation(
          buildDeckPptxBase64(specFor(action.slide), styleId, instruction),
          { slideId: target.id, slideIndex: target.index, formatting: "UseDestinationTheme" }
        );
        if (outcome.replaced) { wrote = true; lines.push(`✅ Slide ${target.index} diganti.`); }
        else lines.push(`❌ Slide ${target.index}: ${outcome.reason || "penggantian gagal."}`);
        continue;
      }

      // add_slide
      if (!target.id) {
        lines.push(`❌ Slide ${target.index} tidak punya id, jadi posisi sisipan tidak bisa dipastikan.`);
        continue;
      }
      onProgress(`Menyisipkan slide setelah slide ${target.index}...`);
      await insertDeckIntoActivePresentation(
        buildDeckPptxBase64(specFor(action.slide), styleId, instruction),
        { formatting: "UseDestinationTheme", targetSlideId: toInsertTargetSlideId(target.id) }
      );
      wrote = true;
      lines.push(`✅ Slide baru "${str(action.slide.headline) || "tanpa judul"}" disisipkan setelah slide ${target.index}.`);
    } catch (error) {
      lines.push(`❌ ${action.op} slide ${target.index}: ${error?.message || error}`);
    }
  }

  // Clear once, after the turn's writes. A pending delete is not a write.
  if (wrote) {
    invalidateDeckContext();
    lines.push(`(${PPT_CHAT_BUILD})`);
  }
  return { lines, pendingDeletes };
}

export async function executeConfirmedDelete(descriptor) {
  const { readLiveSlideIds } = await import("../officeClient.js");
  const liveIds = await readLiveSlideIds();
  const target = resolveDeleteTarget(liveIds, descriptor);
  if (!target.ok) return `❌ ${target.reason}`;
  const outcome = await deleteSlidesInActivePresentation([target.id]);
  if (!outcome.deleted) return `❌ Slide ${target.index}: ${outcome.reason}`;
  invalidateDeckContext();
  return `✅ Slide ${target.index} ("${str(descriptor?.title)}") dihapus. (${PPT_CHAT_BUILD})`;
}
```

- [ ] **Step 4: Add the readLiveSlideIds export officeClient is missing**

`executeConfirmedDelete` needs the live id list. Add to `src/officeClient.js`:

```js
// Live slide ids in visual order. Used to detect a deck that moved between a
// delete proposal and its confirmation.
export async function readLiveSlideIds() {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    const collection = context.presentation.slides;
    collection.load("items");
    await context.sync();
    for (const slide of collection.items || []) slide.load("id");
    await context.sync();
    return (collection.items || []).map((slide) => String(slide.id || ""));
  });
}
```

Then change the dynamic import in `executeConfirmedDelete` to a static one — add `readLiveSlideIds` to the existing `../officeClient.js` import list in `pptTools.js` and delete the `await import(...)` line.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/chat/pptTools.js src/officeClient.js tests/pptTools.test.mjs
git commit -m "feat: PowerPoint chat action executor with confirm-gated delete"
```

---

### Task 9: pptChat.js — the pane

**Files:**
- Create: `src/chat/pptChat.js`
- Modify: `src/chat/chatPane.js:16-26`

**Interfaces:**
- Consumes: everything from `pptTools.js`, `runTantular` from `../tantularClient.js`, `createHistory` from `./history.js`, `extractJsonObject` from `../deck/deckPlanner.js`.
- Produces: `mountPptChatPane()`.

- [ ] **Step 1: Create the pane module**

Create `src/chat/pptChat.js`:

```js
// Agentic PowerPoint chat: freestyle instructions over the active deck.
// One model call plans JSON actions (improve/replace/add/delete slide) grounded
// in a deck snapshot; pptTools sanitizes, orders, and executes them. Deletes are
// proposed here and only run after the user clicks confirm.
// This file must never touch an Office/PowerPoint API directly.

import { runTantular } from "../tantularClient.js";
import { extractJsonObject } from "../deck/deckPlanner.js";
import { createHistory } from "./history.js";
import {
  deckContextToPromptText,
  executeConfirmedDelete,
  executePptActions,
  getDeckContext,
  sanitizePptActions
} from "./pptTools.js";

const PPT_CHAT_SYSTEM = `Anda adalah Tantular, asisten PowerPoint agentic berbahasa Indonesia.
Anda menerima snapshot deck aktif (daftar slide beserta teksnya) dan permintaan pengguna, lalu membalas SATU objek JSON valid:
{
  "reply": "jawaban singkat dan jelas untuk pengguna (Bahasa Indonesia)",
  "actions": []
}

Aksi yang tersedia di "actions" (kosongkan jika pengguna hanya bertanya):
- {"op":"improve_slide","slideIndex":4}  → perbaiki slide yang sudah ada; JANGAN sertakan konten, Tantular yang menyusunnya dari teks slide asli.
- {"op":"replace_slide","slideIndex":3,"slide":{...}}  → ganti slide dengan konten yang Anda tulis sendiri.
- {"op":"add_slide","afterIndex":5,"slide":{...}}  → sisipkan slide baru setelah slide 5.
- {"op":"delete_slide","slideIndex":7}  → usulkan penghapusan; pengguna harus mengonfirmasi.

Bentuk objek "slide" (pilih type sesuai isi):
- {"type":"title","headline":"...","subhead":"..."}
- {"type":"bullets"|"agenda","headline":"...","bullets":["..."]}
- {"type":"cards","headline":"...","cards":[{"title":"...","desc":"..."}]}
- {"type":"columns","headline":"...","columns":[{"title":"...","points":["..."]}]}
- {"type":"metrics","headline":"...","metrics":[{"value":"92%","label":"..."}]}
- {"type":"visualization","headline":"...","chartType":"bar|line|heatmap","data":[{"label":"...","value":0}]}
- {"type":"quote","quote":"...","subhead":"atribusi"}
- {"type":"closing","headline":"..."}

Aturan WAJIB:
- Dasarkan semua slideIndex pada nomor slide di snapshot. Jangan mengarang nomor slide.
- Untuk memperbaiki slide yang sudah ada, PAKAI improve_slide. Jangan menulis ulang isinya sendiri lewat replace_slide.
- JUJUR terhadap snapshot: jangan mengklaim sesuatu sudah beres kecuali teks slide di snapshot membuktikannya.
- Snapshot bisa terpotong. Jangan menyimpulkan sebuah slide kosong hanya karena teksnya tidak terlihat penuh.
- Jangan mengarang angka, nama, atau fakta yang tidak ada di deck.
- Setiap slide harus punya "headline" (kecuali quote, yang boleh hanya "quote"), dan type berkonten harus punya arraynya (bullets/cards/columns/metrics/data) yang tidak kosong.
- Menyisipkan di posisi paling depan belum didukung; afterIndex minimal 1.
- Maksimum 8 aksi per giliran. Jika permintaan lebih besar, kerjakan yang terpenting dan jelaskan sisanya di "reply".
- Jika permintaan tidak bisa dipenuhi dengan aksi yang tersedia, actions kosong dan jelaskan alasannya di "reply".
- Balas HANYA JSON. Tanpa markdown, tanpa teks lain.`;

export function mountPptChatPane() {
  const card = document.querySelector("#chat-card");
  if (!card) return;
  card.classList.remove("hidden");

  const els = {
    messages: card.querySelector("#chat-messages"),
    input: card.querySelector("#chat-input"),
    send: card.querySelector("#chat-send"),
    stop: card.querySelector("#chat-stop"),
    pill: card.querySelector("#chat-context-pill"),
    chips: card.querySelector("#chat-chips")
  };
  const history = createHistory({ maxChars: 4000 });
  const state = { abort: null, busy: false };

  els.pill.textContent = "Konteks: deck aktif";
  els.pill.title = "Klik untuk membaca ulang deck aktif";
  els.pill.addEventListener("click", () => reloadDeck());
  renderChips();

  els.send.addEventListener("click", () => send());
  els.stop.addEventListener("click", () => state.abort?.abort());
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  // Deck Studio owns tone/style/project instructions; the chat reuses them so
  // slides it writes match the ones Deck Studio generates.
  function deckSettings() {
    return {
      tone: document.querySelector("#deck-tone")?.value.trim() || "",
      instruction: document.querySelector("#deck-project-instructions")?.value.trim() || "",
      styleId: document.querySelector("#deck-style")?.value || "nusantara"
    };
  }

  function renderChips() {
    const prompts = [
      "Ringkas isi deck ini",
      "Perbaiki slide 2 supaya lebih ringkas",
      "Tambahkan slide penutup dengan next step",
      "Slide mana yang paling padat teksnya?"
    ];
    for (const prompt of prompts) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-chip";
      chip.textContent = prompt;
      chip.addEventListener("click", () => {
        els.input.value = prompt;
        els.input.focus();
      });
      els.chips.appendChild(chip);
    }
  }

  function addBubble(cls, text = "") {
    const div = document.createElement("div");
    div.className = `chat-bubble ${cls}`;
    div.textContent = text;
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
    return div;
  }

  function addDeleteConfirm(descriptor, bubble) {
    const row = document.createElement("div");
    row.className = "chat-actions";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = `Hapus slide ${descriptor.slideIndex}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Batal";

    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = "Menghapus...";
      const line = await executeConfirmedDelete(descriptor);
      row.remove();
      bubble.textContent = `${bubble.textContent}\n${line}`;
    });
    cancel.addEventListener("click", () => {
      row.remove();
      bubble.textContent = `${bubble.textContent}\n⏹ Penghapusan slide ${descriptor.slideIndex} dibatalkan.`;
    });

    row.appendChild(confirm);
    row.appendChild(cancel);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  async function reloadDeck() {
    if (state.busy) return;
    const bubble = addBubble("assistant", "Membaca ulang deck aktif...");
    try {
      const ctx = await getDeckContext({ force: true });
      bubble.textContent = `Deck dimuat ulang: ${ctx.meta}`;
    } catch (error) {
      bubble.textContent = String(error?.message || error);
      bubble.classList.add("error");
    }
  }

  async function send() {
    const message = els.input.value.trim();
    if (!message || state.busy) return;
    els.input.value = "";
    addBubble("user", message);
    const answer = addBubble("assistant", "Membaca deck aktif...");
    state.busy = true;
    state.abort = new AbortController();
    els.stop.classList.remove("hidden");

    try {
      const ctx = await getDeckContext();
      els.pill.textContent = `Konteks: deck aktif (${ctx.source})`;
      answer.textContent = "Menyusun rencana...";

      const { tone, instruction, styleId } = deckSettings();
      const raw = await runTantular({
        system: PPT_CHAT_SYSTEM,
        user: `Snapshot deck:\n"""${deckContextToPromptText(ctx)}"""\n\n`
          + `Tone deck: ${tone || "profesional, jelas, executive"}\n`
          + `Style guide / instruksi project:\n"""${instruction || "tidak ada"}"""\n\n`
          + `Riwayat singkat:\n${history.toMessages().map((m) => `${m.role}: ${m.content}`).join("\n") || "-"}\n\n`
          + `Permintaan pengguna:\n"""${message}"""`,
        maxTokens: 3000,
        temperature: 0.15,
        task: "deck",
        jsonMode: true,
        signal: state.abort.signal
      });

      const parsed = extractJsonObject(raw);
      if (!parsed || typeof parsed.reply !== "string") {
        throw new Error("Model tidak mengembalikan rencana JSON yang valid. Coba ulangi atau perjelas permintaannya.");
      }

      const { actions, rejected } = sanitizePptActions(parsed.actions, ctx.slides.length);
      answer.textContent = actions.length
        ? `${parsed.reply}\n\nMenjalankan ${actions.length} aksi...`
        : parsed.reply;

      const { lines, pendingDeletes } = await executePptActions(actions, ctx, {
        onProgress: (text) => { answer.textContent = `${parsed.reply}\n\n${text}`; },
        signal: state.abort.signal,
        tone,
        instruction,
        styleId
      });

      answer.textContent = [parsed.reply, "", ...lines, ...rejected.map((r) => `⚠️ ${r}`)]
        .join("\n").trim();
      for (const descriptor of pendingDeletes) addDeleteConfirm(descriptor, answer);

      history.add("user", message);
      history.add("assistant", parsed.reply);
    } catch (error) {
      console.error("[TantularChat/PPT]", error, error?.debugInfo);
      answer.textContent = String(error?.message || error || "Terjadi kesalahan.");
      answer.classList.add("error");
    } finally {
      state.busy = false;
      state.abort = null;
      els.stop.classList.add("hidden");
    }
  }
}
```

- [ ] **Step 2: Route PowerPoint to the new pane**

In `src/chat/chatPane.js`, add above the `if (host !== "Word") return;` line:

```js
  if (host === "PowerPoint") {
    // Agentic deck chat: plan-and-execute over the active presentation instead
    // of the Word document pipelines.
    import("./pptChat.js").then(({ mountPptChatPane }) => mountPptChatPane());
    return;
  }
```

- [ ] **Step 3: Verify the isolation constraints hold**

Run: `grep -nE "\b(Office|PowerPoint)\b" src/chat/pptChat.js`
Expected: no output — the pane touches no host API.

Run: `grep -n "taskpane" src/chat/pptTools.js`
Expected: no output — no import cycle.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/pptChat.js src/chat/chatPane.js
git commit -m "feat: agentic PowerPoint chat pane"
```

---

### Task 10: Manual verification in PowerPoint

No automated test can reach these. Run every case and record the result; fix what fails before declaring the feature done.

**Files:**
- Modify: `src/chat/pptChat.js` or `src/chat/pptTools.js` as defects surface.

- [ ] **Step 1: Set up**

```bash
node tools/dev-server.mjs
```

Open PowerPoint with a 5+ slide deck. If the pane looks stale, delete `~/Library/Containers/com.microsoft.PowerPoint/Data/Library/Caches/WebKit` and `Cmd+Q` PowerPoint first.

- [ ] **Step 2: Confirm the chat card appears at all**

Open the pane in PowerPoint. Expected: the 💬 Tantular Chat card is visible with deck chips, and Deck Studio + Improve Existing Deck are still there.

- [ ] **Step 3: Read-only turn**

Send "Ringkas isi deck ini". Expected: a summary grounded in real slide content, zero actions, and the pill reads `Konteks: deck aktif (host)` or `(extractor)`.

- [ ] **Step 4: Improve a slide**

Send "Perbaiki slide 3 supaya lebih ringkas". Expected: `✅ Slide 3 diperbaiki di tempat.` and slide 3 is replaced **in position**, not appended at the end.

- [ ] **Step 5: Replace and add**

Send "Ganti judul slide 2 jadi 'Ruang Lingkup'" then "Tambahkan slide penutup setelah slide 5". Expected: both land in the right position with `✅` lines.

- [ ] **Step 6: Delete — confirm and decline**

Send "Hapus slide 4". Expected: a `⏸` line plus a confirm button; nothing is deleted yet. Click Batal → cancellation line, slide still there. Repeat and click confirm → slide gone, `✅` line.

- [ ] **Step 7: Delete a slide that is currently selected**

Select slide 4 in the thumbnail panel, then ask to delete slide 4 and confirm. Expected: the honest failure — "Slide tidak terhapus — kemungkinan sedang terpilih di panel thumbnail." — never a false `✅`.

- [ ] **Step 8: Stale-deck confirmation**

Ask to delete a slide, then manually delete a *different* slide in PowerPoint before clicking confirm. Expected: the stale-deck warning, and no slide removed by the chat.

- [ ] **Step 9: Companion stopped**

Stop the Python companion. If Probe A showed `source === "extractor"`, send any message and expect "Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan..." If Probe A showed `source === "host"`, the chat should keep working — note that in the results.

- [ ] **Step 10: Abort**

Send a multi-slide instruction and click Stop mid-run. Expected: `⏹ Dihentikan oleh pengguna.` and no further slides mutated.

- [ ] **Step 11: Commit any fixes**

```bash
npm test
git add -A
git commit -m "fix: PowerPoint chat defects found in manual verification"
```

- [ ] **Step 12: Update the memory file**

Add the probe outcomes and any new host limits discovered here to
`~/.claude/projects/-Users-raditio-ghifiardigmail-com-2026-Reference---Knowledge-Based-Information-AI-LLM-godel-agent-prototype/memory/tantular-word-host-limits.md`,
so the next session starts from measured facts rather than re-probing.

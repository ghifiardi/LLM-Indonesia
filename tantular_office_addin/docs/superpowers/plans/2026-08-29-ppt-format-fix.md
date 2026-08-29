# PowerPoint "Perbaiki format" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PowerPoint-only "Perbaiki format" action that fixes a selected slide's font size/style/proportion by regenerating it from the Deck Studio style engine — with the wording preserved exactly, verbatim, never rephrased.

**Architecture:** Reuses the "Improve Existing Deck" pipeline (read slide text via the companion extractor → LLM step → preview → build PPTX → insert-and-replace) almost entirely. The only new LLM step classifies existing text into a DeckSpec's structure (bullets/cards/columns/metrics) without rewriting it; all font/size/color values still come from the existing, unmodified `deckStyles.js`/`pptxBuilder.js` engine.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test` + `node:assert/strict`, Office.js (PowerPoint), no new dependencies.

**Spec:** `tantular_office_addin/docs/superpowers/specs/2026-08-29-ppt-format-fix-design.md`

## Global Constraints

- **PowerPoint only.** No changes to Word or Excel code paths.
- **No live in-place shape editing.** All slide changes go through regenerate-and-replace (`buildDeckPptxBase64` → `replaceSlideInActivePresentation`), never direct `shape.textFrame` mutation.
- **No LLM-guessed formatting values.** Font size/family/color come only from `deckStyles.js` type_scale/font tokens and `pptxBuilder.js`'s existing `fitText`/`fitBox`. The model's only job is structure classification.
- **Verbatim wording, always.** Every text field in the final slide must be an exact (whitespace-normalized) substring of the source slide text, except `pptxBuilder`'s own chrome/footer, which is outside the DeckSpec and unconditional for every slide already.
- **`normalizeSlide()` / `normalizeSpec()` must never be called by the new code.** They inject synthetic placeholder text, forced closing slides, and non-verbatim fallback headlines — see spec point 2.
- **`buildDeckPptxBase64()` keeps its exact current signature and behavior.** The diagnostics addition is a separate, additive wrapper; no existing call site changes.
- **`fitText`/`fitBox` keep their exact current behavior for every existing caller.** The diagnostics hook is opt-in and a no-op when not collecting.
- Every new exported function needs a docstring-style comment explaining *why*, matching this codebase's existing convention (see `improveExistingSlide`, `parseEditContract` for examples) — not restating *what* the code does.

---

## Task 1: Verbatim-check primitives (`rawFirstLine`, `assertVerbatimSlide`)

**Files:**
- Modify: `src/deck/deckPlanner.js` (add near the bottom, after `hasSubstantiveSlideContent` at line 913)
- Test: `tests/deckPlanner.test.mjs`

**Interfaces:**
- Consumes: nothing new (pure functions over strings/objects already in scope)
- Produces:
  - `function rawFirstLine(source: string): string` — first non-empty line of `source`, untruncated (unlike the existing `firstLine()`, which appends `"..."` past 90 chars — synthetic text this feature must never introduce)
  - `function assertVerbatimSlide(slide: {type, headline, subhead?, bullets?, cards?, columns?, metrics?} | null, source: string): (same shape) | null` — drops any non-verbatim field/list-item; returns `null` if nothing usable survives

- [ ] **Step 1: Write the failing tests**

Add to `tests/deckPlanner.test.mjs` (extend the existing `import` block at the top with the two new names):

```javascript
import {
  expandSlidesToCount,
  inferRequestedSlideCount,
  isThinContent,
  looksLikePresentationBrief,
  rawFirstLine,
  assertVerbatimSlide
} from "../src/deck/deckPlanner.js";

// --- rawFirstLine -----------------------------------------------------------

test("rawFirstLine returns the first non-empty line, untruncated", () => {
  const source = "\n\nDunia menyaksikan perkembangan bioteknologi yang pesat khususnya di bidang Regenerative Medicine dalam satu dekade ini, mencakup lebih dari seratus dua puluh karakter agar terlihat panjang.\nBaris kedua.";
  const result = rawFirstLine(source);
  assert.equal(result, "Dunia menyaksikan perkembangan bioteknologi yang pesat khususnya di bidang Regenerative Medicine dalam satu dekade ini, mencakup lebih dari seratus dua puluh karakter agar terlihat panjang.");
  assert.ok(!result.includes("..."), "must never truncate — that would inject text not in the source");
});

test("rawFirstLine returns empty string for blank/whitespace-only source", () => {
  assert.equal(rawFirstLine(""), "");
  assert.equal(rawFirstLine("   \n  \n"), "");
});

// --- assertVerbatimSlide -----------------------------------------------------

const SOURCE = `Judul Slide Asli
Bullet pertama yang benar.
Bullet kedua yang benar.
Bullet ketiga yang benar.`;

test("assertVerbatimSlide keeps a fully verbatim bullets slide unchanged", () => {
  const slide = {
    type: "bullets",
    headline: "Judul Slide Asli",
    subhead: "",
    bullets: ["Bullet pertama yang benar.", "Bullet kedua yang benar."]
  };
  const result = assertVerbatimSlide(slide, SOURCE);
  assert.deepEqual(result, slide);
});

test("assertVerbatimSlide drops individual non-verbatim bullets, keeps the rest", () => {
  const slide = {
    type: "bullets",
    headline: "Judul Slide Asli",
    bullets: [
      "Bullet pertama yang benar.",
      "Bullet ini dikarang model dan tidak ada di sumber.",
      "Bullet ketiga yang benar."
    ]
  };
  const result = assertVerbatimSlide(slide, SOURCE);
  assert.deepEqual(result.bullets, ["Bullet pertama yang benar.", "Bullet ketiga yang benar."]);
});

test("assertVerbatimSlide falls back to rawFirstLine when headline is not verbatim", () => {
  const slide = { type: "bullets", headline: "Judul yang dikarang model", bullets: ["Bullet pertama yang benar."] };
  const result = assertVerbatimSlide(slide, SOURCE);
  assert.equal(result.headline, "Judul Slide Asli");
});

test("assertVerbatimSlide tolerates whitespace differences (normalized match)", () => {
  const slide = { type: "bullets", headline: "Judul Slide Asli", bullets: ["Bullet   pertama  yang benar."] };
  const result = assertVerbatimSlide(slide, SOURCE);
  assert.deepEqual(result.bullets, ["Bullet   pertama  yang benar."]);
});

test("assertVerbatimSlide returns null when a bullets slide has zero verbatim bullets", () => {
  const slide = { type: "bullets", headline: "Judul Slide Asli", bullets: ["Ini dikarang.", "Ini juga dikarang."] };
  assert.equal(assertVerbatimSlide(slide, SOURCE), null);
});

test("assertVerbatimSlide drops a whole card when its title is not verbatim", () => {
  const cardSource = "Fitur A\nDeskripsi fitur A yang asli.\nFitur B\nDeskripsi fitur B yang asli.";
  const slide = {
    type: "cards",
    headline: "Fitur",
    cards: [
      { title: "Fitur A", desc: "Deskripsi fitur A yang asli." },
      { title: "Fitur Palsu", desc: "Deskripsi fitur A yang asli." }
    ]
  };
  const result = assertVerbatimSlide(slide, cardSource);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].title, "Fitur A");
});

test("assertVerbatimSlide drops a whole column when its title is not verbatim", () => {
  const colSource = "Sebelum\nLebih lambat.\nSesudah\nLebih cepat.";
  const slide = {
    type: "columns",
    headline: "Perbandingan",
    columns: [
      { title: "Sebelum", points: ["Lebih lambat."] },
      { title: "Kolom Karangan", points: ["Lebih cepat."] }
    ]
  };
  const result = assertVerbatimSlide(slide, colSource);
  assert.equal(result.columns.length, 1);
  assert.equal(result.columns[0].title, "Sebelum");
});

test("assertVerbatimSlide returns null for null input", () => {
  assert.equal(assertVerbatimSlide(null, SOURCE), null);
});

test("assertVerbatimSlide returns null for an unsupported slide type", () => {
  const slide = { type: "visualization", headline: "Judul Slide Asli", data: [{ label: "x", value: 1 }] };
  assert.equal(assertVerbatimSlide(slide, SOURCE), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A3 "rawFirstLine\|assertVerbatimSlide"`
Expected: FAIL — `rawFirstLine`/`assertVerbatimSlide` are not exported (import error) or undefined.

- [ ] **Step 3: Implement `rawFirstLine` and `assertVerbatimSlide`**

Add to `src/deck/deckPlanner.js`, after the `hasSubstantiveSlideContent` function (currently ending around line 913 — search for `function hasSubstantiveSlideContent` to find the exact spot) and before the file's closing content:

```javascript
// --- Perbaiki format (formatting-only fix) -----------------------------------
// Reuses the "Improve Existing Deck" read/render/replace pipeline, but the LLM
// step here (fixSlideFormatting, further below) only classifies structure —
// it must never rephrase, shorten, or invent text. These two helpers enforce
// that: rawFirstLine() is a truncation-free sibling of firstLine() (that one
// appends "..." past 90 chars — synthetic text this feature can't allow), and
// assertVerbatimSlide() is deliberately stricter than enforceSourceGrounding()
// above, which only checks vocabulary overlap. A model reproducing a whole
// sentence is far more likely to drift on ONE bullet than to invent a
// completely new one, so — same reasoning as parseEditContract's per-item
// drop (src/chat/editContract.js) — a single bad list entry is dropped, not
// the whole slide. A bad headline instead falls back to the source's own
// first line, since a slide without a headline isn't a usable result.

function normalizeVerbatimWs(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function rawFirstLine(source) {
  const line = String(source || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line || "";
}

export function assertVerbatimSlide(slide, source) {
  if (!slide) return null;
  const haystack = normalizeVerbatimWs(source);
  const isVerbatim = (text) => {
    const needle = normalizeVerbatimWs(text);
    return Boolean(needle) && haystack.includes(needle);
  };

  const headline = isVerbatim(slide.headline) ? slide.headline : rawFirstLine(source);
  if (!headline) return null;
  const clean = {
    type: slide.type,
    headline,
    subhead: isVerbatim(slide.subhead) ? slide.subhead : ""
  };

  if (slide.type === "bullets" || slide.type === "agenda" || slide.type === "closing") {
    clean.bullets = toStringList(slide.bullets).filter(isVerbatim);
    return clean.bullets.length ? clean : null;
  }

  if (slide.type === "cards") {
    clean.cards = toObjectList(slide.cards, "title", "desc")
      .filter((card) => isVerbatim(card.title) && (!card.desc || isVerbatim(card.desc)));
    return clean.cards.length ? clean : null;
  }

  if (slide.type === "columns") {
    clean.columns = (Array.isArray(slide.columns) ? slide.columns : [])
      .map((col) => ({
        title: str(col?.title),
        points: toStringList(col?.points).filter(isVerbatim)
      }))
      .filter((col) => isVerbatim(col.title) && col.points.length);
    return clean.columns.length ? clean : null;
  }

  if (slide.type === "metrics") {
    clean.metrics = toObjectList(slide.metrics, "value", "label")
      .filter((m) => isVerbatim(m.value) && isVerbatim(m.label));
    return clean.metrics.length ? clean : null;
  }

  // Any other type ("title", "quote", "visualization", ...) is out of scope
  // for format-fix classification — normalizeSlide() doesn't robustly
  // extract them either (see the spec's Testing section), and none of them
  // is central to the reported pain points (overflow, inconsistent sizing,
  // wrong font), which bullets/cards/columns/metrics already cover.
  return null;
}
```

This reuses the already-private `str`, `toStringList`, `toObjectList` helpers defined earlier in the same file (lines 458–490) — no new imports needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all new tests green, existing suite count increased by 12, nothing else broken.

- [ ] **Step 5: Commit**

```bash
cd "tantular_office_addin" && git add src/deck/deckPlanner.js tests/deckPlanner.test.mjs
git commit -m "$(cat <<'EOF'
feat(deck): add verbatim-check primitives for format-only slide fixes

rawFirstLine() is a truncation-free sibling of firstLine() (which appends
"..." past 90 chars — synthetic text a verbatim-preservation feature can't
introduce). assertVerbatimSlide() is stricter than enforceSourceGrounding()
(vocabulary overlap only): every text field must be an exact,
whitespace-normalized substring of the source, with individual bad list
items dropped rather than the whole slide — same philosophy as
parseEditContract's per-item drop in editContract.js.

Building block for the upcoming "Perbaiki format" feature (formatting-only
slide fix, wording untouched).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `fixSlideFormatting()` — structure classification, wording untouched

**Files:**
- Modify: `src/deck/deckPlanner.js`
- Test: `tests/deckPlanner.test.mjs`

**Interfaces:**
- Consumes: `rawFirstLine`, `assertVerbatimSlide` (Task 1); `runTantular` (already imported at line 5); `extractJsonObject` (already in this file, line 141); `str`, `toStringList` (already in this file)
- Produces: `async function fixSlideFormatting({ slideText, signal }): Promise<{ spec: {title, subtitle, slides: [slide]} | null, source: "model-verbatim" | "fallback" | "fallback-unverifiable" | "empty" }>` — same return shape as `improveExistingSlide` so it flows through the exact same `buildDeckPptxBase64`/preview/replace code in Task 4 unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/deckPlanner.test.mjs`. This mocks `runTantular` the same way other tests in this codebase mock `fetch` — via `globalThis.fetch` stubbing plus a stubbed `localStorage`, since `runTantular` (in `src/tantularClient.js`) reads settings from `localStorage` and calls `fetch`. Add near the bottom of the file:

```javascript
import { fixSlideFormatting } from "../src/deck/deckPlanner.js";

async function withMockedTantular(replyContent, run) {
  const originalFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: replyContent } }] }),
    text: async () => ""
  });
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("fixSlideFormatting returns null spec for empty slide text", async () => {
  const result = await fixSlideFormatting({ slideText: "" });
  assert.deepEqual(result, { spec: null, source: "empty" });
});

test("fixSlideFormatting classifies bullets and preserves wording exactly", async () => {
  const source = "Manfaat Utama\nHemat waktu proses.\nMengurangi kesalahan input.\nMudah diaudit.";
  const modelReply = JSON.stringify({
    slide: {
      type: "bullets",
      headline: "Manfaat Utama",
      bullets: ["Hemat waktu proses.", "Mengurangi kesalahan input.", "Mudah diaudit."]
    }
  });
  const result = await withMockedTantular(modelReply, () => fixSlideFormatting({ slideText: source }));
  assert.equal(result.source, "model-verbatim");
  assert.equal(result.spec.slides.length, 1);
  assert.equal(result.spec.slides[0].headline, "Manfaat Utama");
  assert.deepEqual(result.spec.slides[0].bullets, [
    "Hemat waktu proses.",
    "Mengurangi kesalahan input.",
    "Mudah diaudit."
  ]);
});

test("fixSlideFormatting falls back to one-bullet-per-line when the model rephrases", async () => {
  const source = "Manfaat Utama\nHemat waktu proses.\nMudah diaudit.";
  const modelReply = JSON.stringify({
    slide: {
      type: "bullets",
      headline: "Manfaat Utama",
      // Paraphrased — none of these exact sentences are in the source.
      bullets: ["Meningkatkan efisiensi secara signifikan.", "Memudahkan proses audit menyeluruh."]
    }
  });
  const result = await withMockedTantular(modelReply, () => fixSlideFormatting({ slideText: source }));
  assert.equal(result.source, "fallback-unverifiable");
  assert.equal(result.spec.slides[0].headline, "Manfaat Utama");
  assert.deepEqual(result.spec.slides[0].bullets, ["Hemat waktu proses.", "Mudah diaudit."]);
});

test("fixSlideFormatting falls back to one-bullet-per-line when the model call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const source = "Manfaat Utama\nHemat waktu proses.\nMudah diaudit.";
    const result = await fixSlideFormatting({ slideText: source });
    assert.equal(result.source, "fallback");
    assert.equal(result.spec.slides[0].headline, "Manfaat Utama");
    assert.deepEqual(result.spec.slides[0].bullets, ["Hemat waktu proses.", "Mudah diaudit."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixSlideFormatting fallback never appends a closing slide or placeholder text", async () => {
  const source = "Satu-satunya baris.";
  const result = await fixSlideFormatting({ slideText: source }); // no mock — model call fails, hits fallback
  assert.equal(result.spec.slides.length, 1, "must return exactly one slide, never a title+closing pair");
  assert.notEqual(result.spec.slides[0].type, "closing");
  const flat = JSON.stringify(result.spec);
  assert.ok(!flat.includes("(Isi poin di sini.)"), "must never use normalizeSlide's placeholder copy");
  assert.ok(!flat.includes("Kesimpulan & Langkah Berikutnya"), "must never inject a synthetic closing headline");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A3 "fixSlideFormatting"`
Expected: FAIL — `fixSlideFormatting` is not exported/undefined.

- [ ] **Step 3: Implement `FORMAT_FIX_SYSTEM` and `fixSlideFormatting`**

Add to `src/deck/deckPlanner.js`, directly after the `assertVerbatimSlide` function from Task 1:

```javascript
const FORMAT_FIX_SYSTEM = `Anda adalah Tantular Deck Studio Productivity, asisten yang HANYA mengklasifikasi struktur slide — TIDAK menulis ulang isi.
Mode aktif: PRODUKTIVITAS PRESENTASI, bukan mode keamanan/fraud.
Tugas: baca teks SATU slide PowerPoint yang sudah ada, lalu susun ulang MENJADI struktur JSON tanpa mengubah satu kata pun.
Aturan WAJIB, lebih ketat dari tugas "perbaiki slide" biasa:
- SETIAP potongan teks pada "headline", "subhead", "bullets", "cards[].title", "cards[].desc", "columns[].title", "columns[].points", "metrics[].value", "metrics[].label" HARUS disalin PERSIS, kata demi kata, dari teks slide sumber. DILARANG KERAS memparafrasekan, meringkas, memperbaiki tata bahasa, menggabungkan kalimat, atau "meningkatkan" kalimat apa pun.
- Tugas Anda HANYA memutuskan: kalimat/baris mana yang menjadi headline, mana yang menjadi bullet, atau — jika teks sumber jelas berisi beberapa item berjudul (misalnya "Nama: penjelasan") — mana yang menjadi title/desc kartu atau title/points kolom.
- Jika ragu antara beberapa struktur, PILIH "bullets" — itu paling aman dan tidak memaksa penggabungan yang tidak ada di sumber.
- type HANYA boleh salah satu dari: "bullets", "cards", "columns", "metrics". Jangan pernah memakai type lain.
- Jangan menambah kalimat, angka, atau ide yang tidak eksplisit ada di teks slide sumber.
- Jawab HANYA dengan satu objek JSON valid, tanpa markdown/teks lain, bentuk:
{"slide":{"type":"bullets|cards|columns|metrics","headline":"...","subhead":"...","bullets":["..."],"cards":[{"title":"...","desc":"..."}],"columns":[{"title":"...","points":["..."]}],"metrics":[{"value":"...","label":"..."}]}}
Sertakan HANYA field yang relevan untuk type yang dipilih.`;

// Formatting-only fix: no wording changes, ever. Unlike improveExistingSlide,
// this deliberately skips normalizeSlide()/normalizeSpec() (see the design
// spec's "Verbatim guarantee" section) — those inject placeholder copy, a
// forced closing slide, and non-verbatim fallback headlines, all wrong for a
// feature whose entire point is preserving the user's exact words. Runs
// assertVerbatimSlide() as the final gate; anything that doesn't survive it
// degrades to formatFixFallbackSpec() rather than failing outright, since
// applying consistent formatting is the whole point and doesn't strictly
// require the model to succeed.
export async function fixSlideFormatting({ slideText, signal }) {
  const source = String(slideText || "").trim();
  if (!source) return { spec: null, source: "empty" };

  let raw = "";
  try {
    raw = await runTantular({
      system: FORMAT_FIX_SYSTEM,
      user: `Klasifikasikan struktur slide berikut TANPA mengubah kata apa pun.\n\nTeks slide sumber:\n"""${source}"""`,
      maxTokens: 900,
      temperature: 0,
      task: "deck",
      jsonMode: true,
      signal
    });
  } catch {
    return { spec: formatFixFallbackSpec(source), source: "fallback" };
  }

  const parsed = extractJsonObject(raw);
  // Same defensive fallback chain as improveExistingSlide above (parsed.slide
  // is the documented shape; parsed.slides?.[0] and a bare parsed object
  // cover a model that wraps in an array or skips the wrapper entirely).
  const candidate = parsed?.slide || parsed?.slides?.[0] || (parsed?.type ? parsed : null);
  const verified = candidate ? assertVerbatimSlide(sanitizeFormatFixCandidate(candidate), source) : null;
  if (!verified) return { spec: formatFixFallbackSpec(source), source: "fallback-unverifiable" };

  return {
    spec: { title: verified.headline, subtitle: "Perbaiki format — wording tidak diubah", slides: [verified] },
    source: "model-verbatim"
  };
}

// Coerces the model's raw JSON into the same shape normalizeSlide() would,
// WITHOUT any of normalizeSlide()'s placeholder-injection — a bad/missing
// field here is left absent so assertVerbatimSlide's own null-on-nothing-
// usable logic (Task 1) decides the outcome, not a synthetic string.
function sanitizeFormatFixCandidate(candidate) {
  const type = ["bullets", "cards", "columns", "metrics"].includes(candidate?.type) ? candidate.type : "bullets";
  return {
    type,
    headline: str(candidate?.headline),
    subhead: str(candidate?.subhead),
    bullets: candidate?.bullets,
    cards: candidate?.cards,
    columns: candidate?.columns,
    metrics: candidate?.metrics
  };
}

// Deterministic, always-available fallback: one bullet per non-empty source
// line. No sentence-splitting/truncation like improveFallbackSpec's
// splitIntoChunks (that appends "..." past 120 chars — synthetic text this
// feature can't allow) — a plain line split is verbatim by construction.
function formatFixFallbackSpec(source) {
  const lines = String(source || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const headline = rawFirstLine(source);
  const bullets = lines.filter((l) => l !== headline);
  return {
    title: headline,
    subtitle: "Perbaiki format — fallback deterministik",
    slides: [{
      type: "bullets",
      headline,
      subhead: "",
      bullets: bullets.length ? bullets : [headline]
    }]
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all new tests green.

- [ ] **Step 5: Commit**

```bash
cd "tantular_office_addin" && git add src/deck/deckPlanner.js tests/deckPlanner.test.mjs
git commit -m "$(cat <<'EOF'
feat(deck): add fixSlideFormatting() — structure classification, wording untouched

New FORMAT_FIX_SYSTEM prompt + fixSlideFormatting(), parallel to
IMPROVE_SLIDE_SYSTEM/improveExistingSlide but restricted to structure
classification only (type in bullets|cards|columns|metrics) — never
rephrasing. Every text field is verified verbatim against the source via
assertVerbatimSlide (Task 1); anything that fails degrades to a
deterministic one-bullet-per-line split rather than failing outright.

Deliberately bypasses normalizeSlide()/normalizeSpec() (see design spec) to
avoid their placeholder text, forced closing slides, and non-verbatim
fallback headlines.

Same return shape as improveExistingSlide ({spec, source}) so it flows
through the existing buildDeckPptxBase64/preview/replace pipeline unchanged
once wired to the UI (later task).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `pptxBuilder.js` diagnostics hook

**Files:**
- Modify: `src/deck/pptxBuilder.js`
- Test: `tests/deckStyles.test.mjs`

**Interfaces:**
- Consumes: nothing new
- Produces: `export function buildDeckPptxBase64WithDiagnostics(spec, styleId, projectInstructions = ""): { base64: string, truncated: string[] }` — `truncated` lists the original (pre-truncation) text of every element `fitText` had to cut. `buildDeckPptxBase64`'s own signature/behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/deckStyles.test.mjs`. Extend the existing import line at the top (currently `import { buildDeckPptxBase64, fitText } from "../src/deck/pptxBuilder.js";`) to also pull in the new export:

```javascript
import { buildDeckPptxBase64, buildDeckPptxBase64WithDiagnostics, fitText } from "../src/deck/pptxBuilder.js";
```

Then add near the existing `fitText`/overflow tests:

```javascript
test("buildDeckPptxBase64WithDiagnostics reports a truncation when fitText hard-truncates", () => {
  const spec = {
    ...SPEC,
    slides: [{
      type: "bullets",
      headline: "Judul",
      // Long enough to exceed even the smallest bullet-row font's character
      // budget in pptxBuilder's fitBox — same shape of input the existing
      // "overflow never breaks XML" test above already exercises.
      bullets: [Array(60).fill("kata").join(" ")]
    }]
  };
  const { base64, truncated } = buildDeckPptxBase64WithDiagnostics(spec, "nusantara");
  assert.ok(base64.length > 0);
  assert.ok(truncated.length >= 1, "a 240-word single bullet must be reported as truncated");
  assert.ok(truncated[0].startsWith("kata kata"));
});

test("buildDeckPptxBase64WithDiagnostics reports no truncation when content fits", () => {
  const spec = { ...SPEC, slides: [{ type: "bullets", headline: "Judul", bullets: ["Poin pendek."] }] };
  const { truncated } = buildDeckPptxBase64WithDiagnostics(spec, "nusantara");
  assert.deepEqual(truncated, []);
});

test("buildDeckPptxBase64WithDiagnostics produces byte-identical output to buildDeckPptxBase64", () => {
  const plain = buildDeckPptxBase64(SPEC, "nusantara");
  const { base64 } = buildDeckPptxBase64WithDiagnostics(SPEC, "nusantara");
  assert.equal(base64, plain, "the diagnostics wrapper must not alter rendering, only observe it");
});

test("buildDeckPptxBase64 behaves identically after the diagnostics hook is added (no regression)", () => {
  const short = fitText("Singkat", { maxChars: 40, baseSize: 28, minSize: 18 });
  assert.deepEqual(short, { text: "Singkat", size: 28 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A3 "buildDeckPptxBase64WithDiagnostics"`
Expected: FAIL — export doesn't exist yet.

- [ ] **Step 3: Implement the diagnostics collector**

In `src/deck/pptxBuilder.js`, modify the existing `fitText` function (currently at line 256) to report hard-truncations to an optional module-level sink, and add the new wrapper export. Replace:

```javascript
export function fitText(text, { maxChars = 80, baseSize = 18, minSize = 12, step = 2 } = {}) {
  const str = String(text ?? "");
  const safeStep = step > 0 ? step : 2;
  for (let size = baseSize; size >= minSize; size -= safeStep) {
    const budget = Math.round(maxChars * (baseSize / size));
    if (str.length <= budget) return { text: str, size };
  }
  const truncated = str.length > maxChars ? `${str.slice(0, maxChars)}…` : str;
  return { text: truncated, size: minSize };
}
```

with:

```javascript
// Opt-in, additive diagnostics: null when nothing is collecting, so every
// existing call site's behavior is byte-for-byte unchanged. Only
// buildDeckPptxBase64WithDiagnostics (below) ever sets this.
let truncationSink = null;

export function fitText(text, { maxChars = 80, baseSize = 18, minSize = 12, step = 2 } = {}) {
  const str = String(text ?? "");
  const safeStep = step > 0 ? step : 2;
  for (let size = baseSize; size >= minSize; size -= safeStep) {
    const budget = Math.round(maxChars * (baseSize / size));
    if (str.length <= budget) return { text: str, size };
  }
  const truncated = str.length > maxChars ? `${str.slice(0, maxChars)}…` : str;
  // Only the hard-truncate branch loses content; the shrink-only branch
  // above returns the SAME text at a smaller size, which needs no warning.
  if (truncated !== str && truncationSink) truncationSink.push(str);
  return { text: truncated, size: minSize };
}

// Formatting-only fixes (unlike freely-generated Deck Studio content) must
// never silently drop the user's real wording — see the design spec's
// "Truncation becomes visible" section. This wraps the EXISTING, completely
// unmodified buildDeckPptxBase64 to observe fitText's truncations during
// that one render, without changing buildDeckPptxBase64's own signature,
// return value, or behavior for any other caller.
export function buildDeckPptxBase64WithDiagnostics(spec, styleId, projectInstructions = "") {
  const sink = [];
  truncationSink = sink;
  try {
    const base64 = buildDeckPptxBase64(spec, styleId, projectInstructions);
    return { base64, truncated: sink };
  } finally {
    truncationSink = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all new tests green, plus rerun the full existing `deckStyles.test.mjs` suite to confirm zero regression:

Run: `node --test tests/deckStyles.test.mjs 2>&1 | tail -20`
Expected: PASS, same pass count as before this task plus the 4 new tests.

- [ ] **Step 5: Commit**

```bash
cd "tantular_office_addin" && git add src/deck/pptxBuilder.js tests/deckStyles.test.mjs
git commit -m "$(cat <<'EOF'
feat(deck): add opt-in truncation diagnostics to pptxBuilder

fitText's hard-truncate branch now reports the cut text to an optional
module-level collector — a no-op when nothing is collecting, so every
existing caller's return value and behavior stay byte-for-byte identical.
New buildDeckPptxBase64WithDiagnostics() wraps the existing, completely
unmodified buildDeckPptxBase64() to expose it as {base64, truncated}.

Needed for the upcoming "Perbaiki format" feature: silently cutting real
content is a bigger deal for a formatting-only fix (which promises to
preserve the user's exact wording) than for freely-generated Deck Studio
content, where the model can always choose different words to fit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UI — "Perbaiki format" button and handler

**Files:**
- Modify: `src/taskpane.html` (Deck Refine section, around line 407–427)
- Modify: `src/taskpane.js` (imports near line 24, `els` block near line 194, event wiring near line 506, new handler near line 1949)
- Manual validation: PowerPoint desktop, real deck

**Interfaces:**
- Consumes: `fixSlideFormatting` (Task 2), `buildDeckPptxBase64WithDiagnostics` (Task 3), and existing `getSelectedSlideTextContext`, `activeDeckSlideTextFallback`, `extractRequestedSlideIndex`, `replaceSlideInActivePresentation`, `triggerSpecDownload`, `renderRefinePreview`, `setRefineStatus`, `withRefineProgress`, `setRefineBusy`, `resetRefineOutput`, `deckStyleHints`, `state.refineSpec`/`state.refineTargetSlideId`/`state.refineTargetSlideIndex` — all already defined in `src/taskpane.js`.
- Produces: a working "🛠 Perbaiki format" button in the Deck Refine section of the PowerPoint pane.

- [ ] **Step 1: Add the button markup**

In `src/taskpane.html`, inside the `#deck-refine` section's button row (find `<button id="refine-run"` — currently around line 419), change:

```html
      <div class="button-row">
        <button id="refine-run" class="primary deck-build" type="button">🛠 Improve selected slide</button>
        <button id="refine-download" class="secondary" type="button">Download improved slide</button>
      </div>
```

to:

```html
      <div class="button-row">
        <button id="refine-run" class="primary deck-build" type="button">🛠 Improve selected slide</button>
        <button id="format-fix-run" class="primary deck-build" type="button">🛠 Perbaiki format</button>
        <button id="refine-download" class="secondary" type="button">Download improved slide</button>
      </div>
```

Also update the section's hint text (currently: `Untuk deck yang sudah kompleks: pilih satu slide, lalu Tantular membuat versi slide yang lebih jelas memakai style guide Deck Studio...`) so the new button's purpose is clear — right after that `<p class="hint">` (the one ending `...tidak menambah angka/fakta baru.</p>`), add:

```html
      <p class="hint">"Perbaiki format" TIDAK mengubah kata sama sekali — hanya menyesuaikan ukuran/gaya font dan proporsi memakai style guide Deck Studio yang sama.</p>
```

- [ ] **Step 2: Wire the element reference**

In `src/taskpane.js`, in the `els` object (find `refineHostNote: document.querySelector("#refine-host-note"),` — currently line 194), add directly after it:

```javascript
  formatFixRun: document.querySelector("#format-fix-run"),
```

- [ ] **Step 3: Import the new deck-planner/pptx-builder functions**

In `src/taskpane.js`, find the existing import from `pptxBuilder.js` (search for `buildDeckPptxBase64` in the import block near the top of the file) and add `buildDeckPptxBase64WithDiagnostics` alongside it. Find the existing import of `improveExistingSlide` from `./deck/deckPlanner.js` and add `fixSlideFormatting` alongside it. (Exact original import lines depend on how they're currently grouped — add the two new names to whichever existing `import { ... } from "./deck/deckPlanner.js"` / `import { ... } from "./deck/pptxBuilder.js"` statements already exist; do not add new import statements if compatible ones already exist.)

- [ ] **Step 4: Wire the button and write the handler**

In `src/taskpane.js`, find the existing wiring line `els.refineRun.addEventListener("click", refineSelectedSlide);` (currently line 505) and add directly after it:

```javascript
  els.formatFixRun.addEventListener("click", fixSelectedSlideFormatting);
```

Then, in `src/taskpane.js`, add the new handler function directly after `refineSelectedSlide` (find `async function refineSelectedSlide() { ... }` — currently ends around line 1862, right before `async function activeDeckSlideTextFallback`). Insert:

```javascript
// "Perbaiki format": same slide-read and insert-and-replace mechanics as
// refineSelectedSlide, but calls fixSlideFormatting (wording untouched) and
// renders through buildDeckPptxBase64WithDiagnostics so a truncated element
// can be reported instead of silently cut — see the design spec.
async function fixSelectedSlideFormatting() {
  if (state.host !== "PowerPoint") {
    return setRefineStatus("Perbaiki format hanya tersedia di PowerPoint.", "error");
  }

  await withRefineProgress("Membaca slide terpilih...", async () => {
    resetRefineOutput();
    const selected = await getSelectedSlideTextContext();
    const selectedSlideCount = Math.max(
      new Set(selected.slideIds || []).size,
      new Set(selected.slideIndexes || []).size
    );
    if (selectedSlideCount > 1) {
      throw new Error("Pilih tepat satu slide di panel thumbnail sebelum menjalankan Perbaiki format.");
    }
    let slideText = selected.text.trim();
    const knowsSlide = Boolean(selected.slideIds?.length || selected.slideIndexes?.length);
    if (!slideText || (selected.partialSelection && knowsSlide)) {
      els.refineProgressText.textContent = "Membaca teks lengkap slide dari active deck...";
      const fullText = await activeDeckSlideTextFallback(selected, "");
      if (fullText) slideText = fullText;
    }
    if (!slideText) {
      throw new Error(
        "Tidak ada teks yang bisa dipetakan dengan aman ke slide terpilih. " +
        "Jika slide berupa gambar murni atau PowerPoint tidak mengekspos ID slide, " +
        "pilih teks di dalam slide, atau tempel deskripsi slide di Teks/seleksi."
      );
    }

    els.refineProgressText.textContent = "Menyesuaikan format slide (kata tidak diubah)...";
    const result = await fixSlideFormatting({ slideText });

    if (!result?.spec) {
      throw new Error("Tantular belum dapat memperbaiki format slide ini. Pastikan slide berisi teks yang bisa dibaca.");
    }

    state.refineSpec = result.spec;
    renderRefinePreview(state.refineSpec, result.source);
    els.refineDownload.disabled = false;

    els.refineProgressText.textContent = "Mengganti slide terpilih dengan versi format yang diperbaiki...";
    const { base64, truncated } = buildDeckPptxBase64WithDiagnostics(
      state.refineSpec,
      els.deckStyle.value,
      deckStyleHints()
    );
    const truncationNote = truncated.length
      ? ` ⚠ ${truncated.length} bagian teks terlalu panjang untuk kotaknya dan otomatis dipangkas — pertimbangkan mempersingkat teks itu sendiri.`
      : "";
    try {
      const outcome = await replaceSlideInActivePresentation(base64, {
        slideId: selected.slideIds?.[0] || state.refineTargetSlideId || "",
        slideIndex: selected.slideIndexes?.[0] || state.refineTargetSlideIndex || extractRequestedSlideIndex(""),
        formatting: "UseDestinationTheme"
      });
      if (outcome.replaced) {
        setRefineStatus(`Format slide terpilih diperbaiki (posisi sama); kata tidak diubah.${truncationNote}`, truncated.length ? "error" : "ok");
      } else {
        triggerSpecDownload(base64, state.refineSpec);
        const deckState = outcome.inserted
          ? "PowerPoint tidak dapat mengembalikan deck ke kondisi awal; periksa dan hapus slide tambahan jika ada."
          : "Slide asli tidak diubah.";
        setRefineStatus(
          `Penggantian slide dibatalkan. ${deckState} Slide dengan format diperbaiki diunduh sebagai .pptx. ${outcome.reason || "alasan tidak diketahui"}${truncationNote}`,
          "error"
        );
      }
    } catch (error) {
      triggerSpecDownload(base64, state.refineSpec);
      setRefineStatus(`Ganti slide gagal; slide dengan format diperbaiki diunduh sebagai .pptx. ${error?.message || String(error)}${truncationNote}`, "error");
    }
  });
}
```

- [ ] **Step 5: Wire the new button into the existing busy/enable state**

In `src/taskpane.js`, find `function setRefineBusy(isBusy, message = "Menyiapkan improvement...")` (currently around line 2062) and add the new button to its disable logic — change:

```javascript
function setRefineBusy(isBusy, message = "Menyiapkan improvement...") {
  els.refineProgress.classList.toggle("hidden", !isBusy);
  els.refineProgressText.textContent = message;
  els.refineRun.disabled = isBusy || state.host !== "PowerPoint";
  els.refineDownload.disabled = isBusy || !state.refineSpec;
}
```

to:

```javascript
function setRefineBusy(isBusy, message = "Menyiapkan improvement...") {
  els.refineProgress.classList.toggle("hidden", !isBusy);
  els.refineProgressText.textContent = message;
  els.refineRun.disabled = isBusy || state.host !== "PowerPoint";
  els.formatFixRun.disabled = isBusy || state.host !== "PowerPoint";
  els.refineDownload.disabled = isBusy || !state.refineSpec;
}
```

Also find where `els.refineRun.disabled` is set outside of `setRefineBusy` (currently line 1034, inside the function that renders host-specific UI state — search for `els.refineHostNote.textContent`) and add the same line for `els.formatFixRun` immediately after it:

```javascript
  els.refineHostNote.textContent = state.host === "PowerPoint" ? "PowerPoint improve" : "PowerPoint only";
  els.refineRun.disabled = state.host !== "PowerPoint";
  els.formatFixRun.disabled = state.host !== "PowerPoint";
```

- [ ] **Step 6: Run the full test suite to confirm nothing broke**

Run: `npm test 2>&1 | tail -10`
Expected: PASS, same total as after Task 3 (this task adds no new automated tests — `taskpane.js` DOM-wired functions aren't unit-tested in this codebase, matching `refineSelectedSlide`'s own lack of direct test coverage).

- [ ] **Step 7: Manual validation in real PowerPoint**

This step needs an actual PowerPoint desktop session with the Tantular Companion running (`npm start`) and the pane loaded on a real deck. Perform all of these before committing:

1. **Happy path.** Open a deck with a text-heavy slide (a bulleted slide works well). Select that slide, click "🛠 Perbaiki format". Confirm:
   - The preview shows the same wording as the original slide, just restructured.
   - The slide in the deck is replaced in place (same position), not appended.
   - No new/different sentences appear anywhere on the slide.
2. **Truncation warning.** Find or create a slide with one very long line of text (200+ words in a single paragraph/bullet) so it's guaranteed to hit `fitText`'s hard-truncate branch. Run "Perbaiki format" on it. Confirm:
   - The status message names that a section was too long and got shortened (not a silent success message).
   - The status message's tone (error/warning styling) reflects that something needs attention, not full success.
3. **No wording change, ever.** Run "Perbaiki format" 2–3 times in a row on the same slide. Confirm the wording is identical every run (only re-applying the same deterministic formatting), unlike "Improve Existing Deck," which can vary wording run to run.
4. **Multi-select guard.** Select more than one slide in the thumbnail panel, click "🛠 Perbaiki format". Confirm it refuses with the "pilih tepat satu slide" message rather than acting on an arbitrary one.
5. **Image-only slide.** Select a slide with no extractable text (a full-bleed image slide). Confirm it refuses clearly rather than silently doing nothing or grabbing a different slide's content.

Note the results in the PR description or commit message body for this task.

- [ ] **Step 8: Commit**

```bash
cd "tantular_office_addin" && git add src/taskpane.html src/taskpane.js
git commit -m "$(cat <<'EOF'
feat(deck): add "Perbaiki format" button to PowerPoint Deck Refine

New button next to "Improve selected slide", sharing that section's slide
targeting, preview, and status UI. fixSelectedSlideFormatting() mirrors
refineSelectedSlide()'s read/preview/replace-in-place/download-fallback
flow, but calls fixSlideFormatting() (wording untouched) instead of
improveExistingSlide(), and renders via buildDeckPptxBase64WithDiagnostics
so a truncated element surfaces a clear warning instead of being silently
cut.

Manually validated in PowerPoint desktop: happy path (wording unchanged,
in-place replace), truncation warning surfaced correctly, repeat runs
produce identical wording, multi-select and image-only-slide guards refuse
correctly. Details in task notes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: PowerPoint chat router guard

**Files:**
- Modify: `src/chat/pptChat.js`
- Test: `tests/pptChat.test.mjs` (new file — no existing test covers `PPT_CHAT_SYSTEM`'s content)
- Manual validation: PowerPoint desktop, chat panel

**Interfaces:**
- Consumes: nothing new
- Produces: `PPT_CHAT_SYSTEM` becomes exported (was module-private) so its content is testable; no new runtime behavior beyond the prompt text itself — `mountPptChatPane`'s existing `actions: []` handling already covers "no action taken, reply explains why" (see the existing rule "Jika permintaan tidak bisa dipenuhi dengan aksi yang tersedia, actions kosong dan jelaskan alasannya di 'reply'").

- [ ] **Step 1: Write the failing test**

Create `tests/pptChat.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { PPT_CHAT_SYSTEM } from "../src/chat/pptChat.js";

// REGRESSION: the router's action set (improve_slide/replace_slide/
// add_slide/delete_slide) has no "format only" op, and its own instructions
// say "to fix an existing slide, use improve_slide" — so a chat request like
// "perbaiki format slide 4" would be classified straight into the
// wording-rewriting path with nothing to stop it, silently rewriting text a
// user only wanted reformatted. This is a prompt-content test, not a
// behavioral one (verifying actual model routing needs a real model call,
// covered by manual validation) — its job is to catch someone deleting the
// guard instruction later, not to prove the model obeys it.
test("PPT_CHAT_SYSTEM instructs the router to refuse formatting-only requests, not route them to improve_slide", () => {
  assert.match(PPT_CHAT_SYSTEM, /format/i);
  assert.match(PPT_CHAT_SYSTEM, /Perbaiki format/);
  // The guard must appear as an instruction distinct from the general
  // "actions kosong" fallback rule already in the prompt, naming the button.
  const guardIndex = PPT_CHAT_SYSTEM.search(/Perbaiki format/);
  assert.ok(guardIndex !== -1, "must reference the button by name so the model's reply can point users at it");
});

test("PPT_CHAT_SYSTEM's existing action set is unchanged (guard is a refusal, not a new op)", () => {
  assert.match(PPT_CHAT_SYSTEM, /"op":"improve_slide"/);
  assert.match(PPT_CHAT_SYSTEM, /"op":"replace_slide"/);
  assert.match(PPT_CHAT_SYSTEM, /"op":"add_slide"/);
  assert.match(PPT_CHAT_SYSTEM, /"op":"delete_slide"/);
  assert.doesNotMatch(PPT_CHAT_SYSTEM, /"op":"format_slide"/, "v1 is a router guard, not a new chat op — see design spec point 6");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pptChat.test.mjs 2>&1`
Expected: FAIL — `PPT_CHAT_SYSTEM` is not exported from `src/chat/pptChat.js`.

- [ ] **Step 3: Export `PPT_CHAT_SYSTEM` and add the guard instruction**

In `src/chat/pptChat.js`, change the constant declaration (currently `const PPT_CHAT_SYSTEM = ...` at line 21) to `export const PPT_CHAT_SYSTEM = ...` — just add `export`.

Then, in the same template literal, find the existing rules block (search for `Aturan WAJIB:` — the rules list currently ending with `- Balas HANYA JSON. Tanpa markdown, tanpa teks lain.`) and add one new rule. Insert it right after the existing line `- Untuk memperbaiki slide yang sudah ada, PAKAI improve_slide. Jangan menulis ulang isinya sendiri lewat replace_slide.`:

```
- Jika permintaan pengguna HANYA soal format/tampilan — ukuran font, gaya font, proporsi, "terlalu kecil/besar", "tidak konsisten ukurannya", "rapikan tampilan" — dan TIDAK meminta perubahan kata sama sekali, JANGAN pakai improve_slide atau aksi apa pun. Kosongkan "actions" dan jelaskan di "reply" bahwa pengguna perlu memakai tombol "Perbaiki format" di panel Deck Refine, karena fitur itu menjaga kata tetap sama sementara improve_slide bisa mengubah kata.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pptChat.test.mjs 2>&1`
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test 2>&1 | tail -10`
Expected: PASS, total test count increased by 2 (the two new `pptChat.test.mjs` tests) from wherever Task 4 left it.

- [ ] **Step 6: Manual validation in real PowerPoint**

Needs the Tantular Companion running and the PowerPoint chat panel open on a real deck with at least one text slide.

1. In the chat box, type a formatting-only request naming a real slide number, e.g. `perbaiki format slide 2` (adjust the number to a real slide in the open deck). Confirm:
   - No slide is changed in the deck.
   - The reply explicitly mentions the "Perbaiki format" button (not a generic refusal).
   - No `improve_slide` confirmation/plan UI appears.
2. Try a second phrasing to check the guard isn't overfit to one exact sentence, e.g. `font di slide 2 kekecilan, tolong rapikan`. Confirm the same outcome as step 1.
3. As a contrast check, type a genuine wording request, e.g. `perbaiki slide 2 supaya lebih ringkas`. Confirm this STILL routes to `improve_slide` as before (the guard must not over-trigger and block legitimate wording-improvement requests).

Note the results in the commit message body for this task.

- [ ] **Step 7: Commit**

```bash
cd "tantular_office_addin" && git add src/chat/pptChat.js tests/pptChat.test.mjs
git commit -m "$(cat <<'EOF'
feat(chat): guard PowerPoint chat against misrouting format-only requests

The router's action set (improve_slide/replace_slide/add_slide/delete_slide)
has no formatting-only op, and its own instructions said "use improve_slide
to fix an existing slide" — so "perbaiki format slide 4" in chat would have
silently rewritten wording via improve_slide, exactly what the new
formatting-only button (previous task) exists to avoid.

v1 is a router guard, not a new chat op: the prompt now recognizes
formatting-only phrasing and responds with no action, pointing the user at
the "Perbaiki format" button instead. A dedicated format_slide chat op
remains a natural follow-up once the button path has proven itself — see
design spec point 6 for the reasoning.

PPT_CHAT_SYSTEM is now exported so its content is testable; the two new
tests are prompt-content regression guards (catching someone deleting the
guard instruction later), not proof the model obeys it — that's covered by
manual validation, noted here: [fill in actual manual test results before
committing].

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation checklist

- [ ] Full suite green: `npm test 2>&1 | tail -10`
- [ ] All 5 manual PowerPoint validation checklists (Task 4 Step 7, Task 5 Step 6) completed and results recorded
- [ ] Spec's "What does NOT change" list re-verified by inspection: `deckStyles.js` untouched; `normalizeSlide`/`normalizeSpec` untouched; `improveExistingSlide` untouched; `replaceSlideInActivePresentation` untouched; `buildDeckPptxBase64`'s existing behavior unchanged (Task 3's byte-identical-output test covers this automatically)

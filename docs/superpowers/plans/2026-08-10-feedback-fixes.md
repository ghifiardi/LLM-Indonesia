# Workshop Feedback Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three participant-feedback fixes — richer deck style packs, a 100 MB upload cap, and Apple Vision OCR — with per-task review, then a rollback-safe portal deploy.

**Architecture:** All three ride existing seams: style packs extend `deckStyles.js` tokens consumed by `pptxBuilder.js`'s OOXML emitters; the upload cap is two constants on an already-streaming path; OCR is a new doc-server endpoint (`pyobjc` Vision) with a capability probe and the current vision-model path as untouched fallback.

**Tech Stack:** Node ≥18 ESM + `node --test` (add-in), Python 3 doc-server (`.venv-doc`, `pyobjc-framework-Vision`), OOXML by string emission (existing pattern).

**Spec:** `docs/superpowers/specs/2026-08-10-feedback-fixes-design.md` — read fully before any task.

## Global Constraints

- Branch `feat/office-finetune`; commit per task; index.lock → wait 30s retry; commit ONLY your task's files.
- Add-in suite (`npm test` in `tantular_office_addin/`, currently 130 passing) stays green and grows.
- **User-mandated checks (this plan's acceptance spine):** stable placeholders + overflow tests for every pack×slide-type; an end-to-end 100 MB boundary test against the REAL doc-server; mocked Apple Vision capability/failure tests; explicit Windows-fallback coverage; rollback-safe deployment ordering (deploy last, after all reviews; record the prior production deployment for instant rollback).
- XSS rule unchanged: any new pane-rendered strings via textContent only.
- Indonesian for all user-facing strings.

## File Structure

```
tantular_office_addin/
  src/deck/deckStyles.js       MODIFY: 5-6 full design-system packs (tokens)
  src/deck/pptxBuilder.js      MODIFY: per-slide-type pack application + overflow policy
  tests/deckStyles.test.mjs    CREATE: pack completeness, XML validity, overflow
  src/deck/documentExtract.js  MODIFY: 100 MB constant + message
  tools/document-extractor.py  MODIFY: MAX_BYTES 100 MB + /api/ocr + probe
  src/deck/visionExtract.js    MODIFY: OCR-first with probe + fallback
  tests/visionExtract.test.mjs CREATE: probe/failure/fallback decision tests
  tests/documentExtract.test.mjs CREATE (or extend existing): boundary guard tests
  package.json                 MODIFY: doc-setup adds pyobjc-framework-Vision
```

---

### Task 1: Deck style packs + overflow policy

**Files:**
- Modify: `tantular_office_addin/src/deck/deckStyles.js`, `src/deck/pptxBuilder.js`
- Create: `tantular_office_addin/tests/deckStyles.test.mjs`

**Interfaces:**
- Produces: `styleOptions()` returns 5–6 packs, each `{id, name, background:{kind:"solid"|"gradient"|"panel", ...colors}, motif:"corners"|"rules"|"dots"|"band", palette:{bg,ink,muted,accent,accent2}, type_scale:{display,h1,body,caption, boldHeadings}, chrome:{footer:boolean, slideNumber:boolean}}`. `pptxBuilder` consumes ONLY these tokens (no pack-conditional hardcoding outside a small motif-drawing map). New export from pptxBuilder (or a helper module): `fitText(text, {maxChars, minSize, baseSize}) → {text, size}` — the overflow policy.

**Overflow policy (user-mandated, exact):** every text placeholder has a stable geometry per slide type (same box positions across packs — packs change look, never layout math). `fitText` shrinks font stepwise (base → min, e.g. 28→18 for headlines) while estimated length exceeds the box budget, then hard-truncates with "…" at `maxChars` for the min size. Applied to: headline, subhead, bullets (per line), card titles/descriptions, metric labels, quote text.

- [ ] **Step 1: Write failing tests** (`tests/deckStyles.test.mjs`):

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { styleOptions } from "../src/deck/deckStyles.js";
import { buildDeckPptxBase64 } from "../src/deck/pptxBuilder.js";
import { fitText } from "../src/deck/pptxBuilder.js"; // or textFit.js if extracted

const REQUIRED = ["id","name","background","motif","palette","type_scale","chrome"];
const SPEC = { title: "Deck Uji", subtitle: "Sub", slides: [
  { type:"title", headline:"Judul", subhead:"Sub" },
  { type:"agenda", headline:"Agenda", bullets:["Satu","Dua"] },
  { type:"bullets", headline:"Isi", bullets:["A","B","C"] },
  { type:"cards", headline:"Kartu", cards:[{title:"T1",desc:"D1"},{title:"T2",desc:"D2"}] },
  { type:"metrics", headline:"Angka", metrics:[{value:"10%",label:"Naik"}] },
  { type:"quote", headline:"", bullets:[], quote:"Kutipan penting." },
  { type:"closing", headline:"Penutup", bullets:["Next"] }
]};

test("every pack carries the complete token set", () => {
  const packs = styleOptions();
  assert.ok(packs.length >= 5 && packs.length <= 6);
  for (const p of packs) for (const k of REQUIRED) assert.ok(k in p, `${p.id} missing ${k}`);
});

test("every slide type renders under every pack without throwing, XML references pack accent", () => {
  for (const p of styleOptions()) {
    const b64 = buildDeckPptxBase64(SPEC, p.id);   // adapt to the real signature — read pptxBuilder first
    assert.ok(b64.length > 1000);
    const raw = Buffer.from(b64, "base64").toString("latin1");
    assert.ok(raw.includes(p.palette.accent.replace("#","").toUpperCase()) ||
              raw.includes(p.palette.accent.replace("#","")), `${p.id} accent not in output`);
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
  const abuse = { ...SPEC, slides: [{ type:"bullets", headline:"H".repeat(400),
    bullets: Array.from({length:20}, (_,i)=>`Butir panjang sekali nomor ${i} `.repeat(6)) }] };
  for (const p of styleOptions()) {
    const b64 = buildDeckPptxBase64(abuse, p.id);
    assert.ok(b64.length > 1000);
  }
});
```

- [ ] **Step 2: Run to verify failures** (`npm test`) — adapt import names to reality FIRST by reading both source files; the tests must fail for the right reason (packs incomplete / fitText absent), not import typos.
- [ ] **Step 3: Implement.** deckStyles: author 5–6 packs (suggested identities: "Nusantara" warm brand default, "Monokrom" ink+single accent, "Samudra" deep blue gradient, "Terang" light minimal + dots, "Tegas" dark panel + band, optionally "Akademik" rules grid). pptxBuilder: background/motif emitters keyed by tokens; type_scale applied per slide type; ALL text through fitText; keep existing slide geometry (stable placeholders). Extract fitText pure.
- [ ] **Step 4: Run tests** — all green (130 + new). `node --check` both modified files.
- [ ] **Step 5: Manual visual pass (implementer):** generate one deck per pack via the existing preview/dev-server path or a small scratch script writing .pptx files to /tmp; note in the report that PowerPoint-opening screenshots are for the controller/user acceptance step (record file paths).
- [ ] **Step 6: Commit** — "feat(deck): 5-6 full design-system style packs with overflow-safe text fitting".

---

### Task 2: 100 MB upload cap with real-server boundary test

**Files:**
- Modify: `tantular_office_addin/src/deck/documentExtract.js`, `tools/document-extractor.py`
- Create/extend: `tantular_office_addin/tests/documentExtract.test.mjs`

- [ ] **Step 1: Failing JS boundary tests:** mock `{size, name}` file objects: 100 MB exactly → passes the guard; 100 MB + 1 byte → throws with message containing "100 MB". (Read documentExtract.js first: the guard may need extracting into a pure `assertUploadSize(file)` for clean testing.)
- [ ] **Step 2: Implement:** both constants → `100 * 1024 * 1024`; messages "File terlalu besar (maks 100 MB)."; Python MAX_BYTES same + code comment noting single in-memory read is acceptable locally.
- [ ] **Step 3: END-TO-END boundary run (user-mandated, real server):** `./.venv-doc/bin/python tools/document-extractor.py` (background; if `.venv-doc` missing run `npm run doc-setup` first); generate `/tmp/big99.txt` (99 MB) and `/tmp/big101.txt` (101 MB) via `mkfile`/`dd`; curl-POST each to the extractor endpoint exactly as documentExtract.js does (same field name — read the JS): expect 200-with-text for 99 MB, clean 4xx Indonesian error for 101 MB, server stays alive after both. Paste transcripts into the report; kill server; delete temp files.
- [ ] **Step 4: `npm test` green; commit** — "feat(extract): raise upload cap to 100MB with boundary tests".

---

### Task 3: Apple Vision OCR with probe + fallback

**Files:**
- Modify: `tools/document-extractor.py`, `tantular_office_addin/src/deck/visionExtract.js`, `tantular_office_addin/package.json` (doc-setup line adds `pyobjc-framework-Vision pyobjc-framework-Quartz`)
- Create: `tantular_office_addin/tests/visionExtract.test.mjs`

**Interfaces:**
- Doc-server: `GET /api/ocr` → 200 `{ok:true, engine:"apple-vision"}` when Vision importable, else 501 `{ok:false,error}`. `POST /api/ocr` (multipart image) → `{ok:true, text, lines:[{text, confidence}]}` | 501/4xx. Vision call isolated in `run_apple_vision_ocr(image_bytes) -> dict` behind a guarded import (`try: import Vision ... except ImportError: VISION_AVAILABLE=False`).
- Pane: export pure `chooseOcrEngine({probeStatus}) → "apple-vision"|"model"` and `extractWithFallback({probe, ocrCall, modelCall}) → result` (injectable async fns) so the decision/failure logic is unit-testable without DOM/network; `visionExtract.js` main flow uses them; status line reports the engine used.

- [ ] **Step 1: Failing JS tests (user-mandated mocked coverage):**

```javascript
test("probe 200 apple-vision -> apple engine; 501 or network error -> model", ...);
test("apple OCR mid-flight failure falls back to model and still returns text", ...);
test("Windows/no-doc-server path: probe rejects -> model engine used (fallback coverage)", ...);
test("engine name surfaces in the result meta for the status line", ...);
```

(Write real assertions with injectable stubs per the Interfaces block.)

- [ ] **Step 2: Implement Python:** guarded import; `run_apple_vision_ocr` builds `VNImageRequestHandler` from bytes (via Quartz `CGImageSource`), `VNRecognizeTextRequest` with `recognitionLevel = accurate`, `recognitionLanguages = ["id-ID","en-US"]`, `usesLanguageCorrection = True`; collect `topCandidates(1)` text+confidence. Routes for GET probe + POST. Non-mac → 501 both.
- [ ] **Step 3: Implement pane:** probe once per session (memoized); OCR-first, model fallback; engine in status ("Ekstraksi teks: Apple Vision" / "…: model vision"); all rendering textContent.
- [ ] **Step 4: macOS smoke (real, controller-visible):** create a PNG with known text (`python -c` PIL if available in .venv-doc, else `sips`/textutil route, else document skip), POST to /api/ocr, assert the text substring appears; paste transcript in report.
- [ ] **Step 5: `npm test` green (all suites); commit** — "feat(ocr): Apple Vision endpoint with capability probe and vision-model fallback".

---

### Task 4 (controller): rollback-safe deploy + resume queue

- [ ] Record current production deployment id/URL (`vercel ls` latest) in the ledger BEFORE deploying (rollback = redeploy that build or `vercel rollback`).
- [ ] Bump build tag (b0810a); `npm test` final; rebuild workshop web + package; `vercel deploy --prod`; verify live: new tag served, `/api/ocr` note added to support page ("jalankan `npm run doc-setup` ulang untuk OCR Apple Vision"), packs listed in the Gaya desain dropdown (served JS contains pack names).
- [ ] User acceptance: open PowerPoint, generate one deck per pack (visual distinctness), try a >35 MB file, try Extract-from-image on a text screenshot (expect "Apple Vision" status).
- [ ] Resume fine-tune queue (Fix C, D) per standing order; fine-tune paid stages remain HELD.

## Final gate

All three task reviews approved; user-mandated checks each evidenced in reports (overflow tests, 100 MB transcripts, mocked OCR matrix, Windows fallback test, rollback note in ledger); deploy verified; ledger updated.

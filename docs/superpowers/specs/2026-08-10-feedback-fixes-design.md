# Workshop Feedback Fixes — Deck Style Packs, 100 MB Uploads, Apple Vision OCR

**Date:** 2026-08-10
**Status:** Approved direction (user chose richer style packs over template bank), pending implementation plan
**Scope:** Three contained improvements answering direct participant feedback ("pilihan desain PPT terbatas; maksimal file 35 MB; belum optimal baca tulisan di gambar"). Prioritized by the user ahead of the paused fine-tune fix queue. No Office API floor changes; everything works across M365 / Office 2021 / 2024 per the existing compatibility posture.

## 1. Richer deck style packs (feedback: limited PPT designs)

**Decision (user, 2026-08-10):** upgrade the programmatic builder — no external .pptx template bank in this round (logged as a possible follow-up with a higher visual ceiling).

Current state: `src/deck/deckStyles.js` defines style options consumed by `src/deck/pptxBuilder.js`, which draws flat accent rectangles/bars. The upgrade:

- **5–6 named design systems** (replacing/extending current options), each a complete token set: `background` (solid | vertical gradient wash | side-panel block), `motif` (one of: corner geometric marks, thin rule grid, dot cluster, diagonal band), `palette` (bg/ink/muted + accent + accent2, coherent per pack), `type_scale` (display/h1/body/caption sizes + weight flags per slide type), `chrome` (footer bar style, slide-number treatment).
- **Per-slide-type application** in pptxBuilder for ALL existing types (title, agenda, bullets, cards, columns, metrics, quote, visualization, closing): e.g. quote slides get oversized quotation motif + display type; metrics get accent-tinted stat tiles; title gets the pack's fullest background treatment.
- Packs are pure data + pure XML-emitting functions — unit tests assert (a) every pack has the full token set, (b) generated slide XML is well-formed and references pack tokens (spot-check color hex presence per pack), (c) each slide type renders under every pack without throwing, (d) output .pptx zip still passes the existing builder tests.
- The existing "Gaya desain" dropdown lists the packs; "Bebas / custom" keeps honoring project-instruction color overrides as today.
- Acceptance: manual visual pass — one generated deck per pack opened in PowerPoint, screenshot per pack recorded in the report; the packs must be visually distinct at a glance.

## 2. Upload cap 35 MB → 100 MB (feedback: file too small)

Facts established: the cap is self-imposed in exactly two places — `src/deck/documentExtract.js` (`file.size > 35*1024*1024`) and `tools/document-extractor.py` (`MAX_BYTES`). The upload path already streams (`FormData` + `fetch(File)`) — no base64 inflation in the webview, so no streaming rework is needed.

- Both constants → **100 MB**; Indonesian error strings updated ("maks 100 MB").
- Doc-server: verify it reads the upload bounded by MAX_BYTES and errors cleanly at the new limit (single in-memory read of ≤100 MB is acceptable for a local server; note in code).
- Tests: JS guard unit test at boundary (100 MB passes, >100 MB throws with the new message). Python side: constant + a comment; behavior verified in the manual pass with a large real file if available, else a generated dummy.

## 3. Apple Vision OCR in the Companion (feedback: reading text in images)

Current state: Extract-from-image uses a local vision model via Ollama (`llama3.2-vision` default) through `src/deck/visionExtract.js`; quality on Indonesian in-image text is mediocre. Apple's Vision framework is fast, free, strong at Indonesian OCR, and independent of Office version.

- **Doc-server** (`tools/document-extractor.py`, existing `.venv-doc`) gains `/api/ocr`: accepts an image upload (same multipart pattern as document-extract), runs `VNRecognizeTextRequest` via `pyobjc` (recognition level accurate; languages `["id-ID", "en-US"]`; returns `{ok, text, lines:[{text, confidence}]}`). `pyobjc-framework-Vision` added to the doc-setup pip install. Non-macOS or missing pyobjc → endpoint returns 501 `{ok:false, error}` so clients can detect absence.
- **Capability probe:** `GET /api/ocr` (no body) → 200 `{ok:true, engine:"apple-vision"}` when available, 501 otherwise.
- **Pane** (`visionExtract.js`): on extract, probe once per session; if available, send the image to `/api/ocr` FIRST and use its text as the extracted content (optionally still passing through the structuring step the current flow applies to vision-model output — reuse whatever post-processing exists); on probe-absent or OCR failure, fall back to the current vision-model path unchanged. Status line names the engine used ("OCR: Apple Vision" / "OCR: model vision").
- Windows/participants without the doc-server: behavior unchanged (vision model).
- Tests: JS — probe/fallback decision logic extracted pure and unit-tested; Python — the Vision call isolated behind a function with an import guard; a macOS-only smoke script documented (feed a generated PNG with known text, assert substring) run manually in the acceptance pass.

## Rollout

One branch (current `feat/office-finetune`), one task each in the implementation plan, per-task review as established. After all three: rebuild portal + workshop package, bump build tag, deploy, and refresh the doc-server requirements note in README/support ("jalankan ulang npm run doc-setup untuk OCR Apple Vision"). The paused fine-tune queue (Fix C, D) resumes after deploy.

## Out of scope

Template .pptx bank (follow-up candidate); OCR on Windows beyond the existing vision model; chart/image generation inside decks; any Office API floor change.

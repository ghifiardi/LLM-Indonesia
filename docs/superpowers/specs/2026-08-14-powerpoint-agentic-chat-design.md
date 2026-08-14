# Agentic PowerPoint Chat — Design

Date: 2026-08-14
Status: Approved, ready for implementation planning

## Problem

Word and Excel both have a chat pane in the Tantular add-in. PowerPoint has none.
`src/chat/chatPane.js` routes `Excel` to the agentic `excelChat.js`, then bails out
with `if (host !== "Word") return;` — so on PowerPoint the chat card never mounts.

PowerPoint users get two form-driven buttons instead:

- **Deck Studio** (`taskpane.js:866`) — one-shot deck generator from a brief, document, or image.
- **Improve Existing Deck** (`taskpane.js:1124`) — refines exactly one selected slide.

There is no conversation, no whole-deck context, and no multi-step edit. "Make slide 4
shorter and add a closing slide" is not expressible today.

## Goal

A PowerPoint chat pane with whole-deck context that can answer questions about the deck
and mutate it: improve, replace, add, and (confirm-gated) delete slides.

## Host constraints

These are established facts about the target host (Mac PowerPoint), not assumptions:

- `getSelectedSlides()` (PowerPointApi 1.5) is **not supported**.
- `setSelectedSlides()` (1.5) is **not supported**.
- `insertSlidesFromBase64` and `presentation.slides` (1.2) **work**.
- `Slide.delete()` works, but Mac PowerPoint **silently ignores it when the target slide
  is the active selection**. The usual workaround (move selection first) needs 1.5.
- `Shape.textFrame` is documented at PowerPointApi 1.4 and is **unverified** on this host.
  The existing code path that uses it (`getSelectedSlideTextContext`) never reaches the
  read, because it aborts earlier at `getSelectedSlides()`.
- Whole-deck text reading is proven only via `getActivePresentationPptxFile()` +
  `extractDocumentFile()` (the local Python companion at `companionUrl("/api/document-extract")`),
  which labels slides with numeric `sldId` values that match the live API ids on their
  pre-`#` component.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Whole-deck edits + Q&A |
| Edit fidelity | Rebuild slides from Deck Studio styles via `pptxBuilder` |
| Deck read | In-host API first, companion extractor as fallback — **gated on a probe** |
| Snapshot cache | Refresh after any successful write, plus a manual reload button |
| Delete | Model may plan it; execution requires a user confirm click |
| Style source | Reuse the existing Deck Studio tone and Project/output instructions fields |
| Engine | Hybrid: one planning call per turn, plus a per-slide generation call only for content-free `improve_slide` actions |

Rebuild-from-styles means a replaced slide loses its original images and custom layout.
This matches what Improve Existing Deck already does today, so it introduces no new
class of data loss.

## Architecture

### New files

**`src/chat/pptTools.js`** — all deck access and all pure logic.

- `getDeckContext({ force })` → `{ slides: [{ index, id, title, text, truncated }], source, meta }`.
  `source` is `"host"` or `"extractor"`. Module-level cache; returns cached data only when
  `force !== true`.
- `deckContextToPromptText(ctx)` — pure.
- `sanitizePptActions(raw, slideCount)` → `{ actions, rejected }` — pure. The **only** place
  that knows the action JSON schema.
- `orderPptActions(actions)` — pure. Deterministic execution order.
- `resolveDeleteTarget(liveIds, descriptor)` — pure. Id-first targeting with stale detection.
- `executePptActions(actions, ctx, hooks)` — applies actions, returns
  `{ lines, pendingDeletes }`. `hooks` is `{ onProgress(text), signal, tone, instruction }`:
  the progress callback the pane uses to update its bubble, the turn's `AbortSignal`, and the
  Deck Studio tone / project-instruction strings the pane reads from the existing fields.
- `executeConfirmedDelete(descriptor)` — runs a user-confirmed delete.
- `extractPptxSlides(text)`, `extractRequestedSlideIndex(text)` — moved here from `taskpane.js`.

**`src/chat/pptChat.js`** — the pane. Mounts `#chat-card`, runs one `runTantular` JSON call
per turn, renders bubbles, owns the delete-confirm UI and the reload button. Imports only
`pptTools.js`, `tantularClient.js`, and `history.js`. **No `Office` or `PowerPoint` reference
anywhere in this file.**

### Changed files

- **`src/chat/chatPane.js`** — add a `host === "PowerPoint"` branch above the `host !== "Word"`
  bail-out, dynamic-importing `pptChat.js`. Host router only; no other responsibility.
- **`src/taskpane.js`** — remove `extractPptxSlides` and `extractRequestedSlideIndex`
  (lines 1266–1290), import them from `pptTools.js`. Both are pure, both are now needed by two
  consumers, and `taskpane.js` is already 1543 lines.
- **`src/officeClient.js`** — extract `deleteSlidesInActivePresentation(ids)` out of the delete
  logic currently inline in `replaceSlideInActivePresentation` (lines 545–558), including its
  verify-after-delete check. `replaceSlideInActivePresentation` calls the extracted helper;
  the inline copy is removed, not duplicated.
- **`src/deck/deckPlanner.js`** — `improveExistingSlide` gains an optional `signal`, passed
  through to `runTantular`, so chat aborts propagate. Boundary change, not a chat special-case.

### Unchanged

`pptxBuilder`, `deckCompiler`, the rest of `deckPlanner`, `hostUi.js`. Deck Studio and
Improve Existing Deck remain visible and functional; the chat is additive.

### Import direction

`pptChat.js` → `pptTools.js` → { `officeClient.js`, `deck/*` }, and `taskpane.js` → `pptTools.js`.
`pptTools.js` must never import from `taskpane.js`. No cycles.

## Action contract

One model call per turn returns:

```json
{ "reply": "…", "actions": [] }
```

Four ops:

```js
{"op":"improve_slide",  "slideIndex":4}
{"op":"replace_slide",  "slideIndex":3, "slide":{…}}
{"op":"add_slide",      "afterIndex":5, "slide":{…}}
{"op":"delete_slide",   "slideIndex":7}
```

`slide` is one Deck Studio slide object: `{ type, headline, subhead?, bullets?, cards?,
columns?, chartType? }`, `type` drawn from `SLIDE_TYPES` in `deckPlanner.js`.

`improve_slide` is content-free by design. The executor pulls that slide's text from the
snapshot and calls `improveExistingSlide({ slideText, tone, instruction, signal })` — the tuned
source-grounded prompt Improve Existing Deck already uses. This keeps the chat from being
worse at improving a slide than the button it supplements. `replace_slide` carries content
and skips the second model call.

### Sanitizer rules

- `op` must be one of the four.
- `slideIndex` must be an integer in `1..slideCount`. Strings and non-integers are rejected.
- `afterIndex` must be an integer in `0..slideCount`; `0` means insert at the front.
- `replace_slide` and `add_slide` must carry a `slide` with a valid `type` and a non-empty
  `headline`. Unknown slide fields are stripped so `pptxBuilder` only sees shapes it handles.
- Maximum 8 actions per turn. Extras become rejections.
- Everything rejected is returned in `rejected[]` with a reason and rendered to the user as
  `⚠️ …`. Nothing is silently dropped.

`pptChat.js` does not partially trust model output. Anything not returned in `actions` by the
sanitizer does not exist as far as the executor is concerned.

## Execution

`executePptActions(actions, ctx, hooks)` treats `ctx` as **immutable for the whole turn**:

1. Resolve every target to a slide **id** from the original snapshot, before executing anything.
   Index is only a fallback when ids are unavailable.
2. Order via `orderPptActions`:
   - Replaces and deletes descending by `slideIndex`, so earlier mutations don't shift later targets.
   - Inserts descending by `afterIndex`.
   - **Same-anchor inserts run in reverse model order.** `insertSlidesFromBase64` places a slide
     immediately after its anchor, so inserting A then B after slide 5 yields `5, B, A`. Reversing
     the execution order makes the final deck order match the model's intent.
3. Execute sequentially. Each action reports `✅` or `❌ <reason>` on its own line; a failure does
   not stop the remaining actions. Partial success is reported as partial.
4. Clear the snapshot cache **once**, after the first successful write. The turn's report is
   explicitly based on the pre-write snapshot; the next turn or a manual reload re-reads.
5. Returning a pending delete descriptor is **not** a write and does not clear the cache.

Slide replacement uses `replaceSlideInActivePresentation(base64, { slideId, slideIndex,
formatting: "UseDestinationTheme" })`, unchanged from deck refine.

### Delete handoff

```
sanitizePptActions      → returns delete_slide in actions
executePptActions       → does not mutate; returns { op, slideIndex, id, title }
pptChat.js              → renders a confirm button
executeConfirmedDelete  → resolves target, deletes, verifies
```

`executeConfirmedDelete` prefers `id` over `slideIndex`. If the id is absent from the live deck,
it returns a stale-deck warning rather than deleting whatever now occupies that position.

After deletion it re-reads slide ids and verifies the target is gone. If it is still present, it
reports:

> Slide 7 tidak terhapus — kemungkinan sedang terpilih di panel thumbnail. Pilih slide lain lalu coba lagi.

Never a false success. This is executor behavior, not UI behavior.

## Data flow

1. `pptChat.send()` → `getDeckContext()` (cache hit unless invalidated or forced).
2. One `runTantular({ task: "deck", jsonMode: true, temperature: 0.15, signal })` call with the
   snapshot text, short history, tone, project instructions, and the user message.
3. Parse with `extractJsonObject` from `deckPlanner.js` — already exported and tested; no new parser.
4. `sanitizePptActions(parsed.actions, ctx.slides.length)`.
5. `executePptActions(actions, ctx, hooks)`.
6. Render reply + report lines + `⚠️` rejections + any pending delete confirmations in one bubble.

### Snapshot format

Per slide: index, id, title, and up to ~400 characters of body text, with a total ceiling so a
60-slide deck does not exhaust the context of a local 9B model. Truncated slides are marked
`[dipotong]` inline, and the snapshot carries one global notice:

> Konten slide dipotong untuk konteks; jangan anggap bagian yang tidak terlihat kosong.

The snapshot header states the total slide count. The model is told once globally and again
locally where it matters.

## Error handling

| Failure | Behavior |
|---|---|
| Not PowerPoint | Pane never mounts; `chatPane.js` routes by host. |
| In-host read throws or returns empty | Fall back to companion extractor. |
| Both read paths fail | `Tantular tidak bisa membaca deck aktif. Pastikan Tantular Companion berjalan.` |
| Malformed model JSON | Error bubble, zero actions. No reply rendered from malformed output unless the parsed object is valid enough to prove it is a reply-only response. |
| Single action fails | `❌ <reason>` for that action; remaining actions still run. |
| No safe anchor | The existing `replaceSlideInActivePresentation` error surfaces verbatim — it already tells the user what to do. |
| User aborts | `AbortController` on the plan call and on every downstream `improve_slide` call. |

The context pill shows `source` (`host` or `extractor`), so a support screenshot reveals which read
path ran. Write confirmations carry the build tag, matching deck refine, so a screenshot alone
identifies the code version.

## Testing

New `tests/pptTools.test.mjs`, modelled on `tests/excelTools.test.mjs`. All pure, no Office mocking.

- **`sanitizePptActions`** — each valid op survives; unknown op rejected with a reason;
  `slideIndex` of `0`, `slideCount + 1`, `"3"`, and `3.5` rejected; `afterIndex: 0` accepted;
  slide with unknown `type` rejected; slide missing `headline` rejected; unknown slide fields
  stripped; 9 actions → 8 kept plus 1 rejection.
- **`orderPptActions`** — replaces and deletes descending; inserts descending by anchor;
  **three same-anchor inserts land in model order in the final deck** (guards against pairwise-only
  logic); two same-anchor inserts likewise; a mixed list produces one deterministic sequence.
- **`deckContextToPromptText`** — slide count line present; global truncation notice present;
  `[dipotong]` only on slides actually cut; total ceiling respected.
- **`resolveDeleteTarget`** — id match wins over index; id absent from the live deck yields a
  stale-deck result and never a positional delete; index-only descriptor still resolves when ids
  are unavailable.
- **`extractPptxSlides` / `extractRequestedSlideIndex`** — first tests for these, added as part of
  moving them out of `taskpane.js`.

`tests/replaceSlideTarget.test.mjs` continues to cover `resolveReplaceTarget`, now shared by the
executor.

### Implementation step one: the host-read probe

Before building the chat, run a temporary in-host read of the active deck
(`presentation.slides` + `shape.textFrame.textRange.text`) in real PowerPoint on the Mac host and
report slide count and characters read.

- **Works** → the fast path is real; the extractor is a genuine fallback.
- **Throws** → the fast path is dead code on the host that matters. Delete that branch and ship
  extractor-only behind the same `getDeckContext()` interface.

Building the chat before knowing which is guessing.

### Manual verification in PowerPoint

Improve a slide; replace a slide; add a slide; confirm a delete; decline a delete; delete a slide
that is currently selected in the thumbnail panel (expect the honest failure, not a false success);
run a turn with the companion stopped (expect the actionable error).

## Out of scope

- Editing shape text in place while preserving images and custom layout. That needs
  `Shape.textFrame` writes, unverified on this host, and conflicts with the rebuild-from-styles
  decision.
- Multi-turn tool loops. One planning call per turn, matching the Excel chat.
- Changes to Deck Studio or Improve Existing Deck behavior.

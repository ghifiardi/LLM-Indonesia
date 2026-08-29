# PowerPoint "Perbaiki format" — design

Status: approved by user, ready for implementation planning.
Scope: PowerPoint only (Word/Excel explicitly out of scope — see Decisions).

## Problem

"Improve Existing Deck" fixes a slide's *wording*. There is no way to fix a
slide's *formatting* — font size, style, and layout proportion — without also
rewording it. Reported pain points, in the user's own words: text overflows
or is cramped, sizing is inconsistent across similar elements on a slide, and
font/style sometimes doesn't match the deck's intended look.

## Decisions made during brainstorming

- **Hosts:** PowerPoint only. Word and Excel formatting are different
  problems (text-run-based vs. cell-based) and were explicitly deferred.
- **Trigger:** a new, separate action — not folded into "Improve Existing
  Deck" and not replacing it. A user whose wording is already right but
  whose formatting looks off should be able to fix just that.
- **No live in-place shape editing.** Reading PowerPoint slide text via the
  in-host API (`shape.textFrame`) is measured broken on this project's
  reference Mac host (see `docs/OFFICE_PERPETUAL_COMPAT.md` row 11 and the
  project memory on PowerPoint host limits) — that finding is exactly why
  "Improve Existing Deck" already works by regenerating the whole slide and
  swapping it in, rather than editing shapes live. Setting font/size on
  existing shapes in place would very likely hit the same wall. This design
  does not attempt it.
- **No LLM-guessed formatting values.** Font size, family, and color come
  from the existing Deck Studio style engine (`deckStyles.js` packs'
  `type_scale`/`font` tokens) and the existing `fitText`/`fitBox` shrink
  algorithm in `pptxBuilder.js` — both already deterministic, already used
  by every other Deck Studio slide, already tested by production use. The
  language model's only role is classifying which existing line is a title
  vs. a bullet vs. a card title/description — never inventing pixel values,
  never rewriting.

## Architecture

Reuses the "Improve Existing Deck" pipeline almost entirely — read → LLM
step → preview → build PPTX → insert-and-replace — swapping only the LLM
step's job (classify structure, not rewrite content) and adding one new
verbatim-preservation guarantee on top.

```
selected slide
  → read verbatim text (companion extractor — same proven path
    "Improve Existing Deck" already uses via getSelectedSlideTextContext /
    activeDeckSlideTextFallback)
  → classify structure into a DeckSpec, wording UNCHANGED
    (new: fixSlideFormatting() in deckPlanner.js)
  → OWN minimal sanitation — NOT normalizeSlide()/normalizeSpec()
    (those inject synthetic text; see "Verbatim guarantee" below)
  → verify every text field is verbatim-present in the source, run
    LAST, after sanitation, against the sanitized spec
    (new: assertVerbatimSlide(), stricter than the existing loose
    enforceSourceGrounding() — modeled on editContract.js's
    whitespace-normalized exact-match philosophy instead)
    → on failure: deterministic fallback (split source into a plain
      "bullets" slide, one bullet per non-empty line) — reliability first,
      matching the existing "keep original on failure" pattern already used
      elsewhere in deckPlanner.js
  → render via the EXISTING buildDeckPptxBase64 / pptxBuilder pipeline
    (rendering itself unchanged — this is where type_scale, font, and
    fitText/fitBox-driven overflow-safe sizing already live, applied
    automatically, the same way for every Deck Studio slide; the new
    caller additionally opts into the diagnostics wrapper described below
    to learn whether any element was truncated)
  → preview, then insert-and-replace in place
    (unchanged: replaceSlideInActivePresentation, same options
    "Improve Existing Deck" uses; same download-the-.pptx fallback on
    replace failure)
```

## New pieces

1. **`FORMAT_FIX_SYSTEM` prompt + `fixSlideFormatting({ slideText, signal })`**
   in `src/deck/deckPlanner.js`, parallel to `IMPROVE_SLIDE_SYSTEM` /
   `improveExistingSlide`. Same output schema (`{title, slide: {type,
   headline, subhead, bullets, cards, columns, chartType, data}}`) so it
   flows through the same rendering path unchanged. The prompt differs from
   `IMPROVE_SLIDE_SYSTEM` in one respect that matters: every text value must
   be copied character-for-character from the source, only reorganized into
   the right structural bucket. No rephrasing, shortening, combining
   sentences, or "improving" wording — that is `improveExistingSlide`'s job,
   not this one's. Runs on `task: "deck"`, same as `improveExistingSlide`.

2. **Verbatim guarantee, tightened around the existing normalizers.**
   `normalizeSlide`/`normalizeSpec` — used by the deck-generation and
   `improveExistingSlide` paths — routinely inject text that isn't from any
   source: placeholder copy (`"(Isi poin di sini.)"`,
   `"(Tambahkan kartu konten.)"`, `"(Tambahkan kolom konten.)"`,
   `"(Tambahkan metrik.)"`, `"(Tambahkan data visualisasi.)"`), a forced
   `"closing"` slide with hardcoded headline `"Kesimpulan & Langkah
   Berikutnya"` and `defaultClosing()` bullets, and a `titleForType(type)` /
   `"Improved Slide"` fallback headline when nothing else survives. All of
   that is correct behavior for generating new content, and all of it is
   exactly the kind of synthetic text a formatting-only fix must never
   introduce. So `fixSlideFormatting()`:
   - **does not call `normalizeSlide()` or `normalizeSpec()`** at all;
   - runs its **own** minimal sanitation instead — coerce type to one of the
     known slide types, cap list lengths the same way the existing
     normalizers do, but **never fabricate a missing field**. A slide.type
     that ends up with no usable content after sanitation is a `null`
     result, which routes to the deterministic fallback (below), not to a
     placeholder string;
   - if a headline can't be recovered from the model's classification, falls
     back to `firstLine(source)` — genuinely from the source — never to
     `titleForType()` or `"Improved Slide"`;
   - never appends a closing slide; this function always returns exactly
     the one slide it was asked to fix.

3. **`assertVerbatimSlide(spec, source)`** — a new, stricter check than
   `enforceSourceGrounding` (which only checks vocabulary overlap, not exact
   text). Runs **after** the sanitation in point 2, against the sanitized
   spec — checking a pre-sanitation spec would miss text sanitation itself
   could still alter. For every text field, after whitespace normalization,
   the text must be an exact substring of the source — mirroring
   `editContract.js`'s `normalizeWs`-based matching, not the deck module's
   lexicon-overlap grounding. Any field that fails is dropped the same way
   `parseEditContract` now drops individual bad edits rather than failing
   the whole thing (see recent commit `da30a46`); if too little survives to
   be a usable slide, the whole result falls back to the plain
   one-bullet-per-line split. The only text in the final rendered slide that
   is *not* checked against the source is `pptxBuilder`'s own chrome/footer
   (e.g. "Tantular Deck Studio · N/Total") — that's injected at the XML
   layer, outside the DeckSpec entirely, and was already unconditional for
   every slide before this feature existed.

4. **A small, additive diagnostics hook in `pptxBuilder.js`**, so truncation
   can be surfaced without changing `fitText`/`fitBox`'s behavior or any
   existing caller's signature:
   - `fitText` gains an internal check: when it hits its hard-truncate
     branch (content actually shortened, not just resized), it records that
     fact to an optional module-level collector — a no-op when nothing is
     collecting, so its return value and behavior are byte-for-byte
     identical for every existing caller.
   - One new exported wrapper, `buildDeckPptxBase64WithDiagnostics(spec,
     styleId, projectInstructions)`, turns collection on, calls the
     existing, **completely unmodified** `buildDeckPptxBase64` internally,
     and returns `{ base64, truncated }` (`truncated`: which text got cut).
     `buildDeckPptxBase64` itself keeps its exact current signature and
     behavior — every existing call site is untouched and doesn't need to
     know this wrapper exists.
   - Only `fixSlideFormatting`'s caller uses the wrapper. Everywhere else in
     the app keeps calling `buildDeckPptxBase64` exactly as today.

5. **Truncation becomes visible, for this feature only.** Silently cutting
   real content is a bigger deal for a formatting-*fix* than for freely-
   generated Deck Studio content, where the model can always choose
   different words to fit. Using the diagnostics wrapper from point 4, if
   any element was truncated, the result still applies (better than
   nothing) but the status message names which element(s) got cut and says
   to shorten them manually — no silent data loss.

6. **PowerPoint chat gets a guard, not a new write path (v1).** The chat
   router's action set today is `improve_slide` / `replace_slide` /
   `add_slide` / `delete_slide`, and its own instructions already say "to
   fix an existing slide, use `improve_slide`" — so a chat request like
   "perbaiki format slide 4" would be classified straight into the
   wording-rewriting path with nothing to stop it. Rather than add a fifth
   op (`format_slide`) with its own confirm-gate wiring in v1, the router's
   system prompt gets an explicit instruction: recognize
   formatting-only phrasing ("perbaiki format", "rapikan ukuran", "font
   terlalu kecil/besar", "tidak konsisten ukurannya", and similar) and
   respond with **no action** plus a reply telling the user to use the new
   "Perbaiki format" button — never route it through `improve_slide`. A
   dedicated `format_slide` chat op that calls `fixSlideFormatting()`
   directly is a natural follow-up once the button path has shipped and
   proven itself; deferring it here keeps this plan direct, and the guard
   fully closes the misrouting risk on its own regardless of whether that
   follow-up ever happens.

7. **UI:** one new button, "🛠 Perbaiki format", next to "Improve selected
   slide" in the existing Deck Refine section
   (`src/taskpane.html`, `#refine-*` block) sharing that section's slide
   targeting, preview area, and status line — not a new section. A new
   `fixSelectedSlideFormatting()` handler in `taskpane.js`, structurally a
   near-duplicate of `refineSelectedSlide()` (same slide-text read path, same
   preview/replace/download-fallback flow), calling `fixSlideFormatting()`
   instead of `improveExistingSlide()`, rendering via
   `buildDeckPptxBase64WithDiagnostics` instead of `buildDeckPptxBase64`,
   and surfacing the truncation warning from point 5 when applicable.

## What does NOT change

- `deckStyles.js`: zero changes. The pack token system is reused exactly as
  it already works for every other slide.
- `pptxBuilder.js`: additive only — `fitText`'s existing behavior and every
  existing exported function's signature/behavior are unchanged for every
  current caller. The one addition is the opt-in diagnostics collector
  (New pieces, point 4), which nothing existing calls into.
- `normalizeSlide` / `normalizeSpec`: zero changes. `fixSlideFormatting`
  deliberately avoids them rather than modifying them, so the deck-
  generation and "Improve Existing Deck" paths that depend on their
  placeholder-filling behavior are unaffected.
- `improveExistingSlide` / "Improve Existing Deck": zero changes, stays the
  wording-focused sibling feature.
- `replaceSlideInActivePresentation` and its insert-then-delete safety
  mechanics: zero changes, reused as-is.
- PowerPoint chat's `improve_slide`/`replace_slide`/`add_slide`/
  `delete_slide` handlers: zero changes. Only the router's system prompt
  gains the formatting-intent guard (point 6).

## Error handling

- Slide text unreadable (image-only slide, no extractor result): same
  refusal message pattern `activeDeckSlideTextFallback` already uses — never
  guess at a different slide's content.
- Structure classification call fails outright (network/model error): fall
  back to the plain one-bullet-per-line split, same as a failed verbatim
  check — this feature should degrade to "at least apply consistent
  formatting" rather than fail completely, since the formatting fix is the
  entire point and doesn't strictly require the model to succeed.
- Replace-in-place fails (host limitation, deck state race): identical
  fallback already proven in `refineSelectedSlide` — download the .pptx,
  report clearly what did and didn't change.
- Truncation at the fit floor: surfaced in the status message per point 5
  above, never silent.
- Chat asks for a format fix: no action taken, no slide touched; the reply
  points at the "Perbaiki format" button (point 6).

## Testing

- `tests/deckPlanner.test.mjs` (existing file; `improveExistingSlide` has no
  tests there today, so this adds the first coverage for this style of
  function too): unit tests for `fixSlideFormatting` covering verbatim
  preservation (reject/drop a response that paraphrases), the bullets/cards/
  columns classification paths, the fallback split when classification
  fails, and — specifically regression-testing the review finding that
  triggered point 2 — that a slide with no recoverable headline/bullets
  degrades to the deterministic fallback rather than to `normalizeSlide`'s
  placeholder copy or a forced closing slide.
- `assertVerbatimSlide`: unit tests mirroring `editContract.test.mjs`'s
  whitespace-normalization test cases (exact match, whitespace-only
  differences, a genuinely paraphrased field gets rejected), run against
  sanitized specs (post point-2 sanitation, not raw model output).
- `tests/deckStyles.test.mjs` (existing file; already imports and tests
  `fitText`/`buildDeckPptxBase64` from `pptxBuilder.js`, including the
  "shrinks then truncates deterministically" case the new diagnostics hook
  builds on directly): add cases asserting the diagnostics collector
  reports a truncation when `fitText` hits its hard-truncate branch and
  reports none when it only shrank the size without cutting content; and
  that `buildDeckPptxBase64`'s output (bytes, not just behavior) is
  identical with and without the diagnostics wrapper in play, proving the
  addition is truly additive.
- PPT chat router: a test asserting a formatting-intent phrase produces no
  action and a reply naming the button, not an `improve_slide` op.
- No new PowerPoint-host-dependent test — this reuses
  `replaceSlideInActivePresentation`, whose behavior is already covered
  where it's tested today.

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
  → verify every text field is verbatim-present in the source
    (new: assertVerbatimSlide(), stricter than the existing loose
    enforceSourceGrounding() — modeled on editContract.js's
    whitespace-normalized exact-match philosophy instead)
    → on failure: deterministic fallback (split source into a plain
      "bullets" slide, one bullet per non-empty line) — reliability first,
      matching the existing "keep original on failure" pattern already used
      elsewhere in deckPlanner.js
  → render via the EXISTING buildDeckPptxBase64 / pptxBuilder pipeline
    (unchanged code path — this is where type_scale, font, and fitText/
    fitBox-driven overflow-safe sizing already live, applied automatically,
    the same way for every Deck Studio slide)
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

2. **`assertVerbatimSlide(spec, source)`** — a new, stricter check than
   `enforceSourceGrounding` (which only checks vocabulary overlap, not exact
   text). For every text field in the returned spec, after whitespace
   normalization, the text must be an exact substring of the source —
   mirroring `editContract.js`'s `normalizeWs`-based matching, not the
   deck module's lexicon-overlap grounding. Any field that fails is dropped
   the same way `parseEditContract` now drops individual bad edits rather
   than failing the whole thing (see recent commit `da30a46`); if too little
   survives to be a usable slide, the whole result falls back to the plain
   one-bullet-per-line split.

3. **Truncation becomes visible, for this feature only.** `fitText` already
   silently truncates with an ellipsis at its size floor — correct behavior
   for freely-generated Deck Studio content, where the model can always
   choose different words. It is the wrong behavior for a feature whose
   entire point is preserving the user's existing wording: silently cutting
   real content is a bigger deal here than in the generative case. The new
   code path compares `fitText`'s returned text against the input per
   element; if any were shortened, the result still applies (better than
   nothing) but the status message names which element(s) got cut and says
   to shorten them manually — no silent data loss. This is a deliberate,
   narrow deviation for this one caller; `fitText`/`fitBox` themselves are
   unchanged, so every other caller keeps today's behavior exactly.

4. **UI:** one new button, "🛠 Perbaiki format", next to "Improve selected
   slide" in the existing Deck Refine section
   (`src/taskpane.html`, `#refine-*` block) sharing that section's slide
   targeting, preview area, and status line — not a new section. A new
   `fixSelectedSlideFormatting()` handler in `taskpane.js`, structurally a
   near-duplicate of `refineSelectedSlide()` (same slide-text read path, same
   preview/replace/download-fallback flow), calling `fixSlideFormatting()`
   instead of `improveExistingSlide()` and surfacing the truncation warning
   from point 3 when applicable.

## What does NOT change

- `pptxBuilder.js`, `deckStyles.js`: zero changes. `fitText`/`fitBox` and the
  pack token system are reused exactly as they already work for every other
  slide.
- `improveExistingSlide` / "Improve Existing Deck": zero changes, stays the
  wording-focused sibling feature.
- `replaceSlideInActivePresentation` and its insert-then-delete safety
  mechanics: zero changes, reused as-is.

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
- Truncation at the fit floor: surfaced in the status message per point 3
  above, never silent.

## Testing

- `tests/deckPlanner.test.mjs` (existing file; `improveExistingSlide` has no
  tests there today, so this adds the first coverage for this style of
  function too): unit tests for `fixSlideFormatting` covering verbatim
  preservation (reject/drop a response that paraphrases), the bullets/cards/
  columns classification paths, and the fallback split when classification
  fails.
- `assertVerbatimSlide`: unit tests mirroring `editContract.test.mjs`'s
  whitespace-normalization test cases (exact match, whitespace-only
  differences, a genuinely paraphrased field gets rejected).
- No new PowerPoint-host-dependent test — this reuses
  `replaceSlideInActivePresentation`, whose behavior is already covered
  where it's tested today.

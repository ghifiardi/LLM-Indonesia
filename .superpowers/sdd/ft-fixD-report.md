# Fix D: edit target bank, teacher terminator stripping, cross-split dedup tiebreak

## D1 — expand `gen_edit._TARGETS`

`tantular/finetune/gen_edit.py`'s known-target bank (`_TARGETS`) was flagged
as too small (5 entries) for 5,000-example-scale generation: `_pick_target`
draws from it via `sha256(family_id:i) % len(_TARGETS)`, so at scale the same
handful of clean targets would be revisited constantly, producing
near-duplicate corrupted/instruction pairs that `generate.py`'s global dedup
would then have to strip back out.

Grown 5x (5 -> 25 entries), schema unchanged (`text`/`number`/`name`), with
varied lengths/registers (business, government, academic) and subject
matter. Every new entry deliberately contains at least one `_TERM_PAIRS`
canonical term as a mid-sentence lowercase word, so `_corrupt_terminology`
never dead-ends on `no_corruption_candidate` regardless of which entry gets
drawn — keeping every entry usable across all three corruption categories
(spelling/terminology/word_order) instead of leaving some entries
single-purpose.

Tests added in `tests/test_gen_edit.py`:
- `test_target_bank_meets_size_floor_for_5k_scale_generation` — size floor (>=20).
- `test_target_bank_entries_are_unique_and_schema_valid` — uniqueness, schema, word-count/spelling-candidate eligibility.
- `test_target_bank_entries_pass_bridge_validation_via_spelling_corruption` — every entry actually round-trips through the real bridge reconstruction oracle via `_corrupt_spelling` + `accept_edit`.

## D2 — strip trailing `<|im_end|>` from `TinkerProseTeacher.sample()`

Found in `tantular/finetune/gen_prose.py`. Added a pure module-level helper
`_strip_trailing_chat_terminator(text)` that repeatedly strips trailing
whitespace then a trailing `<|im_end|>` terminator (loop handles a
terminator followed by more trailing whitespace/terminators), leaving
mid-text occurrences untouched since they aren't at the end of the string.
`TinkerProseTeacher.sample()` now returns
`_strip_trailing_chat_terminator(self._tokenizer.decode(out_tokens))`
instead of the raw decode.

Tests added in `tests/test_gen_prose.py`:
- Direct unit tests of `_strip_trailing_chat_terminator` (trailing removal, surrounding whitespace, repeated trailing terminators, mid-text preserved, no-op when absent).
- `test_tinker_prose_teacher_sample_strips_trailing_im_end` / `test_tinker_prose_teacher_sample_preserves_mid_text_token` — exercise `TinkerProseTeacher.sample()` end-to-end with `_sampling_client`/`_tokenizer`/`_renderer` pre-populated by stubs (so `_ensure_ready` short-circuits and no `tinker`/`tinker_cookbook` import or network call ever happens).

## D3 — cross-split dedup tiebreak

Read `generate.py`'s dedup+split flow (`run_generate`, global near-dup block
then split partition) and `dedup.py`'s `near_duplicates` (already
deterministic and pure — first occurrence in the given sequence is kept,
later near-duplicates in the same cluster are flagged; no set/dict iteration
involved).

**Real, addressable surface found**: `run_generate` hands `near_duplicates`
the `accepted` list in raw GENERATION order (families iterated sorted by id
within each kind, interleaved across splits by `assign_splits`' hash draw) —
not split order. "First occurrence wins" therefore meant "generated first
wins", with no regard for split. A train-split example generated before its
eval/challenge near-duplicate would survive at the held-out example's
expense — near-duplicate leakage into train, or (if the eval item happened
to lose the coin flip) shrinkage of the held-out split — either way backwards
from the point of holding examples out.

**Policy implemented** (documented as the canonical source in
`_apply_global_dedup`'s docstring in `generate.py`): when a near-duplicate
cluster spans splits, the eval/challenge copy is always protected; the
train-side copy is the one dropped. Mechanism: the destructive dedup block
was extracted into a new pure-ish function `_apply_global_dedup(accepted,
rejected, dedup_threshold) -> (accepted, rejected, dedup_log)`. Before calling
`near_duplicates`, it builds a REORDERED view of `accepted`'s indices —
stable sort on `(split_priority, original_index)` where
`split_priority = {"eval": 0, "challenge": 0, "train": 1}` — so eval/challenge
examples always precede train examples in the sequence handed to
`near_duplicates`; ties within the same priority bucket keep original
generation order. `near_duplicates`' resulting duplicate positions (indices
into the reordered view) are mapped back through `order[pos]` to indices
into the original `accepted` list before the destructive removal, which
still iterates `accepted` in original order so `dedup_log`/`rejects.jsonl`
ordering is unaffected — the reorder is purely a tiebreak input, not an
output-order change. Both the reorder and the mapping are plain list/tuple
operations on ints; no set/dict iteration is anywhere in the ordering logic.

**"Pre-existing split files on incremental runs" surface**: checked whether
this exists. `run_generate` has no incremental/resume code path — no code
anywhere reads a prior run's `train.jsonl`/`eval.jsonl`/`challenge.jsonl`
before generating; every run starts from an empty `accepted`/`rejected`.
(Separately, `review_promote.py`'s `apply_review_queue` — not touched here —
already pools dedup across all three split files for the promotion path,
per `.superpowers/sdd/ft-fixC-report.md`; that's a different code path from
`run_generate`.) So that surface does not exist in the current codebase for
`generate.py`; documented in `_apply_global_dedup`'s docstring as a NOTE so
it isn't silently forgotten if an incremental mode is added later.

Tests added in `tests/test_generate.py` (new `_apply_global_dedup` import,
`_accepted_example` helper):
- `test_apply_global_dedup_protects_held_out_split_even_when_train_generated_first`
- `test_apply_global_dedup_protects_challenge_split_too`
- `test_apply_global_dedup_ties_within_same_split_keep_original_order`
- `test_apply_global_dedup_ties_within_eval_split_keep_original_order`
- `test_apply_global_dedup_no_duplicates_is_a_pure_noop`
- `test_apply_global_dedup_does_not_mutate_inputs_in_place`
- `test_apply_global_dedup_empty_accepted_is_a_noop`

## Verification

```
tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/ -q
213 passed in 2.15s
```

196 pre-existing tests + 17 new (3 D1 + 7 D2 + 7 D3) tests, all green. `dedup.py` and `review_promote.py` were not modified (the
latter per explicit instruction — another agent's concurrent work). No
Tinker/API calls made anywhere (all teacher/sampling interactions are
deterministic stubs; `TinkerProseTeacher.sample()` was exercised via
directly-populated stub internals, never via `_ensure_ready`'s real
`tinker`/`tinker_cookbook` imports); `~/.tantular-tinker.env` was never read.

## Commit

`fix(finetune): expand edit target bank, strip teacher im_end, deterministic train-tiebreak dedup`

## Rejection fix pass (bdef09c rejected on two Important findings)

Commit `bdef09c` was rejected on two Important findings from review. Both fixed below.

### D1 gap — entry 8 had no lowercase mid-sentence `_TERM_PAIRS` term

Despite the module docstring's claim that every `_TARGETS` entry contains a
mid-sentence lowercase `_TERM_PAIRS` term, entry 8 ("Pelanggan setia
mendapatkan diskon khusus sebesar 20 persen setiap bulan.") did not: its
only term-bank word ("Pelanggan") was sentence-initial and capitalized, and
`_find_term_in_text` matches lowercase occurrences only by design (so a
capitalized find/replace pair never trips `_guard_name_number_altered`'s
"looks like a name" heuristic). Verified programmatically that entry 8 was
the *only* offender across all 25 entries before assuming it was isolated.

Fix: reworded entry 8 to
`"Divisi layanan memberikan diskon khusus kepada pelanggan setia sebesar 20
persen setiap bulan."` — same schema (`text`/`number="20"`/`name=None`),
final period preserved, distinct from every other entry, and "pelanggan"
now appears lowercase mid-sentence. Re-verified `_find_term_in_text` returns
non-None for all 25 entries after the change, and that all entry texts
remain unique.

Test added in `tests/test_gen_edit.py`:
- `test_target_bank_entries_all_have_a_terminology_candidate` — calls
  `_corrupt_terminology` (not `_find_term_in_text` directly, since
  `_corrupt_terminology` is the actual synthesis-path function, and it is
  fully deterministic — its `rng` parameter is unused, so a single call per
  entry is the correct, tightest assertion, unlike the multi-attempt-retry
  pattern needed for `_corrupt_spelling`) across every `_TARGETS` entry,
  asserting a non-None candidate every time.

### D2 gap — `TinkerRouterTeacher.sample()` never stripped the trailing terminator

`_strip_trailing_chat_terminator` previously lived only in `gen_prose.py`
and was applied only inside `TinkerProseTeacher.sample()`.
`TinkerRouterTeacher.sample()` in `gen_router.py` decodes teacher output
with the identical `tokenizer.decode` pattern and feeds it straight into
`_split_candidates` (the router synthesis path), which does not itself
strip a trailing terminator — so `<|im_end|>` could land inside an accepted
router-synthesis completion.

Fix: extracted the stripping helper into a new shared module,
`tantular/finetune/teacher_text.py`
(`strip_trailing_chat_terminator(text)`), since no existing shared-util
module fit (`provenance.py` is schema-specific, `bridge_client.py` is
JS-bridge-specific) and cross-importing between `gen_prose.py` and
`gen_router.py` directly would have coupled two otherwise-independent
synthesis modules to each other instead of to a common utility.
`gen_prose.py` now imports it under the original name
`_strip_trailing_chat_terminator` (re-exported at module top, so existing
callers/tests reaching into `gen_prose` for that name keep working
unchanged). `gen_router.py`'s `TinkerRouterTeacher.sample()` now calls
`strip_trailing_chat_terminator` on its decoded output before returning.

`TinkerEditTeacher` in `gen_edit.py` needs no code change: added a comment
on `_parse_edits_json` (its consumer) documenting why — that function slices
`text.find("{")..text.rfind("}")`, structurally discarding any trailing
terminator token regardless of whether it was stripped upstream, so
stripping there would be redundant, not incorrect.

Tests added in `tests/test_gen_router.py` (mirrors
`test_gen_prose.py`'s `TinkerProseTeacher` stub-teacher tests, same stub
classes re-declared locally):
- `test_tinker_router_teacher_sample_strips_trailing_im_end`
- `test_tinker_router_teacher_sample_preserves_mid_text_token`

## Verification (rejection fix pass)

```
tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/ -q
216 passed in 2.07s
```

213 pre-existing (post-bdef09c) tests + 3 new (1 D1 terminology-bank test +
2 D2 router-teacher tests), all green. `review_promote.py` not touched.
No Tinker/API calls made anywhere (`TinkerRouterTeacher.sample()` was
exercised via directly-populated stub internals, never via `_ensure_ready`'s
real `tinker`/`tinker_cookbook` imports); `~/.tantular-tinker.env` was never
read.

## Commit

`fix(finetune): terminology-usable target entry 8 + shared im_end strip for router teacher`

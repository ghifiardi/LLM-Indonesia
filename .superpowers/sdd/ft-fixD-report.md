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

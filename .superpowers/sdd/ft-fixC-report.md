# Fix C: promotion dedup pools all splits (cross-split near-dup contamination)

## Hole (Critical)

`tantular/finetune/review_promote.py`'s `apply_review_queue` (~lines
659-702 in the reviewed revision, `commit 597c61b`) checked a promoted
item's dedup text only against `existing_texts_by_split[split]` (the
item's OWN resolved split) plus same-run additions to that SAME split.

But `generate.py:809-833` (`run_generate`) establishes a corpus-global
invariant: `dedup.near_duplicates` is run over ALL accepted examples
across train/eval/challenge combined, BEFORE the corpus is split. No
accepted example anywhere may near-duplicate any other, regardless of
which split it ends up in.

The promotion path violated that invariant: a queue item resolving to
`train` could near-duplicate an example already sitting in `eval` (or
`challenge`) and would be silently promoted anyway, since only same-split
duplicates were ever checked. This contaminates held-out splits with
near-duplicates of training data.

## Fix

In `apply_review_queue`:
- Replaced the per-split `existing_texts_by_split` dict with a single
  `existing_pool_texts` list built by concatenating `_dedup_text(ex)` for
  every existing example across all three split files (train, eval,
  challenge).
- Each promoted item's dedup check now runs `near_duplicates` against
  `existing_pool_texts + [text]` (the global pool), not a per-split pool.
- On promotion (not skip), the item's text is appended to
  `existing_pool_texts` so later items promoted in the SAME run — to any
  split — are also checked against it (same same-run-visibility guarantee
  the old per-split code had, now correctly scoped globally).
- The `skipped_duplicate` reporting/skip shape is unchanged: a caught
  duplicate is still recorded in `result["skipped_duplicate"]` and never
  appended, matching the existing per-split skip flow.

Docstrings for `apply_review_queue` and the module-level near-dup mention
were updated to describe the corpus-wide (not per-split) pooling and why
it mirrors `generate.run_generate`'s invariant.

## TDD

Added `test_apply_skips_cross_split_near_duplicate_train_item_vs_existing_eval`
in `tantular/finetune/tests/test_review_promote.py`: a queue item whose
family resolves to `train` and whose text near-duplicates an example
pre-seeded into `eval.jsonl` (not `train.jsonl`) must be skipped as a
duplicate, not promoted.

Verified red/green:
- Stashed the `review_promote.py` fix (test file kept) and ran the new
  test alone: **FAILED** — `assert [] == ['84d5693072513b7e']`, i.e. the
  old code promoted the cross-split duplicate instead of skipping it.
- Restored the fix: the same test passes.

Kept/adapted the existing same-split dedup test
(`test_apply_skips_near_duplicate_of_existing_accepted_example`) unchanged
— it still exercises the same-split case, which the global pool still
covers (a strict superset).

## Verification

```
tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/ -q
196 passed in 2.00s
```

195 pre-existing tests + 1 new test, all green. No Tinker/API calls made
(offline only — `StubBridge` used throughout, as in the existing tests).

## Commit

`fix(finetune): promotion dedup pools all splits to preserve cross-split invariant`

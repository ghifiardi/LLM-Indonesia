# Fix C: review-queue promotion CLI

## What was built

`tantular/finetune/review_promote.py` — a non-interactive, flag-driven CLI (and
importable library) that lets a human turn `review_queue.jsonl` entries
(written by `generate.run_generate`) into full provenance-tracked training
examples, without regenerating anything and without any Tinker/teacher call.

Subcommands: `list`, `show <id>`, `accept <id> [--note]`, `reject <id>
[--note]`, `apply [--seed] [--dedup-threshold] [--allow-prompt-drift]
[--dry-run] [--node-bin]`.

### Addressing

`review_queue.jsonl` entries carry no `id` of their own (positional index
isn't stable across re-generation), so items are addressed by
`queue_item_id()` — a sha256 content hash of the entry, truncated to 16 hex
chars.

### Decisions file

`review_decisions.json` in the same data dir: `id -> {decision, note,
decided_at, applied_at}`. Written atomically (temp file + `Path.replace`).
`accept`/`reject` never touch the bridge or Tinker — pure file I/O, so they
never require Node or `~/.tantular-tinker.env`.

### Reconstruction (`reconstruct_example`)

"Light reconstruction" per the brief: `messages`/`payload` are rebuilt from
the axis-specific fields the queue entry already carries (router:
`message`/`intent`/`cold_intent`/`ambiguous`; edit:
`source_text`/`instruction`/`edits`/`produced_text`/`judge_verdict`, mirroring
`gen_edit._edit_messages`'s exact `"Dokumen:\n{...}\n\nInstruksi: {...}"`
format; prose: `user_text`/`output`) — same shape
`gen_router.py`/`gen_edit.py`/`gen_prose.py` build internally. `split` is
recomputed via `families.assign_splits(enumerate_families(), seed)` (seed
read from `generation_manifest.json`, or explicit `--seed`). The system
prompt *content* is re-fetched from `BridgeClient.dump_prompts()` (offline,
local Node subprocess — free, not Tinker) and its `contentHash` is checked
against the entry's `production_prompt_content_hash`; a mismatch raises
`PromptDriftError` unless `--allow-prompt-drift` is passed.

The result is schema-identical to a directly-accepted `provenance.make_example`
output — same `provenance` keys, same `generation`/`training` blocks — except
`provenance.status`, which uses two new status values added to
`provenance.py`'s vocabulary: `STATUS_ACCEPTED_HUMAN_REVIEW` /
`STATUS_REJECTED_HUMAN_REVIEW`. `generate.verify_artifacts`'s status check was
relaxed to accept `STATUS_ACCEPTED_HUMAN_REVIEW` alongside `STATUS_ACCEPTED`
in train/eval/challenge, since a promoted example legitimately belongs there.

### `apply` (idempotent, durable)

For every decision not yet `applied_at`: accept → reconstruct
(`STATUS_ACCEPTED_HUMAN_REVIEW`) and append to the resolved split's artifact
file, unless `dedup.near_duplicates` flags it against what's already in that
split (existing content + anything else this same `apply` run is about to
add) — then it's recorded as `skipped_duplicate`, never appended. reject →
reconstruct (`STATUS_REJECTED_HUMAN_REVIEW`, `reject_reason =
"human_review:<note or original queue reason>"`) and append to
`rejects.jsonl` (never mixed into an accepted split). Every processed
decision gets `applied_at` stamped and the decisions file is rewritten
atomically; re-running `apply` skips anything already applied — verified
against both a stub bridge and the real (Node) `BridgeClient`, no duplicate
examples on re-run. Decisions whose id fell out of the current queue are
skipped, never crash `apply`.

## Testing

New file: `tantular/finetune/tests/test_review_promote.py`, 27 tests —
queue-item id determinism/loading, decisions round-trip + unknown-id error +
overwrite, `resolve_seed` (explicit/manifest/default), reconstruction schema
parity vs. a genuinely directly-accepted example (built via a real
`generate_prose(..., spot_check_every=1)` call so the review-queue entry and
the accepted example come from the *same* underlying candidate), per-axis
message/payload reconstruction (router/edit), missing-field errors, prompt
drift (raise + `--allow-prompt-drift` override), `apply` promotion / rejection
/ idempotency / pending-items / near-dup skip / dry-run / stale-decision
tolerance, and CLI smoke tests (`main()` list/show/accept/reject, unknown-id
exit codes).

Also manually verified end-to-end against the **real** `BridgeClient` (local
Node subprocess against `bridge.mjs`, never Tinker): `list` → `accept` →
`apply` produced a correctly-shaped `train.jsonl` entry, and a second `apply`
run was a no-op (`already_applied: 1`, file unchanged).

All 168 pre-existing tests plus the 27 new ones pass: **195 passed**.

## Files changed

- `tantular/finetune/review_promote.py` (new)
- `tantular/finetune/tests/test_review_promote.py` (new)
- `tantular/finetune/provenance.py` — added `STATUS_ACCEPTED` /
  `STATUS_REJECTED` / `STATUS_ACCEPTED_HUMAN_REVIEW` /
  `STATUS_REJECTED_HUMAN_REVIEW` constants; docstring update.
- `tantular/finetune/generate.py` — `verify_artifacts` now accepts
  `STATUS_ACCEPTED_HUMAN_REVIEW` as a valid accepted status alongside
  `STATUS_ACCEPTED`.

## Concerns / follow-ups

- Changing a decision (`accept`→`reject` or vice versa) **after** `apply` has
  already run does not retroactively remove/rewrite the earlier append —
  `applied_at` is preserved and re-running `apply` treats the item as done.
  This is a deliberate scope boundary (documented in the module/function
  docstrings), not a bug, but a reconciliation/"unapply" path doesn't exist
  yet if that's needed later.
- `apply` always needs a live (offline, free) bridge subprocess to re-fetch
  system-prompt content — `list`/`show`/`accept`/`reject` do not.
- The near-dup check on `apply` only compares a newly-promoted item against
  its own resolved split's existing content, not globally across all three
  splits (matches `generate.run_generate`'s per-artifact write granularity,
  but is narrower than that module's one-shot global dedup pass across all
  accepted examples together).
- No live pilot-produced `review_queue.jsonl` currently exists on disk in
  `tantular/finetune/data/` (only `pilot_report.json` / `PILOT_WALKTHROUGH.md`
  — `pilot.py` only counts review-queue items, it never persists them; only
  `generate.run_generate` writes `review_queue.jsonl`). The CLI targets that
  file format; it was validated against hand-built fixtures and a live
  `generate.run_generate(..., data_dir=...)` invocation with a stub teacher
  (via the existing test suite's own harness), not against a real
  Tinker-produced queue.

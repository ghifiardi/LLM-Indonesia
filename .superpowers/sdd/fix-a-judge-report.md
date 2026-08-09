# Fix A: teacher-as-judge for fallback edit subtypes

## Problem
`gen_edit.py`'s three no-synthesizable-target edit subtypes (perjelas,
elaborasi, ringkas_bagian) had no judge implementation, so every
validator-cleared candidate was queued for human review and 0% were ever
accepted -- confirmed in the live pilot.

## What changed

### 1. `tantular/finetune/judge.py` (new)
`TinkerEditJudge`: a real Tinker-backed judge, following the exact
lazy-import / teacher-model (`Qwen/Qwen3.5-397B-A17B`) / renderer
(`qwen3_5_disable_thinking`) pattern as `gen_router.TinkerRouterTeacher` /
`gen_edit.TinkerEditTeacher`. Callable with `generate_edit`'s injected
`judge(source_text, instruction, produced_text) -> Any` contract exactly
(verified by a signature-inspection test).

`JUDGE_PROMPT_TEMPLATE`: Indonesian prompt asking for a strict verdict on
whether the produced (post-edit) text faithfully and completely implements
the instruction on the source text without unlicensed changes. Output
contract: first token `LULUS` or `GAGAL`, one line of reason.
`JUDGE_PROMPT_HASH` via the same `_hash_constants` pattern as the
generators.

`parse_verdict(raw)`: lenient parse -- finds the first occurrence of either
`LULUS` or `GAGAL` anywhere in the text (case-insensitive), not a strict
prefix match. Returns `{"verdict": "PASS"|"FAIL", "reason": ..., "raw": ...}`.
Unparseable output is conservatively `FAIL` (never silently passes).

### 2. `tantular/finetune/gen_edit.py`
Fallback flow now spec-aligned:
- `judge=None` (degraded mode): unchanged -- every validator-cleared
  candidate is queued into `review_queue`, never accepted.
- `judge` provided: `_judge_passed(verdict)` reads the judge's return value
  (dict with a `"verdict"` key, or a bare "PASS"/"FAIL" string). FAIL ->
  `rejected` with `reject_reason="judge_rejected"`. PASS -> `accepted` (the
  actual training example), and every `FALLBACK_JUDGE_SAMPLE_EVERY_N`th
  (=10) accepted fallback example is *additionally* copied into
  `review_queue` (`reason="sampled_judge_pass"`) for human audit, on top of
  being accepted.
- `judge_prompt_hash` (already an existing param) is recorded verbatim into
  every fallback example's `generation.judge_prompt_hash`, same as before.

### 3. Live wiring
- `pilot.py` `main()` and `generate.py` `main()` now construct
  `judge.TinkerEditJudge()` and pass it as `judge=`, plus
  `judge_prompt_hash=judge.JUDGE_PROMPT_HASH`. `run_pilot` already wraps it
  in `MeteredJudge`; the pre-existing `judge is None` caveat in
  `run_pilot`'s report now no longer fires from either `main()`.
- Added a `judge_prompt_hash` parameter to `run_pilot` and `run_generate`,
  threaded through to their `generate_edit` calls (and into
  `generate.py`'s `_edit_generation_meta()`, which previously hardcoded
  `None`).
- Updated stale comments in `generate.py` that assumed fallback subtypes
  "always" queue-only / never contribute to exposure-mix accounting --
  judge-PASS fallback examples now flow into that accounting like any other
  accepted example.

### 4. Tests (all stubs, no network)
- `tests/test_judge.py` (new): `JUDGE_PROMPT_HASH` shape/stability,
  `parse_verdict` (pass-first, fail-first, lenient case, first-occurrence-
  wins-when-both-present, unparseable -> conservative FAIL, None/empty
  input), `TinkerEditJudge` constructs without touching the network, and its
  `__call__` signature matches `generate_edit`'s judge contract.
- `tests/test_gen_edit.py`: replaced the old "fallback never auto-accepts"
  pinned test with three: judge=None still queues everything (unchanged
  behavior, renamed test); judge-FAIL rejects with `judge_rejected`;
  judge-PASS accepts every candidate and samples exactly one review-queue
  copy at the Nth accepted example (`FALLBACK_JUDGE_SAMPLE_EVERY_N + 1`
  candidates -> exactly 1 sampled). Plus a `_judge_passed` unit test and a
  judge_prompt_hash-threading test for the fallback path.
- `tests/test_generate.py`: new integration test (`FallbackAwareSampler`,
  a `CombinedSampler` subclass that answers fallback-subtype instructions
  too) verifying a judge-PASS fallback example is genuinely written to
  train/eval/challenge with the real `judge_prompt_hash` in its provenance.
- `tests/test_pilot.py`: pre-existing `judge=None` caveat tests
  (`test_run_pilot_caveats_notes_judge_none_by_default` /
  `..._empty_when_judge_provided`) already covered the caveat-suppression
  behavior at the `run_pilot` level; left as-is (still passing, still exact
  fit for the "pilot caveat suppressed when judge present" requirement).

## Test results
`tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/ -q`
-> **163 passed** (148 baseline + 15 new: 1 judge.py hash/const,
7 parse_verdict, 2 TinkerEditJudge construction/signature, 5 gen_edit fallback
flow, 1 generate.py judge_prompt_hash integration -- see file diffs for exact
count per file).

## Concerns / judgment calls
- `FALLBACK_JUDGE_SAMPLE_EVERY_N = 10` is a documented judgment call (no
  canonical source), same spirit as other magic numbers already in this
  module (`FALLBACK_FAMILIES_PER_SUBTYPE`, etc.).
- The judge prompt asks about the *produced (post-edit) text* vs.
  instruction/source, not the raw edit JSON verbatim -- `generate_edit`'s
  injected judge call contract is `judge(source_text, instruction,
  produced_text)` (no edits JSON argument), so the prompt is worded around
  what's actually available at the call site. This is a faithful adaptation
  of the spec's "does the edit JSON faithfully implement the instruction"
  intent to the existing (unchanged) call signature, not a signature change.
- No live Tinker call was made anywhere in this change -- `TinkerEditJudge`
  imports `tinker`/`tinker_cookbook` lazily inside `_ensure_ready`/
  `__call__`, mirroring the existing teacher classes exactly.

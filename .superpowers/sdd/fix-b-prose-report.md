# Fix B: prose reject-reason histograms + filter/elicitation tuning from live probe

## Problem
Live pilot data (`tantular/finetune/data/pilot_report.json`) showed weak
prose acceptance for three pipelines -- `prose:terjemah` 2/10,
`prose:ringkas` 3/10, `prose:tanyaDokumen` 3/10 -- but the pilot report only
carried counts, not reject REASONS, so the three suspects named in the brief
(commentary-wrapper filter, bullet-format filter, length caps/elicitation)
could not be confirmed or ruled out from the artifact alone.

## What changed

### 1. `tantular/finetune/pilot.py` -- reject-reason histogram
`run_pilot`'s per-stratum loop now builds `reject_reasons: {reason: count}`
by tallying each rejected example's `provenance.reject_reason` (defaulting
to the literal string `"unknown"` if ever missing/None, rather than
crashing or silently dropping it). Pure aggregation over data every
generator (`generate_router`/`generate_edit`/`generate_prose`) already
stamps via `provenance.make_example` -- no generator-side changes needed.
Added to every stratum entry in the written `pilot_report.json`.

### 2. Live mini-probe (`.superpowers/sdd/fix-b-probe.md`)
Ran `generate_prose` directly against the real Tinker teacher (not
`run_pilot`, to capture verbatim rejected text alongside the histogram) for
the three weak strata, 10 candidates each, using
`tantular/finetune/.venv/bin/python` with `TINKER_API_KEY` sourced from
`~/.tantular-tinker.env`. **Finding: every reject across all three strata,
before AND after tuning, was `near_duplicate` -- zero `format_invalid`,
`length_invalid`, or `cjk_leakage` observed.** None of the three brief-named
suspects fired. Root cause: `terjemah`/`ringkas`/`tanyaDokumen` are
near-deterministic tasks (translate/summarize/answer over a FIXED source
text), so repeat draws of the same seed produce near-identical teacher
output, and the `_SEEDS` bank for these three pipelines had only 2 entries
each -- a 10-candidate batch collided on the same seed ~5x, and
`dedup.near_duplicates` (correctly) rejected the resulting genuine
near-duplicate outputs.

### 3. `tantular/finetune/gen_prose.py` -- minimal tuning
Widened `_SEEDS["terjemah"]`, `_SEEDS["ringkas"]`, and
`_SEEDS["tanyaDokumen"]` from 2 to 6 distinct hand-authored scenario seeds
each (following the existing seed-bank style/realism, per the module
docstring), to reduce same-seed collision frequency within a batch. No
change to `format_ok`, `_has_commentary_wrapper`, or `_LENGTH_CAPS` -- the
live evidence showed those filters were never the rejection cause for this
data, so they were left untouched per the "MINIMAL tuning" instruction
(speculatively "fixing" an unconfirmed suspect would have been scope creep,
and untestable against real evidence anyway).

Re-ran the mini-probe once after tuning (one iteration, per the two-iteration
cap):

| pipeline | before | after |
|---|---|---|
| terjemah | 2/10 | 6/10 |
| ringkas | 2/10 | 5/10 |
| tanyaDokumen | 4/10 | 7/10 |

(Live teacher sampling is stochastic -- the "before" run's 2/10, 2/10, 4/10
is close to, but not byte-identical to, the original pilot artifact's 2/10,
3/10, 3/10; both runs agree the reject reason is exclusively
`near_duplicate`.) All remaining rejects post-tuning are still
`near_duplicate` -- consistent with the diagnosis (a wider-but-still-finite
seed bank still collides sometimes at n=10 draws; see fix-b-probe.md for the
birthday-paradox arithmetic and the reasoning for stopping at 6 seeds rather
than widening further).

### 4. Tests
- `tantular/finetune/tests/test_pilot.py` (+3): `reject_reasons` is an exact
  histogram when every reject shares one reason (`format_invalid`); a mixed
  case where two different strata rejects land under two different reason
  keys in the same stratum (`length_invalid` + `near_duplicate`); an empty
  `{}` when nothing in the stratum rejected.
- `tantular/finetune/tests/test_gen_prose.py` (+2): pins the widened seed
  bank size (`>= 6`) for the three near-deterministic pipelines so a future
  edit can't silently shrink it back to a collision-prone 2 seeds; a loose
  distribution check that `_pick_seed` over 10 draws on the widened
  `terjemah` bank lands on more than 2 distinct seeds.

## Test results
`tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests -q`
run from repo root -> **168 passed** (163 baseline per the task brief + 5
new: 3 `test_pilot.py` reject-reason-histogram tests, 2 `test_gen_prose.py`
seed-bank-widening pin tests).

## Concerns / judgment calls
- The three brief-named suspects (commentary wrapper, bullet-format miss,
  length caps) were never confirmed as live rejection causes in this probe
  -- they may still be real risks under different seed content or teacher
  sampling params, just not what showed up in this batch. Left completely
  untouched (no speculative changes) per the brief's evidence-first
  instruction.
- Widening the seed bank reduces but does not eliminate near_duplicate
  rejects for these three near-deterministic pipelines -- a 6-seed bank at
  n=10 draws still has expected repeats. A more thorough fix (e.g.
  generating seeds programmatically at synthesis time, or lowering
  `dedup_threshold` specifically for these pipelines) was judged out of
  scope for "MINIMAL tuning" / the two-iteration cap.
- Every raw teacher completion observed in the probe carries a trailing
  `<|im_end|>` control-token artifact (from `TinkerProseTeacher.sample`'s
  `tokenizer.decode(out_tokens)` not stripping special tokens). This doesn't
  trip any current accept/reject filter and wasn't the cause of any prose
  rejection observed, so it's out of this fix's scope -- but it's a
  data-quality smell (`<|im_end|>` would land verbatim in an accepted
  training example's assistant turn) worth a follow-up ticket before the
  full corpus run.
- The mini-probe driver script (direct `generate_prose` calls against the
  real Tinker teacher, not `run_pilot`) is a one-off, intentionally not
  committed -- `.superpowers/sdd/fix-b-probe.md` is the durable record, and
  the same probe is trivially re-derivable from `gen_prose.generate_prose` +
  `pilot._pilot_families` directly if needed again.
- Live pilot spend for this task: 2 mini-probe runs x 30 candidates each x
  real Qwen3.5-397B-A17B sampling calls -- cents, well within the
  single-stratum-probe authorization; no full pilot or full generation run
  was executed.

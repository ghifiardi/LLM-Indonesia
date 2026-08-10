"""Task 11: full-generation orchestrator -- four provenance-tracked artifacts.

Per the design spec and the task brief, this module is the thing that
actually produces the ~5000-accepted-example fine-tune corpus, once the
Task 10 pilot has confirmed the run is under budget: it loops
`gen_router.generate_router` / `gen_edit.generate_edit` /
`gen_prose.generate_prose` across every family/stratum on all three axes,
balances how many candidates it asks for per stratum so the corpus lands at
the spec's exposure-mix target (20% router / 40% edit / 40% prose, measured
by TRAINING-TOKEN exposure of the accepted completions -- not by raw example
count, which would wildly overweight prose/edit's long completions against
router's one-word answers, or wildly underweight them the other way), runs
the global near-duplicate filter (`dedup.near_duplicates`) across every
accepted example (not just within one family's batch, unlike
`gen_prose.generate_prose`'s per-batch dedup), and writes the four physical
corpus artifacts (`train.jsonl` / `eval.jsonl` / `challenge.jsonl` /
`rejects.jsonl`) plus a `review_queue.jsonl` (never mixed into the four
artifacts -- review items are neither accepted nor rejected) and a
`generation_manifest.json` recording exactly what happened.

Teacher/bridge/judge access is always injected (`run_generate`'s
`teacher_sampler` / `cold_sampler` / `judge` / `bridge` parameters) -- this
module never calls Tinker at import time, and tests only ever pass
deterministic stubs plus the real (offline, Node-subprocess) `BridgeClient`
against `tantular_office_addin/tools/finetune/bridge.mjs`. The real
Tinker-backed path lives only in `main()`
(`python -m tantular.finetune.generate`), wiring the exact same
`TinkerRouterTeacher` / `TinkerEditTeacher` / `TinkerProseTeacher` /
`BridgeClient` construction as `pilot.py`'s `main()`, and sharing its
`TeacherSpendLedger` / `MeteredSampler` / `MeteredJudge` metering machinery
(imported from `pilot`, not reimplemented) so the full run's manifest
reports real spend the same way the pilot report does.

Review-queue promotion (human review turning a review-queue item into an
accepted/rejected example) has no CLI yet -- out of scope for this task, per
the brief. Because of that, `run_generate` deliberately treats ANY
unresolved review-queue item as a loud, non-zero-exit failure at the end of
the run: there is currently no way for this corpus to be "done" while
review-queue items sit unresolved, and pretending otherwise (exit 0, silently
drop them) would be a repeat of the deferred-provenance finding from the
Task 7 review this task is closing. Every review-queue entry written to
`review_queue.jsonl` carries full provenance context (`prompt_id`,
`production_prompt_content_hash`, `production_prompt_git_sha`, and the same
`generation` block an accepted/rejected example would carry) specifically so
a future human-review/promotion CLI has everything it needs without having
to re-derive it.
"""

import argparse
import json
import math
import pathlib
import sys

from tantular.finetune.dedup import DEFAULT_THRESHOLD as DEFAULT_DEDUP_THRESHOLD
from tantular.finetune.dedup import near_duplicates
from tantular.finetune.families import (
    DEFAULT_INSTANCES_PER_KIND,
    PROSE_PIPELINES,
    ROUTER_INTENTS,
    assign_splits,
    enumerate_families,
)
from tantular.finetune.gen_edit import (
    FALLBACK_SUBTYPES,
    SYNTHESIS_PROMPT_HASH as EDIT_SYNTHESIS_PROMPT_HASH,
    SYNTHESIZABLE_SUBTYPES,
    TEACHER_MODEL as EDIT_TEACHER_MODEL,
    TEACHER_RENDERER as EDIT_TEACHER_RENDERER,
    generate_edit,
)
from tantular.finetune.gen_prose import (
    JUDGE_PROMPT_HASH as PROSE_JUDGE_PROMPT_HASH,
    SYNTHESIS_PROMPT_HASH as PROSE_SYNTHESIS_PROMPT_HASH,
    TEACHER_MODEL as PROSE_TEACHER_MODEL,
    TEACHER_RENDERER as PROSE_TEACHER_RENDERER,
    generate_prose,
)
from tantular.finetune.gen_router import (
    COLD_PROMPT_HASH as ROUTER_COLD_PROMPT_HASH,
    SYNTHESIS_PROMPT_HASH as ROUTER_SYNTHESIS_PROMPT_HASH,
    TEACHER_MODEL as ROUTER_TEACHER_MODEL,
    TEACHER_RENDERER as ROUTER_TEACHER_RENDERER,
    generate_router,
)
# Shared metering machinery -- deliberately reused, not reimplemented, so the
# full run's spend accounting is identical in shape to the pilot's.
from tantular.finetune.pilot import (
    BRIDGE_PATH,
    MeteredJudge,
    MeteredSampler,
    TeacherSpendLedger,
    _require_tinker_api_key,
    _tinker_tokenizer_token_counter,
    default_token_counter,
)
from tantular.finetune.provenance import (
    STATUS_ACCEPTED,
    STATUS_ACCEPTED_HUMAN_REVIEW,
)

DEFAULT_DATA_DIR = pathlib.Path(__file__).resolve().parent / "data"
DEFAULT_PILOT_REPORT_PATH = DEFAULT_DATA_DIR / "pilot_report.json"

# Teacher pricing -- see pilot.py for sourcing; duplicated here (not imported)
# because pilot.py's constants are pilot-report-shaped, not re-exported as a
# generic public API; the two modules independently document the same source.
TEACHER_INPUT_USD_PER_MTOK = 3.00
TEACHER_OUTPUT_USD_PER_MTOK = 7.50

DEFAULT_TARGET_ACCEPTED = 5000
DEFAULT_SEED = 0
DEFAULT_BUDGET_USD = 50.0

# Spec-verbatim exposure-mix target: 20% router / 40% edit / 40% prose, by
# training-token exposure of ACCEPTED completions (last message of each
# accepted example's `messages`) -- never by raw example count.
EXPOSURE_TARGETS = {"router": 0.20, "edit": 0.40, "prose": 0.40}
EXPOSURE_TOLERANCE = 0.05  # +/-5%, per the brief's --verify contract.

# Seed estimates for average accepted-completion token length per axis, used
# ONLY to size the first generation round before any real measurement exists
# (see `_measure_avg_tokens_by_axis`, which recomputes these from real
# accepted examples after every round and drives all subsequent rounds).
# Judgment call (documented, same spirit as gen_prose._LENGTH_CAPS /
# pilot.DEFAULT_AVG_TOKENS_PER_EXAMPLE): router completions are a single
# intent word (very short); edit completions are a small edits-JSON array;
# prose completions are full paragraphs (long).
DEFAULT_AVG_TOKENS_BY_AXIS = {"router": 4, "edit": 100, "prose": 300}

# Documented judgment call: assumed accept rate (accepted / (accepted +
# rejected)) used to size a stratum's requested candidate count `n` before
# any measurement exists for that stratum; refined in-place from real
# accept/reject counts after every generation call for that stratum (see
# `_generate_toward` below). Floored (`MIN_ACCEPT_RATE`) so a stratum that is
# currently accepting nothing doesn't blow up `n` to infinity.
DEFAULT_ASSUMED_ACCEPT_RATE = 0.5
MIN_ACCEPT_RATE = 0.05

# Per-axis cap on the `n` requested in a single generate_* call. Router
# batches all n candidates into ONE synthesis call (cheap to raise); edit and
# prose sample once PER candidate (n calls, plus edit's own retry loop on
# top) so their caps stay much lower to keep any one call bounded.
MAX_CANDIDATES_PER_CALL = {"router": 150, "edit": 40, "prose": 40}

# Coverage-only generation for the 3 edit subtypes with no synthesizable
# known target (gen_edit.FALLBACK_SUBTYPES): with no judge wired (judge=None)
# these never auto-accept (100% of their yield is review-queue or rejected),
# so they contribute nothing to the exposure-mix/target-accepted balancing
# above; with a real judge wired (see main()), a fraction do auto-accept
# (judge-PASS) and DO flow into that balancing, same as any other accepted
# example -- see `_generate_fallback_edit_coverage`. Either way they are
# still generated in a small, fixed, budget-bounded amount, independent of
# the exposure-mix target sizing, so the corpus's review queue has real audit
# material for those subtypes (per the design spec's "known target OR
# validator + independent judge, sampled into human review" split) --
# judgment call, deliberately small to avoid overspending budget on a
# fixed-size coverage pass that isn't driving the main exposure-mix target.
FALLBACK_FAMILIES_PER_SUBTYPE = 2
FALLBACK_N_PER_FAMILY = 5

# Bounded correction loop: after an initial allocation round (sized off
# DEFAULT_AVG_TOKENS_BY_AXIS), re-measure real avg-tokens-per-axis from what
# was actually accepted and, if the realized exposure mix is still outside
# EXPOSURE_TOLERANCE, top up the most-deficient axis and re-measure again.
# Bounded so a persistently-skewed axis (e.g. a kind that's run out of family
# instances) can't spin forever; the manifest records whatever the mix
# actually converged to either way.
MAX_TOPUP_ROUNDS = 4

REQUIRED_GENERATION_KEYS = {
    "teacher_model", "renderer", "bridge_protocol_version", "bridge_js_commit",
    "synthesis_prompt_hash", "judge_prompt_hash",
}
REQUIRED_TRAINING_KEYS = {"student_model", "renderer"}
REQUIRED_PROVENANCE_KEYS = {
    "prompt_id", "production_prompt_content_hash", "production_prompt_git_sha",
    "generation", "training", "status", "reject_reason",
}

ARTIFACT_FILENAMES = {
    "train": "train.jsonl",
    "eval": "eval.jsonl",
    "challenge": "challenge.jsonl",
    "rejects": "rejects.jsonl",
}
REVIEW_QUEUE_FILENAME = "review_queue.jsonl"
DEDUP_LOG_FILENAME = "dedup_log.json"
MANIFEST_FILENAME = "generation_manifest.json"


class BudgetExceeded(RuntimeError):
    """Raised internally when metered spend crosses --budget-usd mid-run.

    Caught by `run_generate`, which then finalizes (dedup + writes partial
    artifacts) with whatever was accumulated so far rather than letting the
    exception escape and lose that work -- see the module docstring's ABORT
    contract.
    """

    def __init__(self, spend_usd, budget_usd):
        super().__init__(
            f"metered spend ${spend_usd:.4f} crossed --budget-usd ${budget_usd:.2f}"
        )
        self.spend_usd = spend_usd
        self.budget_usd = budget_usd


# ---------------------------------------------------------------------------
# Pure math: exposure-mix target-count allocation. No teacher calls, no I/O.
# ---------------------------------------------------------------------------

def target_counts_by_axis(target_accepted, avg_tokens_by_axis, exposure_targets=None):
    """How many ACCEPTED examples per axis ("router"/"edit"/"prose") are
    needed so that (count_axis * avg_tokens_by_axis[axis]) / total_tokens ==
    exposure_targets[axis] for every axis, while sum(count_axis) ==
    target_accepted.

    Derivation: let T be the (unknown) total token budget in
    avg-token-equivalent units. count_axis = exposure_targets[axis] * T /
    avg_tokens_by_axis[axis]. Summing over axes and solving for T against
    target_accepted gives T = target_accepted / sum(exposure_targets[axis] /
    avg_tokens_by_axis[axis]); substituting back gives the closed form below.
    Pure function of its inputs -- no randomness, no teacher calls -- so it's
    exactly reproducible given the same (measured or seed) avg-tokens
    figures, and unit-testable without any teacher/bridge stub.

    Returns a dict axis -> float (NOT rounded to int -- callers round when
    turning this into a generation plan; keeping it exact here lets
    `_measure_avg_tokens_by_axis`-driven correction rounds recompute cleanly
    from real numbers instead of compounding rounding error).
    """
    exposure_targets = exposure_targets or EXPOSURE_TARGETS
    weights = {
        axis: exposure_targets[axis] / avg_tokens_by_axis[axis]
        for axis in exposure_targets
    }
    total_weight = sum(weights.values())
    if total_weight <= 0:
        raise ValueError("target_counts_by_axis: non-positive total weight (bad avg_tokens_by_axis?)")
    total_token_units = target_accepted / total_weight
    return {
        axis: exposure_targets[axis] * total_token_units / avg_tokens_by_axis[axis]
        for axis in exposure_targets
    }


def additional_examples_to_close_ratio_gap(axis_tokens, total_tokens, target_ratio, avg_tokens_for_axis):
    """How many MORE examples of one axis (at `avg_tokens_for_axis` each) are
    needed to move that axis's realized token ratio to exactly
    `target_ratio`, given the CURRENT `axis_tokens` / `total_tokens` (both
    across every axis, already-generated). Used by `run_generate`'s topup
    correction loop -- unlike `target_counts_by_axis` (which solves the
    "starting from zero" allocation problem), this solves "starting from an
    already-imbalanced corpus", which is what every round after the first
    actually faces.

    Solving (axis_tokens + d*avgtok) / (total_tokens + d*avgtok) ==
    target_ratio for d (the additional example count) gives:
        d = (target_ratio * total_tokens - axis_tokens) / (avgtok * (1 - target_ratio))
    Returns 0.0 (never negative, never a ZeroDivisionError) whenever the
    axis is already at or above its target ratio, or when
    `avg_tokens_for_axis` isn't usably positive.
    """
    if avg_tokens_for_axis <= 0 or target_ratio >= 1:
        return 0.0
    numerator = target_ratio * total_tokens - axis_tokens
    denominator = avg_tokens_for_axis * (1 - target_ratio)
    if numerator <= 0 or denominator <= 0:
        return 0.0
    return numerator / denominator


def _distribute_evenly(total, n):
    """Split `total` (rounded to the nearest int) into `n` non-negative ints
    as evenly as possible, deterministic remainder assignment (first `rem`
    slots get one extra), so callers can turn a per-axis float target into
    concrete per-kind integer targets without introducing seed/order-
    dependent nondeterminism.
    """
    total = max(0, int(round(total)))
    if n <= 0:
        return []
    base, rem = divmod(total, n)
    return [base + 1 if i < rem else base for i in range(n)]


def axis_of_task(task):
    """"router" -> "router"; "edit" -> "edit"; "prose:<pipeline>" -> "prose".
    Matches `provenance.make_example`'s `task` values exactly (see
    gen_router/gen_edit/gen_prose's `task=` arguments)."""
    return str(task).split(":", 1)[0]


def _completion_text(example):
    """The training-token-exposure-relevant text of an accepted example:
    its LAST message (the assistant completion the student is trained to
    produce), per the brief's "training-token exposure, computed from
    tokenized completion lengths" -- not the whole conversation (system/user
    context tokens are not what the exposure-mix target is balancing)."""
    messages = example.get("messages") or []
    if not messages:
        return ""
    return str(messages[-1].get("content", ""))


def _dedup_text(example):
    """The diversity-relevant text for the GLOBAL near-duplicate check: the
    USER turn (`messages[1]`), never the completion. Router's completion is
    just the intent label (e.g. every accepted "EDIT_TEKS" example's
    completion is literally the string "EDIT_TEKS") -- deduping on
    completions would flag nearly the entire router corpus as duplicates of
    each other and destroy it. The user turn is what's actually meant to be
    diverse across accepted examples for every axis (router's synthesized
    message, edit's corrupted-source-plus-instruction, prose's
    context/instruction), and it's what `gen_prose.generate_prose`'s own
    per-batch dedup already compares (its `raw` there is the completion, but
    at batch scope that's fine since within one family/pipeline batch the
    user turn is what varies; at GLOBAL scope across every family this
    module compares user turns explicitly instead). Every accepted example
    on every axis has `messages = [system, user, assistant]` (or
    `[system, user] + [assistant]` for prose), so index 1 is always the
    user turn -- see generate_router/generate_edit/generate_prose."""
    messages = example.get("messages") or []
    if len(messages) < 2:
        return _completion_text(example)
    return str(messages[1].get("content", ""))


def _deduped_view(accepted_examples, dedup_threshold):
    """Non-destructive: which of `accepted_examples` would SURVIVE the
    global near-dup filter (see `_dedup_text`) if it ran right now. Used by
    the topup correction loop to measure the exposure mix realistically
    (see its docstring); the actual, destructive removal still only happens
    once, at the very end of `run_generate`."""
    if not accepted_examples:
        return accepted_examples
    texts = [_dedup_text(ex) for ex in accepted_examples]
    dup_indices = near_duplicates(texts, threshold=dedup_threshold)
    if not dup_indices:
        return accepted_examples
    return [ex for i, ex in enumerate(accepted_examples) if i not in dup_indices]


def _measure_avg_tokens_by_axis(accepted_examples, token_counter, fallback=None):
    """Real avg completion-token length per axis from `accepted_examples`.
    Axes with zero accepted examples so far fall back to `fallback[axis]`
    (or DEFAULT_AVG_TOKENS_BY_AXIS) so `target_counts_by_axis` never divides
    by an axis that simply hasn't produced anything yet."""
    fallback = fallback or DEFAULT_AVG_TOKENS_BY_AXIS
    totals = {axis: 0 for axis in EXPOSURE_TARGETS}
    counts = {axis: 0 for axis in EXPOSURE_TARGETS}
    for ex in accepted_examples:
        axis = axis_of_task(ex["task"])
        if axis not in totals:
            continue
        totals[axis] += token_counter(_completion_text(ex))
        counts[axis] += 1
    return {
        axis: (totals[axis] / counts[axis]) if counts[axis] else fallback.get(axis, 1)
        for axis in EXPOSURE_TARGETS
    }


def exposure_mix(accepted_examples, token_counter):
    """Realized token totals + ratios per axis across `accepted_examples`.
    Returns {"tokens": {axis: int}, "ratio": {axis: float}}; ratios are 0.0
    for every axis when there are zero total tokens (never a ZeroDivisionError)."""
    tokens = {axis: 0 for axis in EXPOSURE_TARGETS}
    for ex in accepted_examples:
        axis = axis_of_task(ex["task"])
        if axis in tokens:
            tokens[axis] += token_counter(_completion_text(ex))
    total = sum(tokens.values())
    ratio = {axis: (tokens[axis] / total if total else 0.0) for axis in tokens}
    return {"tokens": tokens, "ratio": ratio}


def exposure_mix_within_tolerance(ratio, exposure_targets=None, tolerance=EXPOSURE_TOLERANCE):
    exposure_targets = exposure_targets or EXPOSURE_TARGETS
    return all(
        abs(ratio.get(axis, 0.0) - target) <= tolerance
        for axis, target in exposure_targets.items()
    )


# ---------------------------------------------------------------------------
# Pilot-informed accept-rate seeding (honors measured retry/acceptance
# rates, per the brief, when a pilot_report.json is available).
# ---------------------------------------------------------------------------

def load_accept_rate_estimates(pilot_report_path):
    """Read a pilot_report.json (as written by pilot.run_pilot) and return
    {stratum_kind: measured_accept_rate}, stratum_kind namespaced exactly
    like families.py kinds ("router:<INTENT>", "edit:<subtype>",
    "prose:<pipeline>") -- pilot.plan_strata() uses the identical namespace,
    so this is a direct lookup key match, no translation needed.

    Missing file / unreadable JSON / missing "strata" key -> {} (caller
    falls back to DEFAULT_ASSUMED_ACCEPT_RATE for every stratum; a missing
    pilot report is not fatal, just means less-informed sizing).
    """
    path = pathlib.Path(pilot_report_path)
    if not path.exists():
        return {}
    try:
        report = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    strata = report.get("strata") or []
    return {s["stratum"]: s["accept_rate"] for s in strata if "stratum" in s and "accept_rate" in s}


# ---------------------------------------------------------------------------
# Provenance augmentation for review-queue entries (closes the Task 7 review's
# deferred provenance finding): review_queue.jsonl entries must carry the
# same prompt_id / production_prompt_content_hash / production_prompt_git_sha
# / generation block an accepted/rejected example would, even though
# `generate_router`/`generate_edit`/`generate_prose` themselves only return
# plain dicts for review-queue items (no provenance -- see their
# docstrings: "plain dicts (no provenance status yet -- pending human
# review)"). Reconstructed here from the exact same inputs those functions
# used to build their own (unreturned) `generation_meta`, so this is a
# faithful record of what actually happened, not a guess.
# ---------------------------------------------------------------------------

def _augment_review_entries(entries, *, prompt_id, content_hash, git_sha, generation_meta):
    return [
        {
            **entry,
            "prompt_id": prompt_id,
            "production_prompt_content_hash": content_hash,
            "production_prompt_git_sha": git_sha,
            "generation": dict(generation_meta),
        }
        for entry in entries
    ]


# ---------------------------------------------------------------------------
# I/O helpers.
# ---------------------------------------------------------------------------

def _write_jsonl(path, items):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def _read_jsonl(path):
    items = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items


def _write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Family pool: every family instance for a kind, split resolved via
# `assign_splits`, sorted by id for deterministic iteration order.
# ---------------------------------------------------------------------------

def _build_family_pool(seed, instances_per_kind=DEFAULT_INSTANCES_PER_KIND):
    families = enumerate_families(instances_per_kind=instances_per_kind)
    assignments = assign_splits(families, seed)
    pool = {}
    for fam in sorted(families, key=lambda f: f["id"]):
        resolved = {**fam, "split": assignments[fam["id"]]}
        pool.setdefault(fam["kind"], []).append(resolved)
    return pool


# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------

def run_generate(
    bridge,
    router_system_prompt,
    edit_system_prompt,
    prose_system_prompts,
    *,
    teacher_sampler,
    cold_sampler=None,
    judge=None,
    judge_prompt_hash=None,
    token_counter=None,
    seed=DEFAULT_SEED,
    target_accepted=DEFAULT_TARGET_ACCEPTED,
    budget_usd=DEFAULT_BUDGET_USD,
    dedup_threshold=DEFAULT_DEDUP_THRESHOLD,
    accept_rate_estimates=None,
    avg_tokens_by_axis=None,
    max_topup_rounds=MAX_TOPUP_ROUNDS,
    fallback_families_per_subtype=FALLBACK_FAMILIES_PER_SUBTYPE,
    fallback_n_per_family=FALLBACK_N_PER_FAMILY,
    data_dir=None,
    bridge_protocol_version=None,
    bridge_js_commit=None,
    production_prompt_content_hashes=None,
    production_prompt_git_sha=None,
):
    """Run the full generation pass and write the four corpus artifacts (+
    review_queue.jsonl, dedup_log.json, generation_manifest.json) to
    `data_dir` (default `tantular/finetune/data/`; pass a falsy value to
    skip writing, matching `pilot.run_pilot`'s `report_path=False` contract
    -- used by tests that only want the returned manifest).

    Returns the manifest dict (also written to `data_dir/generation_manifest.json`
    unless `data_dir` is falsy). Never raises on a mid-run budget abort or on
    unresolved review-queue items -- both are reported via the manifest
    (`manifest["aborted"]`, `manifest["review_queue_unresolved"]`) so callers
    (tests, `main()`) decide what to do; `main()` turns them into a non-zero
    process exit.
    """
    ledger = TeacherSpendLedger()
    counter = token_counter or default_token_counter
    cold_sampler = cold_sampler or teacher_sampler

    metered_teacher = MeteredSampler(
        teacher_sampler, ledger, counter, TEACHER_INPUT_USD_PER_MTOK, TEACHER_OUTPUT_USD_PER_MTOK
    )
    metered_cold = MeteredSampler(
        cold_sampler, ledger, counter, TEACHER_INPUT_USD_PER_MTOK, TEACHER_OUTPUT_USD_PER_MTOK
    )
    metered_judge = (
        MeteredJudge(judge, ledger, counter, TEACHER_INPUT_USD_PER_MTOK, TEACHER_OUTPUT_USD_PER_MTOK)
        if judge is not None
        else None
    )

    content_hashes = production_prompt_content_hashes or {}
    pool = _build_family_pool(seed)

    accept_rate_estimates = dict(accept_rate_estimates or {})
    avg_tokens_by_axis = dict(avg_tokens_by_axis or DEFAULT_AVG_TOKENS_BY_AXIS)

    accepted = []
    rejected = []
    review_queue = []
    stratum_shortfalls = []  # kinds that ran out of family instances before hitting their target
    aborted_reason = None
    stalled_axes = set()  # axes whose exposure-mix gap stopped closing (see the topup loop below)

    # Per-kind cursor into its family pool, shared across the initial pass
    # and every top-up round, so top-ups advance to fresh family instances
    # instead of hammering the same one repeatedly.
    cursor = {kind: 0 for kind in pool}

    def _check_budget():
        if ledger.cost_usd > budget_usd:
            raise BudgetExceeded(ledger.cost_usd, budget_usd)

    def _next_family(kind):
        families = pool.get(kind, [])
        i = cursor.get(kind, 0)
        if i >= len(families):
            return None
        cursor[kind] = i + 1
        return families[i]

    def _router_generation_meta():
        return {
            "teacher_model": ROUTER_TEACHER_MODEL,
            "renderer": ROUTER_TEACHER_RENDERER,
            "bridge_protocol_version": bridge_protocol_version,
            "bridge_js_commit": bridge_js_commit,
            "synthesis_prompt_hash": ROUTER_SYNTHESIS_PROMPT_HASH,
            "judge_prompt_hash": ROUTER_COLD_PROMPT_HASH,
        }

    def _edit_generation_meta():
        return {
            "teacher_model": EDIT_TEACHER_MODEL,
            "renderer": EDIT_TEACHER_RENDERER,
            "bridge_protocol_version": bridge_protocol_version,
            "bridge_js_commit": bridge_js_commit,
            "synthesis_prompt_hash": EDIT_SYNTHESIS_PROMPT_HASH,
            # Real hash when a judge is wired (e.g. `judge.JUDGE_PROMPT_HASH`
            # for `judge.TinkerEditJudge`, threaded in by `main()`); None
            # (matching the spec's "...|null") when `judge_prompt_hash` isn't
            # supplied -- e.g. no judge wired, or a judge whose prompt hash
            # isn't known here.
            "judge_prompt_hash": judge_prompt_hash,
        }

    def _prose_generation_meta():
        return {
            "teacher_model": PROSE_TEACHER_MODEL,
            "renderer": PROSE_TEACHER_RENDERER,
            "bridge_protocol_version": bridge_protocol_version,
            "bridge_js_commit": bridge_js_commit,
            "synthesis_prompt_hash": PROSE_SYNTHESIS_PROMPT_HASH,
            "judge_prompt_hash": PROSE_JUDGE_PROMPT_HASH,
        }

    def _call_router(family, n):
        a, r, rq = generate_router(
            metered_teacher, family, n, router_system_prompt,
            cold_sampler=metered_cold,
            bridge_protocol_version=bridge_protocol_version,
            bridge_js_commit=bridge_js_commit,
            production_prompt_content_hash=content_hashes.get("router"),
            production_prompt_git_sha=production_prompt_git_sha,
        )
        rq = _augment_review_entries(
            rq, prompt_id="router", content_hash=content_hashes.get("router"),
            git_sha=production_prompt_git_sha, generation_meta=_router_generation_meta(),
        )
        return a, r, rq

    def _call_edit(family, n):
        a, r, rq = generate_edit(
            metered_teacher, bridge, family, n, edit_system_prompt,
            judge=metered_judge,
            judge_prompt_hash=judge_prompt_hash,
            bridge_protocol_version=bridge_protocol_version,
            bridge_js_commit=bridge_js_commit,
            production_prompt_content_hash=content_hashes.get("edit"),
            production_prompt_git_sha=production_prompt_git_sha,
        )
        rq = _augment_review_entries(
            rq, prompt_id="edit", content_hash=content_hashes.get("edit"),
            git_sha=production_prompt_git_sha, generation_meta=_edit_generation_meta(),
        )
        return a, r, rq

    def _call_prose(pipeline_kind):
        # Lazy lookup (not resolved until actually invoked with a real
        # family): `call_fn_by_axis_kind` builds one closure per PROSE_PIPELINES
        # kind unconditionally, but a kind with a zero target (e.g. a tiny
        # `--target-accepted`, or a caller that only supplied a subset of
        # `prose_system_prompts`) should never actually need its prompt
        # content -- eager lookup here would KeyError at closure-construction
        # time even for kinds `_generate_toward` never calls into.
        def _call(family, n):
            prompt_content = prose_system_prompts[pipeline_kind.split(":", 1)[1]]
            a, r, rq = generate_prose(
                metered_teacher, family, n, prompt_content,
                dedup_threshold=dedup_threshold,
                bridge_protocol_version=bridge_protocol_version,
                bridge_js_commit=bridge_js_commit,
                production_prompt_content_hash=content_hashes.get(pipeline_kind),
                production_prompt_git_sha=production_prompt_git_sha,
            )
            rq = _augment_review_entries(
                rq, prompt_id=pipeline_kind, content_hash=content_hashes.get(pipeline_kind),
                git_sha=production_prompt_git_sha, generation_meta=_prose_generation_meta(),
            )
            return a, r, rq

        return _call

    call_fn_by_axis_kind = {}
    for intent in ROUTER_INTENTS:
        call_fn_by_axis_kind[f"router:{intent}"] = ("router", _call_router)
    for subtype in SYNTHESIZABLE_SUBTYPES:
        call_fn_by_axis_kind[f"edit:{subtype}"] = ("edit", _call_edit)
    for pipeline in PROSE_PIPELINES:
        kind = f"prose:{pipeline}"
        call_fn_by_axis_kind[kind] = ("prose", _call_prose(kind))

    def _generate_toward(kind, axis, need):
        """Generate against successive family instances of `kind` until
        `need` more accepted examples exist for this kind (or the family
        pool for this kind is exhausted, or the budget is blown -- the
        latter propagates as BudgetExceeded, caught by the caller)."""
        axis_name, call_fn = call_fn_by_axis_kind[kind]
        got = 0
        cap = MAX_CANDIDATES_PER_CALL[axis_name]
        while got < need:
            family = _next_family(kind)
            if family is None:
                stratum_shortfalls.append({"kind": kind, "still_needed": need - got})
                return got
            rate = max(accept_rate_estimates.get(kind, DEFAULT_ASSUMED_ACCEPT_RATE), MIN_ACCEPT_RATE)
            n = min(cap, max(1, math.ceil((need - got) / rate)))
            a, r, rq = call_fn(family, n)
            _check_budget()
            accepted.extend(a)
            rejected.extend(r)
            review_queue.extend(rq)
            got += len(a)
            decided = len(a) + len(r)
            if decided:
                accept_rate_estimates[kind] = len(a) / decided
        return got

    def _generate_fallback_edit_coverage():
        for subtype in FALLBACK_SUBTYPES:
            kind = f"edit:{subtype}"
            families = pool.get(kind, [])[:fallback_families_per_subtype]
            for family in families:
                a, r, rq = _call_edit(family, fallback_n_per_family)
                _check_budget()
                # Empty when judge=None (degraded mode: every validator-
                # cleared candidate is queued for review, never accepted).
                # With a real judge wired (see main()), judge-PASS candidates
                # land here too -- genuinely accepted training examples, so
                # they flow into the same exposure-mix/dedup/split accounting
                # as every other accepted example below, not held out of it.
                accepted.extend(a)
                rejected.extend(r)
                review_queue.extend(rq)

    try:
        # Round 0: seed-estimate-sized allocation.
        axis_targets = target_counts_by_axis(target_accepted, avg_tokens_by_axis)
        kind_targets = {}
        for axis, kinds in (
            ("router", [f"router:{i}" for i in ROUTER_INTENTS]),
            ("edit", [f"edit:{s}" for s in SYNTHESIZABLE_SUBTYPES]),
            ("prose", [f"prose:{p}" for p in PROSE_PIPELINES]),
        ):
            for kind, n in zip(kinds, _distribute_evenly(axis_targets[axis], len(kinds))):
                kind_targets[kind] = n

        for kind, target_n in kind_targets.items():
            axis = call_fn_by_axis_kind[kind][0]
            _generate_toward(kind, axis, max(0, target_n))

        _generate_fallback_edit_coverage()

        # Correction rounds: re-measure real avg-tokens-per-axis from what
        # was actually accepted, recompute the ideal split, and top up
        # whichever axis is furthest short -- bounded by MAX_TOPUP_ROUNDS.
        #
        # Measured against a DEDUPED VIEW of `accepted` (never mutating
        # `accepted` itself -- the real, destructive dedup pass still runs
        # exactly once at the very end): the actual global near-dup filter
        # only runs after all generation finishes, but different axes hit it
        # very differently hard (edit's corruption corpus is a handful of
        # canonical target sentences -- see gen_edit._TARGETS -- so it
        # saturates the dedup filter fast; router/prose have much more
        # lexical headroom). Measuring against raw (non-deduped) `accepted`
        # would make every round think an axis heavy on near-duplicates is
        # already at/over its target, permanently masking a deficit dedup is
        # about to reveal, and the loop would converge to the wrong mix.
        #
        # `stalled_axes`: an axis whose ratio gap doesn't actually shrink
        # after a top-up round (e.g. gen_edit.py's SYNTHESIZABLE_SUBTYPES
        # draw from a small fixed bank of ~5 canonical target sentences --
        # `gen_edit._TARGETS` -- so once its achievable near-dup-free
        # examples are exhausted, every further candidate is just another
        # near-duplicate that the global dedup filter removes right back
        # out) is excluded from `worst_axis` selection for the rest of the
        # run, so the loop moves on to axes it can actually still improve
        # instead of burning every remaining round on a stuck one. Recorded
        # in the manifest (`exposure_mix.stalled_axes`) so a persistently
        # un-closable gap is visible, not silently accepted.
        for _round in range(max_topup_rounds):
            deduped_view = _deduped_view(accepted, dedup_threshold)
            measured = _measure_avg_tokens_by_axis(deduped_view, counter, fallback=avg_tokens_by_axis)
            mix = exposure_mix(deduped_view, counter)
            if exposure_mix_within_tolerance(mix["ratio"]):
                break
            # Deliberately gap-driven off the REALIZED ratio (not a fixed
            # "ideal count" computed against `target_accepted`): round 0
            # commonly already over- or under-shoots every axis by a
            # different amount (it sizes `n` off an ASSUMED accept rate that
            # is usually wrong in either direction, and it can't ask for
            # fewer than a whole call's worth of candidates), so by the time
            # a correction round runs, total accepted may already be above
            # or below `target_accepted` -- comparing against a fixed
            # target-derived "ideal count" per axis breaks down once that's
            # true (every axis can look "already over" by count while the
            # TOKEN ratio is still off, because the axes overshot by
            # different amounts). Comparing ratios directly, and solving for
            # exactly how many more examples of the worst axis would close
            # that ratio gap (`additional_examples_to_close_ratio_gap`),
            # stays correct regardless of how round 0 landed.
            candidates = {a: g for a, g in (
                (axis, EXPOSURE_TARGETS[axis] - mix["ratio"][axis]) for axis in EXPOSURE_TARGETS
            ) if a not in stalled_axes}
            if not candidates:
                break  # every axis is either satisfied or has stalled -- nothing left to try
            worst_axis = max(candidates, key=lambda a: candidates[a])
            gap_before = candidates[worst_axis]
            if gap_before <= 0:
                break  # every remaining (non-stalled) axis at/above its target ratio
            top_up_total = additional_examples_to_close_ratio_gap(
                mix["tokens"][worst_axis], sum(mix["tokens"].values()),
                EXPOSURE_TARGETS[worst_axis], measured[worst_axis],
            )
            top_up_total = max(1, math.ceil(top_up_total))
            axis_kinds = [k for k, (a, _) in call_fn_by_axis_kind.items() if a == worst_axis]
            per_kind = _distribute_evenly(top_up_total, len(axis_kinds))
            for kind, n in zip(axis_kinds, per_kind):
                if n <= 0:
                    continue
                _generate_toward(kind, worst_axis, n)

            after_view = _deduped_view(accepted, dedup_threshold)
            after_ratio = exposure_mix(after_view, counter)["ratio"][worst_axis]
            gap_after = EXPOSURE_TARGETS[worst_axis] - after_ratio
            if gap_after >= gap_before - 1e-9:
                stalled_axes.add(worst_axis)
    except BudgetExceeded as exc:
        aborted_reason = str(exc)

    # -------------------------------------------------------------------
    # Global near-duplicate filter across every accepted example, per the
    # brief -- NOT the per-batch dedup gen_prose.generate_prose already runs
    # (that only compares within one family's candidate batch). Duplicates
    # are demoted to rejected (never silently vanish), so rejects.jsonl is
    # a complete audit trail of "everything that didn't make the cut and
    # why", including post-hoc dedup removals.
    # -------------------------------------------------------------------
    dedup_log = []
    if accepted:
        texts = [_dedup_text(ex) for ex in accepted]
        dup_indices = near_duplicates(texts, threshold=dedup_threshold)
        if dup_indices:
            kept = []
            for i, ex in enumerate(accepted):
                if i in dup_indices:
                    dedup_log.append({
                        "id": ex["id"], "task": ex["task"], "family": ex["family"], "split": ex["split"],
                    })
                    demoted = dict(ex)
                    demoted["provenance"] = {**ex["provenance"], "status": "rejected", "reject_reason": "near_duplicate_global"}
                    rejected.append(demoted)
                else:
                    kept.append(ex)
            accepted = kept

    by_split = {"train": [], "eval": [], "challenge": []}
    for ex in accepted:
        by_split.setdefault(ex["split"], []).append(ex)

    final_mix = exposure_mix(accepted, counter)

    manifest = {
        "seed": seed,
        "target_accepted": target_accepted,
        "budget_usd": budget_usd,
        "dedup_threshold": dedup_threshold,
        "counts": {
            "accepted_total": len(accepted),
            "accepted_by_split": {k: len(v) for k, v in by_split.items()},
            "accepted_by_axis": {
                axis: sum(1 for ex in accepted if axis_of_task(ex["task"]) == axis)
                for axis in EXPOSURE_TARGETS
            },
            "rejected_total": len(rejected),
            "review_queue_total": len(review_queue),
        },
        "exposure_mix": {
            "target": EXPOSURE_TARGETS,
            "tolerance": EXPOSURE_TOLERANCE,
            "tokens": final_mix["tokens"],
            "ratio": final_mix["ratio"],
            "within_tolerance": exposure_mix_within_tolerance(final_mix["ratio"]),
            "stalled_axes": sorted(stalled_axes),
        },
        "dedup": {"removed": len(dedup_log), "log_file": DEDUP_LOG_FILENAME},
        "stratum_shortfalls": stratum_shortfalls,
        "spend": ledger.as_dict(),
        "aborted": aborted_reason is not None,
        "abort_reason": aborted_reason,
        "review_queue_unresolved": len(review_queue) > 0,
        "review_queue_note": (
            "Review-queue promotion CLI is out of scope for this task (Task 11); "
            "these items are the promotion path deferred from the Task 7 review's "
            "provenance finding. Resolve via a future human-review/promotion tool "
            "before treating this corpus as final."
        ),
    }

    if data_dir is None:
        data_dir = DEFAULT_DATA_DIR
    if data_dir:
        data_dir = pathlib.Path(data_dir)
        _write_jsonl(data_dir / ARTIFACT_FILENAMES["train"], by_split["train"])
        _write_jsonl(data_dir / ARTIFACT_FILENAMES["eval"], by_split["eval"])
        _write_jsonl(data_dir / ARTIFACT_FILENAMES["challenge"], by_split["challenge"])
        _write_jsonl(data_dir / ARTIFACT_FILENAMES["rejects"], rejected)
        _write_jsonl(data_dir / REVIEW_QUEUE_FILENAME, review_queue)
        _write_json(data_dir / DEDUP_LOG_FILENAME, dedup_log)
        _write_json(data_dir / MANIFEST_FILENAME, manifest)

    return manifest


# ---------------------------------------------------------------------------
# --verify: integrity checks against the artifacts already on disk in
# `data_dir`. No teacher calls, no generation -- pure file-reading + assertion.
# ---------------------------------------------------------------------------

class VerifyError(RuntimeError):
    pass


def verify_artifacts(data_dir, exposure_tolerance=EXPOSURE_TOLERANCE):
    """Assert the four artifacts + manifest in `data_dir` satisfy the
    brief's Step 2 contract:
    - no family_id appears in more than one of train/eval/challenge
    - every accepted example has full provenance (generation + training
      blocks, bridge fields present)
    - the exposure mix recorded in generation_manifest.json is within
      +/-`exposure_tolerance` of EXPOSURE_TARGETS

    Raises VerifyError with every violation found (not just the first) on
    failure; returns True on success.
    """
    data_dir = pathlib.Path(data_dir)
    problems = []

    splits = {}
    for split_name in ("train", "eval", "challenge"):
        path = data_dir / ARTIFACT_FILENAMES[split_name]
        if not path.exists():
            problems.append(f"missing artifact: {path}")
            splits[split_name] = []
            continue
        splits[split_name] = _read_jsonl(path)

    rejects_path = data_dir / ARTIFACT_FILENAMES["rejects"]
    if not rejects_path.exists():
        problems.append(f"missing artifact: {rejects_path}")

    manifest_path = data_dir / MANIFEST_FILENAME
    if not manifest_path.exists():
        problems.append(f"missing manifest: {manifest_path}")
        manifest = None
    else:
        manifest = json.loads(manifest_path.read_text())

    # Family/split disjointness across the three accepted-example artifacts.
    family_to_splits = {}
    for split_name, examples in splits.items():
        for ex in examples:
            family_to_splits.setdefault(ex.get("family"), set()).add(split_name)
    for family_id, split_names in family_to_splits.items():
        if len(split_names) > 1:
            problems.append(
                f"family {family_id!r} appears in more than one split: {sorted(split_names)}"
            )

    # Full provenance on every accepted example.
    for split_name, examples in splits.items():
        for ex in examples:
            provenance = ex.get("provenance") or {}
            missing = REQUIRED_PROVENANCE_KEYS - set(provenance.keys())
            if missing:
                problems.append(
                    f"{split_name}: example {ex.get('id')} missing provenance keys {sorted(missing)}"
                )
                continue
            gen_missing = REQUIRED_GENERATION_KEYS - set((provenance.get("generation") or {}).keys())
            if gen_missing:
                problems.append(
                    f"{split_name}: example {ex.get('id')} missing generation keys {sorted(gen_missing)}"
                )
            train_missing = REQUIRED_TRAINING_KEYS - set((provenance.get("training") or {}).keys())
            if train_missing:
                problems.append(
                    f"{split_name}: example {ex.get('id')} missing training keys {sorted(train_missing)}"
                )
            # STATUS_ACCEPTED_HUMAN_REVIEW is the review-queue promotion
            # CLI's status for a human-accepted item (tantular.finetune.
            # review_promote) -- schema-identical to a directly-generated
            # accepted example (see reconstruct_example), so it belongs in
            # train/eval/challenge exactly like STATUS_ACCEPTED and must not
            # fail verification just for recording *how* it was accepted.
            if provenance.get("status") not in (STATUS_ACCEPTED, STATUS_ACCEPTED_HUMAN_REVIEW):
                problems.append(
                    f"{split_name}: example {ex.get('id')} has status {provenance.get('status')!r}, "
                    f"expected {STATUS_ACCEPTED!r} or {STATUS_ACCEPTED_HUMAN_REVIEW!r}"
                )

    # Exposure mix within tolerance, read from the manifest this run wrote.
    if manifest is not None:
        ratio = ((manifest.get("exposure_mix") or {}).get("ratio")) or {}
        if not exposure_mix_within_tolerance(ratio, tolerance=exposure_tolerance):
            problems.append(
                f"exposure mix {ratio} outside +/-{exposure_tolerance:.0%} of {EXPOSURE_TARGETS}"
            )

    if problems:
        raise VerifyError("\n".join(problems))
    return True


# ---------------------------------------------------------------------------
# Live CLI: `python -m tantular.finetune.generate`. Never imported/executed
# by pytest -- requires TINKER_API_KEY and spends real Tinker money (except
# `--verify`, which never touches Tinker).
# ---------------------------------------------------------------------------

def _build_arg_parser():
    parser = argparse.ArgumentParser(prog="tantular.finetune.generate")
    parser.add_argument("--target-accepted", type=int, default=DEFAULT_TARGET_ACCEPTED)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--budget-usd", type=float, default=DEFAULT_BUDGET_USD)
    parser.add_argument("--dedup-threshold", type=float, default=DEFAULT_DEDUP_THRESHOLD)
    parser.add_argument("--data-dir", type=str, default=str(DEFAULT_DATA_DIR))
    parser.add_argument("--pilot-report", type=str, default=str(DEFAULT_PILOT_REPORT_PATH))
    parser.add_argument("--verify", action="store_true", help="verify existing artifacts in --data-dir; no generation")
    return parser


def main(argv=None):
    args = _build_arg_parser().parse_args(argv)

    if args.verify:
        try:
            verify_artifacts(args.data_dir)
        except VerifyError as exc:
            print(f"VERIFY FAILED:\n{exc}", file=sys.stderr)
            return 1
        print("VERIFY OK")
        return 0

    _require_tinker_api_key()

    # Lazy imports: only the live generation path touches Tinker or spawns
    # the bridge subprocess -- importing this module never does.
    from tantular.finetune.bridge_client import BridgeClient
    from tantular.finetune.gen_edit import TinkerEditTeacher
    from tantular.finetune.gen_prose import TinkerProseTeacher
    from tantular.finetune.gen_router import TinkerRouterTeacher
    from tantular.finetune.judge import JUDGE_PROMPT_HASH, TinkerEditJudge
    from tantular.finetune.pilot import _MultiAxisTeacher

    bridge = BridgeClient(str(BRIDGE_PATH))
    try:
        prompts = {p["id"]: p for p in bridge.dump_prompts()}
        router_system_prompt = prompts["router"]["content"]
        edit_system_prompt = prompts["edit"]["content"]
        prose_system_prompts = {
            pid.split(":", 1)[1]: p["content"]
            for pid, p in prompts.items()
            if pid.startswith("prose:")
        }
        production_prompt_content_hashes = {pid: p["contentHash"] for pid, p in prompts.items()}
        production_prompt_git_sha = bridge.ready.get("js_commit")
        bridge_protocol_version = bridge.ready.get("protocol_version")

        teacher = _MultiAxisTeacher(
            router_teacher=TinkerRouterTeacher(),
            edit_teacher=TinkerEditTeacher(),
            prose_teacher=TinkerProseTeacher(),
        )
        cold_teacher = TinkerRouterTeacher()

        # Teacher-as-judge for gen_edit's FALLBACK_SUBTYPES -- same
        # tantular/finetune/judge.py wiring as pilot.py's main().
        judge = TinkerEditJudge()

        token_counter = _tinker_tokenizer_token_counter()
        accept_rate_estimates = load_accept_rate_estimates(args.pilot_report)

        manifest = run_generate(
            bridge,
            router_system_prompt,
            edit_system_prompt,
            prose_system_prompts,
            teacher_sampler=teacher,
            cold_sampler=cold_teacher,
            judge=judge,
            judge_prompt_hash=JUDGE_PROMPT_HASH,
            token_counter=token_counter,
            seed=args.seed,
            target_accepted=args.target_accepted,
            budget_usd=args.budget_usd,
            dedup_threshold=args.dedup_threshold,
            accept_rate_estimates=accept_rate_estimates,
            data_dir=args.data_dir,
            bridge_protocol_version=bridge_protocol_version,
            bridge_js_commit=production_prompt_git_sha,
            production_prompt_content_hashes=production_prompt_content_hashes,
            production_prompt_git_sha=production_prompt_git_sha,
        )
    finally:
        bridge.close()

    print(json.dumps({
        "counts": manifest["counts"],
        "exposure_mix": manifest["exposure_mix"],
        "spend": manifest["spend"],
        "aborted": manifest["aborted"],
        "abort_reason": manifest["abort_reason"],
        "review_queue_unresolved": manifest["review_queue_unresolved"],
    }, indent=2))

    if manifest["aborted"]:
        print(f"ABORTED: {manifest['abort_reason']}", file=sys.stderr)
        return 1
    if manifest["review_queue_unresolved"]:
        print(f"STOP: {manifest['review_queue_note']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

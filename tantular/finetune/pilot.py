"""Task 10: stratified pilot harness + cost-per-accepted-example model.

Per the fine-tune design spec, before committing to the full ~5000-accepted
corpus run, a small stratified pilot (~240 examples across every router
intent, every edit subtype, and every prose pipeline) is generated for real
through the same generators (`gen_router.generate_router`,
`gen_edit.generate_edit`, `gen_prose.generate_prose`) used by the full run,
so the cost-per-accepted-example figure is measured, not guessed, before
projecting and gating the full run against a hard budget ceiling.

Cost model (spec-verbatim): "Cost is modeled as cost per *accepted* example
-- it must include everything the accepted example consumed: rejected
attempts, retries, cold re-classification passes, judge calls, plus
amortized export-spike, training, and evaluation." This module achieves that
by metering EVERY call through the injected teacher/cold/judge samplers
(`MeteredSampler` / `MeteredJudge`, sharing one `TeacherSpendLedger`) rather
than trying to reconstruct spend after the fact from accepted-example counts
alone -- retries and rejects call `.sample()` too, and are captured for free.

This module never calls Tinker at import time. `run_pilot`'s `teacher_sampler`
/ `cold_sampler` / `judge` are always injected; tests only ever pass
deterministic stubs. The real Tinker-backed path lives only in `main()`
(`python -m tantular.finetune.pilot`), which is exercised only manually (it
requires TINKER_API_KEY and spends real money) -- never by pytest.
"""

import json
import os
import pathlib
import sys

from tantular.finetune.families import (
    DEFAULT_INSTANCES_PER_KIND,
    EDIT_SUBTYPES,
    PROSE_PIPELINES,
    ROUTER_INTENTS,
    assign_splits,
    enumerate_families,
)
from tantular.finetune.gen_edit import generate_edit
from tantular.finetune.gen_prose import generate_prose
from tantular.finetune.gen_router import generate_router

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
BRIDGE_PATH = REPO_ROOT / "tantular_office_addin/tools/finetune/bridge.mjs"
DEFAULT_REPORT_PATH = pathlib.Path(__file__).resolve().parent / "data" / "pilot_report.json"

# ---------------------------------------------------------------------------
# Stratified pilot plan.
# ---------------------------------------------------------------------------
# Per-stratum minimums (judgment call, documented, same spirit as
# families.EDIT_SUBTYPES / gen_edit._TARGETS: no canonical pilot-size list
# exists elsewhere in the repo). Chosen so every axis clears a "did this
# stratum even produce anything" floor while the total lands at exactly the
# brief's ~240 example pilot size: 8 router intents x10 + 6 edit subtypes x15
# + 7 prose pipelines x10 = 80 + 90 + 70 = 240. Edit strata get a higher
# floor because 3 of the 6 subtypes (FALLBACK_SUBTYPES in gen_edit.py) never
# auto-accept -- their whole yield lands in the review queue -- so the
# accepted-example floor per synthesizable subtype needs headroom against
# rejection/retry exhaustion too.
ROUTER_STRATUM_MIN = 10
EDIT_STRATUM_MIN = 15
PROSE_STRATUM_MIN = 10


def plan_strata():
    """Return the pilot's stratified generation plan: a list of
    (stratum, target_n) pairs, `stratum` namespaced exactly like
    `families.py` family kinds ("router:<INTENT>", "edit:<subtype>",
    "prose:<pipeline>") so it can be used directly as a family-kind lookup
    key. Covers every router intent, every edit subtype, and every prose
    pipeline at least once, summing to >= 240.
    """
    strata = []
    strata.extend((f"router:{intent}", ROUTER_STRATUM_MIN) for intent in ROUTER_INTENTS)
    strata.extend((f"edit:{subtype}", EDIT_STRATUM_MIN) for subtype in EDIT_SUBTYPES)
    strata.extend((f"prose:{pipeline}", PROSE_STRATUM_MIN) for pipeline in PROSE_PIPELINES)
    return strata


# ---------------------------------------------------------------------------
# Pricing constants.
#
# Source: Tinker pricing page (https://tinker-docs.thinkingmachines.ai/pricing
# -- "Sampling" and "Training" tables), USD per million tokens (Mtok), as
# read at the time this module was written (2026-08). Update these constants
# in one place if Tinker's published pricing changes; every cost figure in
# this module derives from them.
# ---------------------------------------------------------------------------

# Teacher: Qwen/Qwen3.5-397B-A17B (same model as gen_router/gen_edit/
# gen_prose TEACHER_MODEL) -- used for synthesis, cold re-classification, and
# judge calls.
TEACHER_INPUT_USD_PER_MTOK = 3.00
TEACHER_OUTPUT_USD_PER_MTOK = 7.50

# Student: Qwen/Qwen3-8B (same model as gen_router/gen_edit/gen_prose
# STUDENT_MODEL) -- used only for the amortized training/eval cost estimate
# (the pilot itself never trains or samples the student).
STUDENT_INPUT_USD_PER_MTOK = 0.195
STUDENT_OUTPUT_USD_PER_MTOK = 0.60
STUDENT_TRAINING_USD_PER_MTOK = 0.44

# Stop-rule ceiling (task brief, spec-verbatim): report must flag
# `over_budget: true` if the projected full-run cost exceeds this.
OVER_BUDGET_CEILING_USD = 50.0

# Amortized export-spike figure: a parameterized input (see module docstring
# / task brief: "Amortized figure: parameterized input"), never silently
# baked in. Default is 0.0 -- the sentinel export spike
# (tantular/finetune/spike/) is a one-time, already-sunk cost as of this
# task; callers projecting a run that must ALSO re-pay for a fresh spike
# should pass an explicit `amortized_export_spike_usd` override.
DEFAULT_AMORTIZED_EXPORT_SPIKE_USD = 0.0

# Training/eval token-cost estimate defaults (judgment call, documented, same
# spirit as gen_prose._LENGTH_CAPS): a rough per-example token budget and
# epoch count, used only to produce an explicit, overridable estimate of the
# amortized training+eval spend to add on top of measured generation cost.
DEFAULT_AVG_TOKENS_PER_EXAMPLE = 400
DEFAULT_TRAIN_EPOCHS = 3
DEFAULT_EVAL_FRACTION = 0.1  # eval set size as a fraction of target_accepted


def estimate_training_eval_usd(
    target_accepted,
    *,
    avg_tokens_per_example=DEFAULT_AVG_TOKENS_PER_EXAMPLE,
    train_epochs=DEFAULT_TRAIN_EPOCHS,
    eval_fraction=DEFAULT_EVAL_FRACTION,
):
    """Explicit, overridable estimate of the amortized student
    training+eval token cost for a `target_accepted`-example full run.

    Training: `target_accepted * avg_tokens_per_example * train_epochs`
    tokens billed at `STUDENT_TRAINING_USD_PER_MTOK`.
    Eval: `target_accepted * eval_fraction` held-out examples, sampled once
    (input+output) at student sampling prices.

    Every assumption is a named, overridable keyword argument -- nothing here
    is silently hardcoded into the returned total.
    """
    train_tokens = target_accepted * avg_tokens_per_example * train_epochs
    training_usd = (train_tokens / 1_000_000) * STUDENT_TRAINING_USD_PER_MTOK

    eval_examples = target_accepted * eval_fraction
    eval_tokens = eval_examples * avg_tokens_per_example
    eval_usd = (eval_tokens / 1_000_000) * (STUDENT_INPUT_USD_PER_MTOK + STUDENT_OUTPUT_USD_PER_MTOK)

    return {
        "training_usd": training_usd,
        "eval_usd": eval_usd,
        "total_usd": training_usd + eval_usd,
        "assumptions": {
            "avg_tokens_per_example": avg_tokens_per_example,
            "train_epochs": train_epochs,
            "eval_fraction": eval_fraction,
        },
    }


# ---------------------------------------------------------------------------
# Cost-per-accepted / projection (pure math, step-1-tested).
# ---------------------------------------------------------------------------

def cost_per_accepted(spend, accepted_count):
    """Total spend (ALL categories: synthesis + rejects/retries + cold
    reclassification + judge calls) divided by accepted-example count.

    Returns float("inf") for accepted_count <= 0 (nothing accepted -> cost
    per accepted example is undefined/unbounded, never a ZeroDivisionError).
    """
    if accepted_count <= 0:
        return float("inf")
    return spend / accepted_count


def project_full_run(cost_per_accepted_value, target_accepted):
    """Linear projection: measured cost-per-accepted x target corpus size.

    This is the pure scaling figure the caller compares to a ceiling (task
    brief, Step 1 test) -- it does NOT include amortized export-spike/
    training/eval costs; see `projected_full_run_usd` for the full figure
    `run_pilot` actually gates on.
    """
    return cost_per_accepted_value * target_accepted


def projected_full_run_usd(
    cost_per_accepted_value,
    target_accepted=5000,
    *,
    amortized_export_spike_usd=DEFAULT_AMORTIZED_EXPORT_SPIKE_USD,
    training_eval_usd_estimate=None,
    over_budget_ceiling_usd=OVER_BUDGET_CEILING_USD,
):
    """Full projected-full-run cost breakdown: measured generation cost
    (scaled via `project_full_run`) + amortized export-spike cost + an
    estimated training/eval token cost -- everything the spec requires the
    cost-per-accepted model to include, projected to `target_accepted`.

    `training_eval_usd_estimate`: pass an explicit override, or leave None to
    use `estimate_training_eval_usd(target_accepted)` with its documented
    defaults (both are overridable -- see that function).

    Returns a dict with the full breakdown plus `over_budget`: True iff
    `total_usd > over_budget_ceiling_usd` (stop rule, task brief-verbatim:
    "report must flag over_budget: true if projection > $50").
    """
    generation_usd = project_full_run(cost_per_accepted_value, target_accepted)

    if training_eval_usd_estimate is None:
        training_eval_usd_estimate = estimate_training_eval_usd(target_accepted)["total_usd"]

    total_usd = generation_usd + amortized_export_spike_usd + training_eval_usd_estimate

    return {
        "target_accepted": target_accepted,
        "generation_usd": generation_usd,
        "amortized_export_spike_usd": amortized_export_spike_usd,
        "training_eval_usd_estimate": training_eval_usd_estimate,
        "total_usd": total_usd,
        "over_budget_ceiling_usd": over_budget_ceiling_usd,
        "over_budget": total_usd > over_budget_ceiling_usd,
    }


# ---------------------------------------------------------------------------
# Teacher-spend metering: wraps injected samplers/judges so EVERY call --
# synthesis, rejected/retried candidates, cold re-classification, judge
# calls -- is counted, never just the accepted examples. Shared across
# `run_pilot`'s router/edit/prose generation calls via one `TeacherSpendLedger`.
# ---------------------------------------------------------------------------

class TeacherSpendLedger:
    """Accumulates call count, input/output token counts, and USD cost
    across every metered sampler/judge call in one pilot run."""

    def __init__(self):
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0

    def record(self, input_tokens, output_tokens, cost_usd):
        self.calls += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cost_usd += cost_usd

    def as_dict(self):
        return {
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
        }


def default_token_counter(text):
    """Fallback token-count APPROXIMATION (~4 chars/token, a common rough
    estimate for English/Indonesian-ish text), used only when the caller
    doesn't supply a real tokenizer-based counter. `main()`'s live Tinker
    path always supplies a real tokenizer-based counter instead (see
    `_tinker_tokenizer_token_counter`) -- per the task brief: "count via the
    tokenizer" when the SDK doesn't directly expose token counts.
    """
    text = str(text or "")
    if not text:
        return 0
    return max(1, len(text) // 4)


def _messages_text(messages):
    return "\n".join(str(m.get("content", "")) for m in messages)


class MeteredSampler:
    """Wraps a `.sample(messages) -> str` teacher client, metering every
    call -- including every retry and every cold-reclassification call --
    into a shared `TeacherSpendLedger`, priced at `input_usd_per_mtok` /
    `output_usd_per_mtok` per million tokens via `token_counter`.
    """

    def __init__(self, sampler, ledger, token_counter, input_usd_per_mtok, output_usd_per_mtok):
        self._sampler = sampler
        self._ledger = ledger
        self._token_counter = token_counter
        self._input_price = input_usd_per_mtok
        self._output_price = output_usd_per_mtok

    def sample(self, messages):
        output = self._sampler.sample(messages)
        input_tokens = self._token_counter(_messages_text(messages))
        output_tokens = self._token_counter(str(output or ""))
        cost = (input_tokens / 1_000_000) * self._input_price + (
            output_tokens / 1_000_000
        ) * self._output_price
        self._ledger.record(input_tokens, output_tokens, cost)
        return output


class MeteredJudge:
    """Wraps a `judge(source_text, instruction, produced_text) -> Any`
    callable (gen_edit.generate_edit's `judge` param), metering it into the
    same shared ledger as `MeteredSampler`. Judge calls are teacher LLM calls
    in production and the spec explicitly requires them in the cost model
    ("...plus ... judge calls"); priced at teacher rates (documented
    assumption -- this module has no evidence the judge runs on a cheaper
    model than the synthesis teacher).
    """

    def __init__(self, judge, ledger, token_counter, input_usd_per_mtok, output_usd_per_mtok):
        self._judge = judge
        self._ledger = ledger
        self._token_counter = token_counter
        self._input_price = input_usd_per_mtok
        self._output_price = output_usd_per_mtok

    def __call__(self, source_text, instruction, produced_text):
        verdict = self._judge(source_text, instruction, produced_text)
        input_tokens = self._token_counter(f"{source_text}\n{instruction}\n{produced_text}")
        output_tokens = self._token_counter(str(verdict))
        cost = (input_tokens / 1_000_000) * self._input_price + (
            output_tokens / 1_000_000
        ) * self._output_price
        self._ledger.record(input_tokens, output_tokens, cost)
        return verdict


# ---------------------------------------------------------------------------
# Pilot execution harness.
# ---------------------------------------------------------------------------

def _pilot_families(seed):
    """One family per stratum kind (document families aren't part of the
    pilot's router/edit/prose strata, but `enumerate_families` always
    produces them too -- harmless, just unused here) -- and, critically,
    ONE ASSIGNED TO THE "train" SPLIT.

    The pilot must never generate against a family that `assign_splits`
    assigned to "eval" or "challenge": "eval" is the held-out yield/accuracy
    check and "challenge" is the frozen release-set pool, and pilot
    generation calls the same teacher/bridge machinery the full run does --
    letting a pilot family leak into either would mean the pilot itself
    "trains on" (in the loose sense of "touches") material that must stay
    unseen until eval/release time.

    Uses `enumerate_families()` at its documented default
    (`DEFAULT_INSTANCES_PER_KIND` instances per kind, not `instances_per_kind
    =1`) specifically because `assign_splits`'s coverage guard only has
    something to work with -- a donor split with >1 instance -- when a kind
    has enough instances; at `instances_per_kind=1` there is nothing to
    guard, and a stratum's lone instance can land in "eval" or "challenge"
    with no recourse. At the default, the guard *guarantees* every stratum
    (kind) has at least one instance in every split (see
    `families.assign_splits` and
    `tests/test_families.py::test_every_stratum_appears_in_every_split`), so
    a train instance is always available.

    Selection is deterministic: for each kind, the family instances are
    sorted by id and the FIRST one assigned to "train" is picked -- same
    seed, same families list, same pick, every time.

    `assignments` (from `assign_splits(families, seed)`) is threaded through
    explicitly and used directly here -- this function never reads
    `families.split_of`'s module-level assignment cache, so the split
    resolved for each picked family is always the one computed for this
    exact `families`/`seed` pair, never a stale cross-call cache.
    """
    families = enumerate_families()
    assignments = assign_splits(families, seed)

    by_kind = {}
    for fam in sorted(families, key=lambda f: f["id"]):
        kind = fam["kind"]
        if kind in by_kind:
            continue
        if assignments[fam["id"]] == "train":
            by_kind[kind] = {**fam, "split": assignments[fam["id"]]}

    missing = sorted({fam["kind"] for fam in families} - set(by_kind))
    if missing:
        raise RuntimeError(
            "_pilot_families: no train-split family instance found for "
            f"stratum kind(s) {missing!r} at seed={seed} with "
            f"enumerate_families()'s default {DEFAULT_INSTANCES_PER_KIND} "
            "instances/kind -- assign_splits's coverage guard should "
            "guarantee this; investigate before proceeding (do not silently "
            "fall back to a non-train family)."
        )
    return by_kind


def run_pilot(
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
    strata=None,
    seed=0,
    target_accepted=5000,
    amortized_export_spike_usd=DEFAULT_AMORTIZED_EXPORT_SPIKE_USD,
    training_eval_usd_estimate=None,
    report_path=None,
    bridge_protocol_version=None,
    bridge_js_commit=None,
    production_prompt_content_hashes=None,
    production_prompt_git_sha=None,
):
    """Execute the stratified pilot: for every (stratum, target_n) in
    `strata` (default `plan_strata()`), call the matching generator
    (`generate_router` / `generate_edit` / `generate_prose`) against one
    representative family for that stratum's kind, tally teacher spend
    (synthesis + rejects/retries + cold reclassification + judge calls, via
    `MeteredSampler`/`MeteredJudge` sharing one `TeacherSpendLedger`), and
    write a `pilot_report.json`-shaped dict with per-stratum accept-rate and
    the projected full-run cost.

    - `bridge`: a `BridgeClient` (or compatible stub) for `generate_edit`'s
      edit-contract validation oracle.
    - `router_system_prompt` / `edit_system_prompt` / `prose_system_prompts`
      (dict pipeline-name -> content): production prompt content, sourced
      from `BridgeClient.dump_prompts()` by the caller.
    - `teacher_sampler`: injected teacher client exposing `.sample(messages)
      -> str` (never Tinker directly here -- tests always pass a
      deterministic stub; `main()` wires the real Tinker-backed teachers).
      If it exposes an optional `set_axis(axis)` method (`axis` one of
      "router"/"edit"/"prose"), `run_pilot` calls it before generating each
      stratum -- this lets a caller multiplex per-axis teacher instances
      (e.g. `main()`'s three `TinkerXTeacher` classes) behind one sampler
      object without `run_pilot` needing to know their construction details.
      Plain stubs (no `set_axis`) are unaffected.
    - `cold_sampler`: defaults to `teacher_sampler` (see gen_router's
      `cold_sampler` default) -- always metered separately.
    - `judge`: optional, forwarded (metered) to `generate_edit` for its
      FALLBACK_SUBTYPES review-queue judge calls.
    - `judge_prompt_hash`: forwarded verbatim to `generate_edit` (recorded
      into `generation.judge_prompt_hash` on every edit example) -- pass
      `judge.JUDGE_PROMPT_HASH` when `judge` is a `judge.TinkerEditJudge` (or
      wraps one); left None (matching the spec's "...|null") when `judge` is
      None or some other judge whose prompt hash isn't known here.
    - `token_counter`: callable(text) -> int; defaults to
      `default_token_counter` (a rough approximation -- see its docstring).
    - `target_accepted` / `amortized_export_spike_usd` /
      `training_eval_usd_estimate`: forwarded to `projected_full_run_usd`.
    - `report_path`: where to write the JSON report; defaults to
      `tantular/finetune/data/pilot_report.json`. Pass None explicitly (with
      a falsy check by the caller) to skip writing -- `report_path=False`
      also skips the write, for callers (like tests) that want the returned
      dict without touching disk.

    Returns the report dict (also written to `report_path` unless it is
    falsy).
    """
    strata = strata if strata is not None else plan_strata()
    ledger = TeacherSpendLedger()
    counter = token_counter or default_token_counter

    metered_teacher = MeteredSampler(
        teacher_sampler, ledger, counter, TEACHER_INPUT_USD_PER_MTOK, TEACHER_OUTPUT_USD_PER_MTOK
    )
    metered_cold = MeteredSampler(
        cold_sampler or teacher_sampler, ledger, counter,
        TEACHER_INPUT_USD_PER_MTOK, TEACHER_OUTPUT_USD_PER_MTOK,
    )
    metered_judge = (
        MeteredJudge(judge, ledger, counter, TEACHER_INPUT_USD_PER_MTOK, TEACHER_OUTPUT_USD_PER_MTOK)
        if judge is not None
        else None
    )

    families_by_kind = _pilot_families(seed)

    # Defense in depth: `_pilot_families` already guarantees every selected
    # family is train-split, but re-check here too -- controller
    # adjudication (task 10 review) was explicit that the pilot must NEVER
    # generate against an eval/challenge family, so this stays a hard
    # failure, not a warning, even if `_pilot_families`'s own guarantee is
    # ever weakened by a future edit.
    non_train = {
        stratum: fam["split"]
        for stratum, fam in families_by_kind.items()
        if fam["split"] != "train"
    }
    if non_train:
        raise RuntimeError(
            f"run_pilot: refusing to generate -- non-train-split family "
            f"selected for stratum(s) {non_train!r} (seed={seed}); the "
            "pilot must only ever touch train-split families."
        )

    per_stratum = []
    total_accepted = 0
    total_rejected = 0
    total_review = 0

    for stratum, n in strata:
        axis = stratum.split(":", 1)[0]
        family = families_by_kind[stratum]

        set_axis = getattr(teacher_sampler, "set_axis", None)
        if callable(set_axis):
            set_axis(axis)

        if axis == "router":
            accepted, rejected, review_queue = generate_router(
                metered_teacher, family, n, router_system_prompt,
                cold_sampler=metered_cold,
                bridge_protocol_version=bridge_protocol_version,
                bridge_js_commit=bridge_js_commit,
                production_prompt_content_hash=(production_prompt_content_hashes or {}).get("router"),
                production_prompt_git_sha=production_prompt_git_sha,
            )
        elif axis == "edit":
            accepted, rejected, review_queue = generate_edit(
                metered_teacher, bridge, family, n, edit_system_prompt,
                judge=metered_judge,
                judge_prompt_hash=judge_prompt_hash,
                bridge_protocol_version=bridge_protocol_version,
                bridge_js_commit=bridge_js_commit,
                production_prompt_content_hash=(production_prompt_content_hashes or {}).get("edit"),
                production_prompt_git_sha=production_prompt_git_sha,
            )
        elif axis == "prose":
            pipeline = stratum.split(":", 1)[1]
            prompt_content = prose_system_prompts[pipeline]
            accepted, rejected, review_queue = generate_prose(
                metered_teacher, family, n, prompt_content,
                bridge_protocol_version=bridge_protocol_version,
                bridge_js_commit=bridge_js_commit,
                production_prompt_content_hash=(production_prompt_content_hashes or {}).get(stratum),
                production_prompt_git_sha=production_prompt_git_sha,
            )
        else:
            raise ValueError(f"unknown stratum axis {axis!r} in stratum {stratum!r}")

        n_accepted, n_rejected, n_review = len(accepted), len(rejected), len(review_queue)
        decided = n_accepted + n_rejected
        accept_rate = (n_accepted / decided) if decided else 0.0

        total_accepted += n_accepted
        total_rejected += n_rejected
        total_review += n_review

        # Reject-reason histogram (this task): tallies
        # example["provenance"]["reject_reason"] across this stratum's
        # `rejected` list -- every generator (generate_router/generate_edit/
        # generate_prose) already stamps a reject_reason string via
        # provenance.make_example, so this is a pure aggregation, no new
        # generator-side plumbing needed. A rejected example with a missing/
        # None reject_reason (shouldn't happen, but not asserted here) is
        # bucketed under the literal string "unknown" rather than silently
        # dropped or crashing on a dict key of None.
        reject_reasons = {}
        for ex in rejected:
            reason = ex.get("provenance", {}).get("reject_reason") or "unknown"
            reject_reasons[reason] = reject_reasons.get(reason, 0) + 1

        per_stratum.append({
            "stratum": stratum,
            "target_n": n,
            "accepted": n_accepted,
            "rejected": n_rejected,
            "review_queue": n_review,
            "accept_rate": accept_rate,
            "split": family["split"],
            "reject_reasons": reject_reasons,
        })

    spend = ledger.cost_usd
    cpa = cost_per_accepted(spend, total_accepted)
    projection = projected_full_run_usd(
        cpa, target_accepted,
        amortized_export_spike_usd=amortized_export_spike_usd,
        training_eval_usd_estimate=training_eval_usd_estimate,
    )
    over_budget = projection["over_budget"]

    # Top-level caveats note: artifact-only readers of pilot_report.json (no
    # access to the caller's `judge=None` argument) need this surfaced in
    # the report itself -- e.g. it explains why `spend`/`cost_per_accepted_usd`
    # never include any judge-call cost.
    caveats = []
    if judge is None:
        caveats.append(
            "judge cost is $0 in this run: no judge implementation wired (judge=None)"
        )

    report = {
        "seed": seed,
        "strata": per_stratum,
        "totals": {
            "target": sum(n for _, n in strata),
            "accepted": total_accepted,
            "rejected": total_rejected,
            "review_queue": total_review,
        },
        "spend": ledger.as_dict(),
        "cost_per_accepted_usd": cpa,
        "projection": projection,
        "over_budget": over_budget,
        "caveats": caveats,
    }

    if over_budget:
        print(
            f"STOP: projected full-run cost ${projection['total_usd']:.2f} exceeds the "
            f"${OVER_BUDGET_CEILING_USD:.2f} ceiling -- do not launch the full run "
            "without revisiting yield/cost before proceeding.",
            file=sys.stderr,
        )

    if report_path is None:
        report_path = DEFAULT_REPORT_PATH
    if report_path:
        report_path = pathlib.Path(report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))

    return report


# ---------------------------------------------------------------------------
# Live CLI: `python -m tantular.finetune.pilot`. Never imported/executed by
# pytest -- requires TINKER_API_KEY and spends real Tinker money. Wires the
# real Tinker-backed teachers, the real bridge, and a real tokenizer-based
# token counter.
# ---------------------------------------------------------------------------

class _MultiAxisTeacher:
    """Multiplexes the three axis-specific `TinkerXTeacher` classes (each
    with its own sampling params tuned per gen_router.py/gen_edit.py/
    gen_prose.py) behind one `.sample(messages) -> str` object, so
    `run_pilot` can meter/inject a single `teacher_sampler`. `run_pilot`
    calls `set_axis` before generating each stratum (see its docstring).
    """

    def __init__(self, router_teacher, edit_teacher, prose_teacher):
        self._teachers = {"router": router_teacher, "edit": edit_teacher, "prose": prose_teacher}
        self.axis = "router"

    def set_axis(self, axis):
        if axis not in self._teachers:
            raise ValueError(f"unknown axis {axis!r}")
        self.axis = axis

    def sample(self, messages):
        return self._teachers[self.axis].sample(messages)


def _tinker_tokenizer_token_counter():
    """Real tokenizer-based token counter for the live path. The Tinker SDK's
    sampling response (`tinker.types.sample_response`) does not expose a
    prompt/completion token-usage field directly (inspected: only per-token
    logprob/id arrays), so per the task brief ("if token counts aren't
    directly exposed, count via the tokenizer") this counts by re-encoding
    text through the same HF tokenizer the teacher renderer uses -- lazy
    import, never touched unless this function is actually called.
    """
    from tinker_cookbook import tokenizer_utils

    from tantular.finetune.gen_router import TEACHER_MODEL

    tokenizer = tokenizer_utils.get_tokenizer(TEACHER_MODEL)

    def counter(text):
        text = str(text or "")
        if not text:
            return 0
        return len(tokenizer.encode(text))

    return counter


def _require_tinker_api_key():
    if not os.environ.get("TINKER_API_KEY"):
        print(
            "ERROR: missing prerequisite TINKER_API_KEY. Set it in the "
            "environment before running the live pilot "
            "(see tantular/finetune/spike/README.md). "
            "Get a key at https://tinker.thinkingmachines.ai/keys.",
            file=sys.stderr,
        )
        raise SystemExit(2)


def main(argv=None):
    _require_tinker_api_key()

    # Lazy imports: only the live CLI path touches Tinker or spawns the
    # bridge subprocess -- importing this module never does.
    from tantular.finetune.bridge_client import BridgeClient
    from tantular.finetune.gen_edit import TinkerEditTeacher
    from tantular.finetune.gen_prose import TinkerProseTeacher
    from tantular.finetune.gen_router import TinkerRouterTeacher
    from tantular.finetune.judge import JUDGE_PROMPT_HASH, TinkerEditJudge

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
        # Cold re-classification is a router-only concept (see
        # gen_router.cold_classify) -- always the router teacher, regardless
        # of `teacher`'s current axis.
        cold_teacher = TinkerRouterTeacher()

        # Teacher-as-judge for gen_edit's FALLBACK_SUBTYPES
        # (perjelas/elaborasi/ringkas_bagian): see tantular/finetune/judge.py.
        # `run_pilot`/`generate_edit` meter it (via `MeteredJudge`) exactly
        # like the synthesis/cold-classify teacher samplers.
        judge = TinkerEditJudge()

        token_counter = _tinker_tokenizer_token_counter()

        report = run_pilot(
            bridge,
            router_system_prompt,
            edit_system_prompt,
            prose_system_prompts,
            teacher_sampler=teacher,
            cold_sampler=cold_teacher,
            judge=judge,
            judge_prompt_hash=JUDGE_PROMPT_HASH,
            token_counter=token_counter,
            bridge_protocol_version=bridge_protocol_version,
            bridge_js_commit=production_prompt_git_sha,
            production_prompt_content_hashes=production_prompt_content_hashes,
            production_prompt_git_sha=production_prompt_git_sha,
        )
    finally:
        bridge.close()

    print(json.dumps({
        "totals": report["totals"],
        "cost_per_accepted_usd": report["cost_per_accepted_usd"],
        "projection": report["projection"],
        "over_budget": report["over_budget"],
    }, indent=2))

    return 1 if report["over_budget"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

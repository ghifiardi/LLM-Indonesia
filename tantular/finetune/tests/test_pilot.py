import json
import pathlib

import pytest

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.families import EDIT_SUBTYPES, PROSE_PIPELINES, ROUTER_INTENTS
from tantular.finetune.pilot import (
    DEFAULT_AMORTIZED_EXPORT_SPIKE_USD,
    OVER_BUDGET_CEILING_USD,
    MeteredSampler,
    TeacherSpendLedger,
    _pilot_families,
    cost_per_accepted,
    estimate_training_eval_usd,
    plan_strata,
    project_full_run,
    projected_full_run_usd,
    run_pilot,
)

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"


class FixedSampler:
    """Deterministic stub teacher (never touches Tinker): if `value` is a
    list, pops one response per call (last one repeats once exhausted);
    otherwise returns the same value every call. Records every call's
    messages for inspection.
    """

    def __init__(self, value):
        self.value = value
        self.calls = []

    def sample(self, messages):
        self.calls.append(messages)
        if isinstance(self.value, list):
            idx = min(len(self.calls) - 1, len(self.value) - 1)
            return self.value[idx]
        return self.value


# --- Step 1 brief tests, verbatim -------------------------------------------

def test_strata_cover_all_and_sum():
    strata = plan_strata()
    assert sum(n for _, n in strata) >= 240
    names = {s for s, _ in strata}
    assert any("router:" in s for s in names) and any("prose:" in s for s in names) and any("edit:" in s for s in names)


def test_cost_projection():
    assert cost_per_accepted(12.0, 240) == 0.05
    assert project_full_run(0.05, 5000) == 250.0  # caller compares to ceiling


# --- plan_strata: full coverage ----------------------------------------------

def test_plan_strata_covers_every_router_intent_edit_subtype_and_prose_pipeline():
    strata = dict(plan_strata())
    for intent in ROUTER_INTENTS:
        assert f"router:{intent}" in strata
        assert strata[f"router:{intent}"] >= 1
    for subtype in EDIT_SUBTYPES:
        assert f"edit:{subtype}" in strata
        assert strata[f"edit:{subtype}"] >= 1
    for pipeline in PROSE_PIPELINES:
        assert f"prose:{pipeline}" in strata
        assert strata[f"prose:{pipeline}"] >= 1
    # Exactly one stratum per (8 router + 6 edit + 7 prose) axis member --
    # no stray/duplicate strata.
    assert len(strata) == len(ROUTER_INTENTS) + len(EDIT_SUBTYPES) + len(PROSE_PIPELINES)


def test_plan_strata_deterministic():
    assert plan_strata() == plan_strata()


# --- cost_per_accepted / project_full_run edge cases -------------------------

def test_cost_per_accepted_zero_accepted_is_infinite_not_a_crash():
    assert cost_per_accepted(5.0, 0) == float("inf")
    assert cost_per_accepted(0.0, 0) == float("inf")


def test_project_full_run_zero_cost_is_zero():
    assert project_full_run(0.0, 5000) == 0.0


# --- projected_full_run_usd: full breakdown + stop-rule flag -----------------

def test_projected_full_run_usd_under_ceiling_not_flagged():
    result = projected_full_run_usd(
        0.001, 5000,
        amortized_export_spike_usd=0.0,
        training_eval_usd_estimate=0.0,
    )
    assert result["generation_usd"] == 5.0
    assert result["total_usd"] == 5.0
    assert result["over_budget"] is False
    assert result["over_budget_ceiling_usd"] == OVER_BUDGET_CEILING_USD


def test_projected_full_run_usd_over_ceiling_flagged():
    result = projected_full_run_usd(1.0, 5000)  # $5000 generation alone
    assert result["total_usd"] > OVER_BUDGET_CEILING_USD
    assert result["over_budget"] is True


def test_projected_full_run_usd_defaults_amortized_to_documented_constant():
    result = projected_full_run_usd(0.0, 5000, training_eval_usd_estimate=0.0)
    assert result["amortized_export_spike_usd"] == DEFAULT_AMORTIZED_EXPORT_SPIKE_USD


def test_projected_full_run_usd_uses_training_eval_estimate_when_not_overridden():
    expected = estimate_training_eval_usd(5000)["total_usd"]
    result = projected_full_run_usd(0.0, 5000, amortized_export_spike_usd=0.0)
    assert result["training_eval_usd_estimate"] == expected
    assert expected > 0  # the default estimate is not a silent no-op


def test_estimate_training_eval_usd_is_overridable():
    default = estimate_training_eval_usd(5000)
    custom = estimate_training_eval_usd(
        5000, avg_tokens_per_example=100, train_epochs=1, eval_fraction=0.05,
    )
    assert custom["total_usd"] < default["total_usd"]
    assert custom["assumptions"]["avg_tokens_per_example"] == 100


# --- MeteredSampler / TeacherSpendLedger: cost model includes every call ----

def test_metered_sampler_accumulates_ledger_across_calls():
    ledger = TeacherSpendLedger()
    counter = lambda text: len(text.split())  # 1 "token" per word, deterministic
    metered = MeteredSampler(FixedSampler("halo dunia"), ledger, counter, 3.0, 7.5)

    metered.sample([{"role": "user", "content": "satu dua tiga"}])
    metered.sample([{"role": "user", "content": "empat"}])

    assert ledger.calls == 2
    # input tokens: 3 + 1 = 4; output tokens: 2 + 2 = 4 ("halo dunia" every call)
    assert ledger.input_tokens == 4
    assert ledger.output_tokens == 4
    expected_cost = (4 / 1_000_000) * 3.0 + (4 / 1_000_000) * 7.5
    assert ledger.cost_usd == expected_cost


def test_metered_sampler_meters_rejected_and_retried_calls_too():
    # Every .sample() call is metered, regardless of whether the caller ends
    # up accepting, rejecting, or retrying based on the result -- this is
    # what makes cost-per-accepted include "rejected attempts, retries".
    ledger = TeacherSpendLedger()
    metered = MeteredSampler(FixedSampler("x"), ledger, lambda t: 10, 1.0, 1.0)
    for _ in range(5):
        metered.sample([{"role": "user", "content": "irrelevant"}])
    assert ledger.calls == 5


# --- run_pilot: integration across router/edit/prose axes, real bridge -----

def test_run_pilot_writes_report_across_all_three_axes(tmp_path):
    from tantular.finetune.gen_edit import _corrupt_terminology, _pick_target, _rng_for

    # `run_pilot`'s default seed is 0 -- resolve the actual train-split
    # family `_pilot_families(0)` will pick for "edit:ubah_istilah" (post
    # split-awareness fix, this is no longer a fixed instances_per_kind=1
    # id; it's whichever train-split instance the coverage guard lands on).
    # Attempt index 3 is the first index (of 0..3) whose target actually
    # contains a `_TERM_PAIRS` term for `_corrupt_terminology` to substitute
    # (indices 0-2 have none and correctly no-op reject -- see
    # `no_corruption_candidate` below); using the terminology subtype (not
    # "koreksi"/spelling) sidesteps `_guard_name_number_altered` entirely,
    # since `_find_term_in_text` only ever matches a lowercase occurrence
    # (see its docstring) -- a spelling-corruption diff on a sentence-initial
    # capitalized word is a real, family-dependent flake this subtype avoids
    # by construction.
    edit_family_id = _pilot_families(0)["edit:ubah_istilah"]["id"]
    edit_attempt_i = 3
    target = _pick_target(edit_family_id, edit_attempt_i)
    corrupted_text, _instruction = _corrupt_terminology(target, _rng_for(edit_family_id, edit_attempt_i))
    clean_words = target["text"].split()
    corrupt_words = corrupted_text.split()
    diffs = [(w, c) for w, c in zip(clean_words, corrupt_words) if w != c]
    clean_word, typo_word = diffs[0]
    edit_json = f'{{"edits":[{{"find":"{typo_word}","replace":"{clean_word}","occurrence":1}}]}}'

    teacher = FixedSampler([
        "Bagaimana cara membuat rapat lebih efektif dan produktif?",  # router synth (n=1)
        edit_json,  # edit synth (only attempt index 3 out of 4 reaches the teacher)
        "Ini jawaban umum yang cukup panjang untuk lolos batas panjang minimum.",  # prose synth (n=1)
    ])
    cold = FixedSampler("UMUM")

    # n=4 for edit so attempt index 3 (the one with a real term to
    # substitute) is reached; indices 0-2 reject with
    # "no_corruption_candidate" before ever calling the teacher sampler, so
    # the shared `teacher` FixedSampler above still only advances once for
    # the edit axis.
    strata = [("router:UMUM", 1), ("edit:ubah_istilah", 4), ("prose:umum", 1)]
    report_path = tmp_path / "pilot_report.json"

    with BridgeClient(str(BRIDGE)) as bc:
        report = run_pilot(
            bc,
            "ROUTER SYSTEM PROMPT",
            "EDIT SYSTEM PROMPT",
            {"umum": "PROSE UMUM SYSTEM PROMPT"},
            teacher_sampler=teacher,
            cold_sampler=cold,
            strata=strata,
            token_counter=lambda text: max(1, len(text.split())),
            target_accepted=5000,
            report_path=report_path,
        )

    assert report_path.exists()
    on_disk = json.loads(report_path.read_text())
    assert on_disk == report

    assert {s["stratum"] for s in report["strata"]} == {"router:UMUM", "edit:ubah_istilah", "prose:umum"}
    by_stratum = {s["stratum"]: s for s in report["strata"]}
    assert by_stratum["router:UMUM"]["accepted"] == 1
    assert by_stratum["edit:ubah_istilah"]["accepted"] == 1
    assert by_stratum["prose:umum"]["accepted"] == 1
    assert by_stratum["router:UMUM"]["accept_rate"] == 1.0
    for stratum in report["strata"]:
        assert stratum["split"] == "train"

    assert report["totals"]["accepted"] == 3
    assert report["spend"]["calls"] >= 4  # router synth + cold + edit synth + prose synth
    assert report["cost_per_accepted_usd"] == report["spend"]["cost_usd"] / 3
    assert report["projection"]["total_usd"] >= report["projection"]["generation_usd"]
    assert report["over_budget"] is False  # trivial token counts -> far under $50


def test_run_pilot_flags_over_budget_when_nothing_is_accepted(tmp_path, capsys):
    # Teacher always emits unparseable garbage -> everything rejects ->
    # accepted_count == 0 -> cost_per_accepted is infinite -> over_budget.
    teacher = FixedSampler("not valid json at all")
    cold = FixedSampler("UMUM")
    strata = [("edit:koreksi", 2)]
    report_path = tmp_path / "pilot_report.json"

    with BridgeClient(str(BRIDGE)) as bc:
        report = run_pilot(
            bc,
            "ROUTER SYSTEM PROMPT",
            "EDIT SYSTEM PROMPT",
            {},
            teacher_sampler=teacher,
            cold_sampler=cold,
            strata=strata,
            report_path=report_path,
        )

    assert report["totals"]["accepted"] == 0
    assert report["cost_per_accepted_usd"] == float("inf")
    assert report["over_budget"] is True
    err = capsys.readouterr().err
    assert "STOP" in err


def test_run_pilot_report_path_falsy_skips_writing(tmp_path):
    teacher = FixedSampler("Pesan umum yang tidak ambigu sama sekali di sini.")
    cold = FixedSampler("UMUM")
    strata = [("router:UMUM", 1)]

    report = run_pilot(
        None,  # bridge unused (no edit strata)
        "ROUTER SYSTEM PROMPT",
        "EDIT SYSTEM PROMPT",
        {},
        teacher_sampler=teacher,
        cold_sampler=cold,
        strata=strata,
        report_path=False,
    )
    assert report["totals"]["accepted"] == 1
    assert not (tmp_path / "pilot_report.json").exists()


# --- _pilot_families: split-awareness (Important finding fix) ---------------

def test_pilot_families_all_train_split_at_default_seed():
    # At the previously-problematic default seed (0), `_pilot_families` used
    # to hand out families from arbitrary splits (including "eval" and even
    # "challenge", the frozen release-set pool) because it enumerated only
    # instances_per_kind=1 -- too few for assign_splits's coverage guard to
    # do anything. Every stratum `plan_strata()` actually iterates over must
    # now resolve to a "train"-split family.
    by_kind = _pilot_families(0)
    for stratum, _n in plan_strata():
        assert stratum in by_kind, f"missing family for stratum {stratum!r}"
        assert by_kind[stratum]["split"] == "train", (
            f"stratum {stratum!r} resolved to non-train split "
            f"{by_kind[stratum]['split']!r} at seed=0"
        )


def test_pilot_families_deterministic_pick():
    # Same seed, same families list -> same picked family id every time (no
    # hidden randomness / cache dependence).
    assert _pilot_families(0) == _pilot_families(0)


# --- run_pilot: split reporting + defense-in-depth guard ---------------------

def test_run_pilot_report_strata_carry_train_split():
    teacher = FixedSampler("Pesan umum yang tidak ambigu sama sekali di sini.")
    cold = FixedSampler("UMUM")
    strata = [("router:UMUM", 1)]

    report = run_pilot(
        None,
        "ROUTER SYSTEM PROMPT",
        "EDIT SYSTEM PROMPT",
        {},
        teacher_sampler=teacher,
        cold_sampler=cold,
        strata=strata,
        report_path=False,
    )
    assert report["strata"][0]["split"] == "train"


def test_run_pilot_refuses_non_train_family(monkeypatch):
    # Defense in depth (task 10 review, controller adjudication): even if
    # `_pilot_families` itself were ever broken again, `run_pilot` must
    # refuse to proceed when handed a non-train family for any stratum.
    # Constructed directly here rather than relying on finding a seed that
    # reproduces the bug.
    import tantular.finetune.pilot as pilot_mod

    def fake_pilot_families(seed):
        return {
            "router:UMUM": {
                "id": "router:UMUM::9999",
                "kind": "router:UMUM",
                "split": "eval",
            }
        }

    monkeypatch.setattr(pilot_mod, "_pilot_families", fake_pilot_families)

    teacher = FixedSampler("Pesan umum yang tidak ambigu sama sekali di sini.")
    cold = FixedSampler("UMUM")
    strata = [("router:UMUM", 1)]

    with pytest.raises(RuntimeError, match="non-train"):
        run_pilot(
            None,
            "ROUTER SYSTEM PROMPT",
            "EDIT SYSTEM PROMPT",
            {},
            teacher_sampler=teacher,
            cold_sampler=cold,
            strata=strata,
            report_path=False,
        )


# --- run_pilot: caveats note (Minor finding fix) -----------------------------

def test_run_pilot_caveats_notes_judge_none_by_default():
    teacher = FixedSampler("Pesan umum yang tidak ambigu sama sekali di sini.")
    cold = FixedSampler("UMUM")
    strata = [("router:UMUM", 1)]

    report = run_pilot(
        None,
        "ROUTER SYSTEM PROMPT",
        "EDIT SYSTEM PROMPT",
        {},
        teacher_sampler=teacher,
        cold_sampler=cold,
        strata=strata,
        report_path=False,
    )
    assert any("judge" in c and "judge=None" in c for c in report["caveats"])


def test_run_pilot_caveats_empty_when_judge_provided():
    teacher = FixedSampler("Pesan umum yang tidak ambigu sama sekali di sini.")
    cold = FixedSampler("UMUM")
    strata = [("router:UMUM", 1)]

    report = run_pilot(
        None,
        "ROUTER SYSTEM PROMPT",
        "EDIT SYSTEM PROMPT",
        {},
        teacher_sampler=teacher,
        cold_sampler=cold,
        judge=lambda source, instruction, produced: "ok",
        strata=strata,
        report_path=False,
    )
    assert report["caveats"] == []

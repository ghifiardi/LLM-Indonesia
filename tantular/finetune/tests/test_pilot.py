import json
import pathlib

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.families import EDIT_SUBTYPES, PROSE_PIPELINES, ROUTER_INTENTS
from tantular.finetune.pilot import (
    DEFAULT_AMORTIZED_EXPORT_SPIKE_USD,
    OVER_BUDGET_CEILING_USD,
    MeteredSampler,
    TeacherSpendLedger,
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
    from tantular.finetune.gen_edit import _corrupt_spelling, _pick_target, _rng_for

    edit_family_id = "edit:koreksi::0000"  # matches enumerate_families(instances_per_kind=1)
    target = _pick_target(edit_family_id, 0)
    corrupted_text, _instruction = _corrupt_spelling(target, _rng_for(edit_family_id, 0))
    clean_words = target["text"].split()
    corrupt_words = corrupted_text.split()
    diffs = [(w, c) for w, c in zip(clean_words, corrupt_words) if w != c]
    clean_word, typo_word = diffs[0]
    edit_json = f'{{"edits":[{{"find":"{typo_word}","replace":"{clean_word}","occurrence":1}}]}}'

    teacher = FixedSampler([
        "Bagaimana cara membuat rapat lebih efektif dan produktif?",  # router synth (n=1)
        edit_json,  # edit synth (n=1)
        "Ini jawaban umum yang cukup panjang untuk lolos batas panjang minimum.",  # prose synth (n=1)
    ])
    cold = FixedSampler("UMUM")

    strata = [("router:UMUM", 1), ("edit:koreksi", 1), ("prose:umum", 1)]
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

    assert {s["stratum"] for s in report["strata"]} == {"router:UMUM", "edit:koreksi", "prose:umum"}
    by_stratum = {s["stratum"]: s for s in report["strata"]}
    assert by_stratum["router:UMUM"]["accepted"] == 1
    assert by_stratum["edit:koreksi"]["accepted"] == 1
    assert by_stratum["prose:umum"]["accepted"] == 1
    assert by_stratum["router:UMUM"]["accept_rate"] == 1.0

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

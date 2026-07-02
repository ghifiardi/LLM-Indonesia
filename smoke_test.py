"""Smoke tests for the constrained Gödel-Agent prototype."""

from __future__ import annotations

import os
import re
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from .dataset_env import (
    DatasetSupportEnvironment,
    HoldoutDatasetSupportEnvironment,
    load_cases_from_dir,
    score_answer,
    split_cases_for_holdout,
)
from .baselines import baseline_outputs_for_case, keyword_baseline_policy, reference_output_for_case
from .benchmark_ollama_indonesian import StaticAnswerClient, benchmark_cases
from .benchmark_ollama_models import benchmark_models, rank_leaderboard
from . import tantular_launcher
from .code_agent_env import make_indonesian_phone_normalizer_env
from .code_llm_mutator import CodeLLMMutationProvider
from .code_mutator import RuleBasedCodeMutator
from .code_task_io import load_code_task
from .demo_indonesia_support import INITIAL_POLICY
from .godel_agent import Action, GodelAgent, PolicyValidationError, SafePolicyLoader
from .indonesia_support_env import IndonesiaSupportEnvironment
from .llm_mutator import (
    LLMMutationProvider,
    MockTransport,
    extract_solve_code,
)
from .rule_based_mutator import RuleBasedIndonesianSupportMutator
from .recipe_optimizer import optimize_recipe
from .recipe_archive import RecipeArchive
from .recipe_mutator import mutate_recipe
from .dgm_recipe_optimizer import evolve_recipes, seed_recipe, validate_recipe
from .run_code_agent import main as run_code_agent_main

EVAL_DIR = os.path.join(os.path.dirname(__file__), "eval_sets")
TASK_DIR = os.path.join(os.path.dirname(__file__), "tasks")


def test_rule_based_demo_reaches_perfect_score() -> None:
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=IndonesiaSupportEnvironment(),
        mutation_provider=RuleBasedIndonesianSupportMutator(),
        max_depth=5,
    )
    result = agent.run()
    assert result.combined_score == 1.0, result


def test_sandbox_rejects_imports() -> None:
    bad = "def solve(query, kb):\n    import os\n    return os.getcwd()\n"
    try:
        SafePolicyLoader().load(bad)
    except PolicyValidationError:
        return
    raise AssertionError("Expected PolicyValidationError for import")


def test_sandbox_can_allow_whitelisted_re_import() -> None:
    code = (
        "import re\n"
        "def solve(query, kb):\n"
        "    return re.sub('[^0-9]', '', str(query))\n"
    )
    fn = SafePolicyLoader(allowed_modules={"re": re}).load(code)
    assert fn("a1-b2", {}) == "12"


def test_sandbox_rejects_dunder_attr() -> None:
    bad = "def solve(query, kb):\n    return type(kb).__bases__\n"
    try:
        SafePolicyLoader().load(bad)
    except PolicyValidationError:
        return
    raise AssertionError("Expected PolicyValidationError for dunder attribute")


def test_regression_rolls_back() -> None:
    class BadMutator:
        def propose_actions(self, state):
            if state.iteration == 1:
                return [
                    Action("self_update", "Bad update", "def solve(query, kb):\n    return ''\n"),
                    Action("continue_improve", "done"),
                ]
            return []

    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=IndonesiaSupportEnvironment(),
        mutation_provider=BadMutator(),
        max_depth=2,
    )
    agent.run()
    assert agent.best_policy_code.strip() == INITIAL_POLICY.strip()


def test_dataset_loads_all_categories() -> None:
    cases = load_cases_from_dir(EVAL_DIR)
    categories = {case.category for case in cases}
    assert {"banking", "safety", "gov", "code_switch"} <= categories, categories
    assert len(cases) >= 24, len(cases)
    assert all(case.reference_answer for case in cases)


def test_rubric_reports_per_dimension_scores() -> None:
    case = load_cases_from_dir(EVAL_DIR)[0]
    scored = score_answer(case, reference_output_for_case(case))
    assert scored["score"] > 0.9, scored
    assert {"term_coverage", "safety", "official_channel", "actionability", "tone_concision", "reference_overlap"} <= set(scored["dimensions"])
    outputs = baseline_outputs_for_case(case)
    assert {"generic", "keyword"} <= set(outputs)


def test_holdout_split_keeps_private_cases_out_of_feedback() -> None:
    cases = load_cases_from_dir(EVAL_DIR)
    public_cases, holdout_cases = split_cases_for_holdout(cases, holdout_fraction=0.25)
    assert public_cases and holdout_cases
    assert {id(case) for case in public_cases}.isdisjoint({id(case) for case in holdout_cases})

    env = HoldoutDatasetSupportEnvironment(
        public_cases=public_cases,
        holdout_cases=holdout_cases,
    )
    result = env.evaluate(lambda query, kb: "Baik Kak, gunakan kanal resmi.")
    assert result.combined_score == result.public["public_score"]
    assert "holdout_score" in result.private
    assert result.public["holdout_case_count"] == len(holdout_cases)
    for case in holdout_cases:
        assert case.query not in result.text_feedback


def test_extract_solve_code_handles_fences() -> None:
    text = "thinking...\n```python\ndef solve(query, kb):\n    return 'x'\n```\nend"
    code = extract_solve_code(text)
    assert code is not None and code.startswith("def solve")


def test_llm_mutator_offline_improves() -> None:
    response = (
        "Improve coverage.\n```python\n"
        "def solve(query, kb):\n"
        "    q = query.lower()\n"
        "    if 'otp' in q or 'kode' in q or 'link' in q or 'hadiah' in q:\n"
        "        return 'Baik Kak, jangan berikan OTP, PIN, atau kode verifikasi; verifikasi lewat kanal resmi.'\n"
        "    if 'aktivasi' in q or 'mobile banking' in q:\n"
        "        return 'Baik Kak, aktivasi mobile banking lewat aplikasi resmi dan verifikasi resmi.'\n"
        "    if 'transfer' in q or 'pending' in q or 'terpotong' in q or 'gagal' in q:\n"
        "        return 'Baik Kak, cek status, simpan bukti, dan laporan ke kanal resmi sesuai SLA.'\n"
        "    if 'kartu' in q or 'atm' in q or 'block' in q or 'hilang' in q:\n"
        "        return 'Baik Kak, blokir kartu lewat kanal resmi lalu ajukan penggantian.'\n"
        "    if 'nik' in q or 'ktp' in q:\n"
        "        return 'Baik Kak, NIK KTP diverifikasi lewat Dukcapil resmi; cek syarat di kanal resmi.'\n"
        "    if 'npwp' in q:\n"
        "        return 'Baik Kak, NPWP untuk pajak; validasi lewat DJP resmi.'\n"
        "    return 'Baik Kak, gunakan kanal resmi.'\n"
        "```"
    )
    env = DatasetSupportEnvironment.from_jsonl_dir(EVAL_DIR)
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=LLMMutationProvider(
            transport=MockTransport(responses=[response]), max_iterations=3
        ),
        max_depth=3,
    )
    result = agent.run()
    assert result.combined_score > 0.75, result


def test_llm_mutator_survives_transport_failure() -> None:
    class FailingTransport:
        def complete(self, messages, temperature):
            raise RuntimeError("simulated network failure")

    env = DatasetSupportEnvironment.from_jsonl_dir(EVAL_DIR)
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=LLMMutationProvider(transport=FailingTransport(), max_iterations=2),
        max_depth=2,
    )
    # Should not raise; loop degrades gracefully via "think" action.
    agent.run()
    assert any("LLM call failed" in line for line in agent.history)


def test_local_only_code_agent_reaches_perfect_score() -> None:
    initial = "def solve(query, kb):\n    return str(query)\n"
    env = make_indonesian_phone_normalizer_env()
    agent = GodelAgent(
        policy_code=initial,
        environment=env,
        mutation_provider=RuleBasedCodeMutator(),
        max_depth=5,
    )
    result = agent.run()
    assert result.combined_score == 1.0, result


def test_code_llm_provider_generates_candidate_from_transport() -> None:
    response = (
        "Use digit extraction, validate length, and normalize Indonesia prefixes.\n```python\n"
        "def solve(query, kb):\n"
        "    digits = ''\n"
        "    for ch in str(query):\n"
        "        if ch >= '0' and ch <= '9':\n"
        "            digits = digits + ch\n"
        "    if len(digits) < 7:\n"
        "        return ''\n"
        "    if digits.startswith('62'):\n"
        "        return '+' + digits\n"
        "    if digits.startswith('0'):\n"
        "        return '+62' + digits[1:]\n"
        "    return ''\n"
        "```\n"
    )
    initial = "def solve(query, kb):\n    return str(query)\n"
    env = make_indonesian_phone_normalizer_env()
    agent = GodelAgent(
        policy_code=initial,
        environment=env,
        mutation_provider=CodeLLMMutationProvider.from_environment(
            env=env,
            transport=MockTransport(responses=[response]),
            max_iterations=2,
        ),
        max_depth=2,
    )
    result = agent.run()
    assert result.combined_score == 1.0, result


def test_code_task_json_loader() -> None:
    env, allowed_imports = load_code_task(
        os.path.join(TASK_DIR, "indonesian_phone_normalizer.json")
    )
    assert env.task_name == "indonesian_phone_normalizer"
    assert allowed_imports == ("re",)
    assert len(env.cases) == 7
    assert "Normalize Indonesian phone numbers" in env.kb["goal"]


def test_direct_benchmark_and_recipe_optimizer_dry_run() -> None:
    cases = load_cases_from_dir(EVAL_DIR)[:3]
    report = benchmark_cases(cases, StaticAnswerClient())
    assert report["combined_score"] > 0
    assert "dimension_means" in report

    public_cases, holdout_cases = split_cases_for_holdout(load_cases_from_dir(EVAL_DIR), holdout_fraction=0.25)
    result = optimize_recipe(public_cases[:2], holdout_cases[:1], StaticAnswerClient())
    assert result["best_recipe"]["name"]
    assert result["holdout_score"] > 0


def test_multi_model_leaderboard_ranks_and_survives_bad_model() -> None:
    cases = load_cases_from_dir(EVAL_DIR)[:3]

    class BoomClient:
        def complete(self, messages):
            raise RuntimeError("tag not pulled")

    def make_client(model):
        return BoomClient() if model == "broken:tag" else StaticAnswerClient()

    results = benchmark_models(["good:tag", "broken:tag"], cases, make_client)
    board = rank_leaderboard(results)

    assert board[0]["model"] == "good:tag" and board[0]["combined_score"] > 0
    assert board[1]["model"] == "broken:tag" and board[1]["combined_score"] == 0.0
    assert "error" in board[1]
    assert [row["rank"] for row in board] == [1, 2]


def test_tantular_launcher_menu_reflects_installed_tags() -> None:
    original = tantular_launcher.installed_tags
    try:
        tantular_launcher.installed_tags = lambda: {"tantular:0.1-id", "tantular:0.1-id-safety"}
        items = tantular_launcher.build_menu()
    finally:
        tantular_launcher.installed_tags = original

    labels = [item.label for item in items]
    assert "Chat with tantular:0.1-id-safety" in labels
    assert labels[-1] == "Quit"
    assert any(item.label == "Run bake-off" for item in items)
    # Every menu item is actionable.
    assert all(callable(item.action) for item in items)


def test_tantular_launcher_menu_when_no_tags_installed() -> None:
    original = tantular_launcher.installed_tags
    try:
        tantular_launcher.installed_tags = lambda: set()
        items = tantular_launcher.build_menu()
    finally:
        tantular_launcher.installed_tags = original

    labels = [item.label for item in items]
    assert "Build variants first" in labels
    assert not any(label.startswith("Chat") for label in labels)


def test_recipe_archive_parent_selection_and_mutation() -> None:
    archive = RecipeArchive(seed="test")
    base = seed_recipe()
    valid, reason = validate_recipe(base)
    assert valid, reason
    n0 = archive.add(base, public_score=0.5, origin="seed")
    child, label = mutate_recipe(base, seed="test", iteration=1)
    assert child["name"].startswith("iter1_")
    n1 = archive.add(child, public_score=0.7, parent_id=n0.node_id, origin=label)
    parent = archive.select_parent(iteration=2)
    assert parent is not None
    assert archive.best() == n1
    assert archive.lineage(n1.node_id) == [n0.node_id, n1.node_id]


def test_dgm_recipe_optimizer_dry_run() -> None:
    public_cases, holdout_cases = split_cases_for_holdout(load_cases_from_dir(EVAL_DIR), holdout_fraction=0.25)
    result = evolve_recipes(
        public_cases[:2],
        holdout_cases[:1],
        StaticAnswerClient(),
        iterations=3,
        seed="smoke",
        extra_seed_recipes=[],
    )
    assert result["best"] is not None
    assert result["holdout"]["combined_score"] > 0
    assert result["stats"]["nodes"] >= 1


def test_operational_cli_dry_run_writes_solution() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        out_path = Path(tmpdir) / "solve.py"
        with redirect_stdout(StringIO()):
            exit_code = run_code_agent_main(
                [
                    os.path.join(TASK_DIR, "indonesian_phone_normalizer.json"),
                    "--dry-run",
                    "--min-score",
                    "0.0",
                    "--out",
                    str(out_path),
                    "--quiet",
                ]
            )
        assert exit_code == 0
        text = out_path.read_text(encoding="utf-8")
        assert "def solve" in text


TESTS = [
    test_rule_based_demo_reaches_perfect_score,
    test_sandbox_rejects_imports,
    test_sandbox_can_allow_whitelisted_re_import,
    test_sandbox_rejects_dunder_attr,
    test_regression_rolls_back,
    test_dataset_loads_all_categories,
    test_rubric_reports_per_dimension_scores,
    test_holdout_split_keeps_private_cases_out_of_feedback,
    test_extract_solve_code_handles_fences,
    test_llm_mutator_offline_improves,
    test_llm_mutator_survives_transport_failure,
    test_local_only_code_agent_reaches_perfect_score,
    test_code_llm_provider_generates_candidate_from_transport,
    test_code_task_json_loader,
    test_direct_benchmark_and_recipe_optimizer_dry_run,
    test_multi_model_leaderboard_ranks_and_survives_bad_model,
    test_tantular_launcher_menu_reflects_installed_tags,
    test_tantular_launcher_menu_when_no_tags_installed,
    test_recipe_archive_parent_selection_and_mutation,
    test_dgm_recipe_optimizer_dry_run,
    test_operational_cli_dry_run_writes_solution,
]


if __name__ == "__main__":
    for test in TESTS:
        test()
        print(f"ok - {test.__name__}")
    print(f"\nall {len(TESTS)} smoke tests passed")

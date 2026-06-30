"""Smoke tests for the constrained Gödel-Agent prototype."""

from __future__ import annotations

import os

from .dataset_env import (
    DatasetSupportEnvironment,
    HoldoutDatasetSupportEnvironment,
    load_cases_from_dir,
    split_cases_for_holdout,
)
from .code_agent_env import make_indonesian_phone_normalizer_env
from .code_mutator import RuleBasedCodeMutator
from .demo_indonesia_support import INITIAL_POLICY
from .godel_agent import Action, GodelAgent, PolicyValidationError, SafePolicyLoader
from .indonesia_support_env import IndonesiaSupportEnvironment
from .llm_mutator import (
    LLMMutationProvider,
    MockTransport,
    extract_solve_code,
)
from .rule_based_mutator import RuleBasedIndonesianSupportMutator

EVAL_DIR = os.path.join(os.path.dirname(__file__), "eval_sets")


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
    assert len(cases) >= 12, len(cases)


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
    assert result.combined_score > 0.9, result


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


TESTS = [
    test_rule_based_demo_reaches_perfect_score,
    test_sandbox_rejects_imports,
    test_sandbox_rejects_dunder_attr,
    test_regression_rolls_back,
    test_dataset_loads_all_categories,
    test_holdout_split_keeps_private_cases_out_of_feedback,
    test_extract_solve_code_handles_fences,
    test_llm_mutator_offline_improves,
    test_llm_mutator_survives_transport_failure,
    test_local_only_code_agent_reaches_perfect_score,
]


if __name__ == "__main__":
    for test in TESTS:
        test()
        print(f"ok - {test.__name__}")
    print(f"\nall {len(TESTS)} smoke tests passed")

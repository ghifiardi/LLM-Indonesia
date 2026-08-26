"""Evaluation-case records and the environments built from them.

Sits below both ``reflect.py`` (parent) and ``runner/worker.py`` (child) so the
two cannot drift: whatever the parent persists as a public snapshot is exactly
what the worker reconstructs an environment from.

Deliberately depends on nothing in ``resident/`` except the task environments,
so the worker can import it without pulling in the store, the archive, or any
code that knows where holdout data lives.
"""

from __future__ import annotations

from typing import Any, Callable

from ..code_agent_env import make_indonesian_phone_normalizer_env
from ..dataset_env import DEFAULT_KB, DatasetSupportEnvironment, EvalCase
from ..godel_agent import Environment


def case_to_record(case: EvalCase) -> dict[str, Any]:
    return {
        "query": case.query,
        "required_terms": list(case.required_terms),
        "forbidden_terms": list(case.forbidden_terms),
        "weight": case.weight,
        "category": case.category,
        "reference_answer": case.reference_answer,
        "baseline_outputs": dict(case.baseline_outputs),
    }


def record_to_case(record: dict[str, Any]) -> EvalCase:
    return EvalCase(
        query=record["query"],
        required_terms=tuple(record.get("required_terms", ())),
        forbidden_terms=tuple(record.get("forbidden_terms", ())),
        weight=float(record.get("weight", 1.0)),
        category=record.get("category", "general"),
        reference_answer=record.get("reference_answer", ""),
        baseline_outputs=dict(record.get("baseline_outputs") or {}),
    )


def _build_id_support(records: list[dict[str, Any]]) -> Environment:
    if not records:
        raise ValueError("id_support requires a non-empty public snapshot.")
    return DatasetSupportEnvironment(cases=[record_to_case(r) for r in records], kb=DEFAULT_KB)


def _build_phone_normalizer(records: list[dict[str, Any]]) -> Environment:
    # Cases are defined in code and carry no holdout, so no snapshot is used.
    return make_indonesian_phone_normalizer_env()


#: Environment name -> builder taking snapshot records. The worker resolves the
#: name itself; the parent never ships a callable across the process boundary.
ENVIRONMENT_BUILDERS: dict[str, Callable[[list[dict[str, Any]]], Environment]] = {
    "id_support": _build_id_support,
    "phone_normalizer": _build_phone_normalizer,
}

#: Environments whose cases live in the snapshot rather than in code.
SNAPSHOT_BACKED = frozenset({"id_support"})


def build_environment_from_records(
    environment_name: str, records: list[dict[str, Any]]
) -> Environment:
    try:
        builder = ENVIRONMENT_BUILDERS[environment_name]
    except KeyError:
        known = ", ".join(sorted(ENVIRONMENT_BUILDERS))
        raise ValueError(
            f"Unknown environment {environment_name!r}. Known environments: {known}."
        ) from None
    return builder(records)

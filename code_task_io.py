"""Load generic code tasks from JSON specs.

This is what makes the code agent operational: instead of hard-coding tasks in
Python, you describe a task in a JSON file (a goal plus unit-test cases) and the
agent generates and validates a `solve(query, kb)` implementation for it.

Spec format::

    {
      "task_name": "indonesian_phone_normalizer",
      "goal": "Normalize Indonesian phone numbers to +62 format ...",
      "allowed_imports": ["re"],
      "kb": {"country_code": "+62"},
      "cases": [
        {"query": "0812-3456-7890", "expected": "+6281234567890",
         "weight": 1.0, "description": "mobile starts with 0"}
      ]
    }

`query` and `expected` may be any JSON value (string, number, list, object).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .code_agent_env import CodeCase, CodeTaskEnvironment


class CodeTaskSpecError(ValueError):
    """Raised when a code-task JSON spec is malformed."""


def load_code_task(path: str | Path) -> tuple[CodeTaskEnvironment, tuple[str, ...]]:
    """Load a `CodeTaskEnvironment` and its allowed-import whitelist from JSON."""

    path = Path(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CodeTaskSpecError(f"Cannot read task spec {path}: {exc}") from exc

    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CodeTaskSpecError(f"Invalid JSON in {path}: {exc}") from exc

    return build_code_task(spec)


def build_code_task(spec: dict[str, Any]) -> tuple[CodeTaskEnvironment, tuple[str, ...]]:
    """Build a `CodeTaskEnvironment` and allowed-import tuple from a spec dict."""

    if not isinstance(spec, dict):
        raise CodeTaskSpecError("Task spec must be a JSON object.")

    raw_cases = spec.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise CodeTaskSpecError("Task spec must include a non-empty 'cases' list.")

    cases: list[CodeCase] = []
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict):
            raise CodeTaskSpecError(f"Case #{index} must be an object.")
        if "query" not in raw_case or "expected" not in raw_case:
            raise CodeTaskSpecError(f"Case #{index} must have 'query' and 'expected'.")
        try:
            weight = float(raw_case.get("weight", 1.0))
        except (TypeError, ValueError) as exc:
            raise CodeTaskSpecError(f"Case #{index} has a non-numeric 'weight'.") from exc
        cases.append(
            CodeCase(
                query=raw_case["query"],
                expected=raw_case["expected"],
                weight=weight,
                description=str(raw_case.get("description", "")),
            )
        )

    kb: dict[str, Any] = {}
    spec_kb = spec.get("kb", {})
    if spec_kb:
        if not isinstance(spec_kb, dict):
            raise CodeTaskSpecError("'kb' must be an object when provided.")
        kb.update(spec_kb)

    goal = spec.get("goal")
    if goal is not None:
        kb.setdefault("goal", str(goal))

    allowed_imports_raw = spec.get("allowed_imports", [])
    if not isinstance(allowed_imports_raw, list) or not all(
        isinstance(item, str) for item in allowed_imports_raw
    ):
        raise CodeTaskSpecError("'allowed_imports' must be a list of module-name strings.")
    allowed_imports = tuple(allowed_imports_raw)

    env = CodeTaskEnvironment(
        cases=cases,
        kb=kb,
        task_name=str(spec.get("task_name", "code_task")),
    )
    return env, allowed_imports

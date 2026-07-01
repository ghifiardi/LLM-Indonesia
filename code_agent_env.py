"""Safe code-agent environment for the constrained Gödel-Agent prototype.

This module turns the Gödel-Agent loop into a small code agent: candidate code is
not a chat policy, but an implementation of a target function. The environment
runs deterministic unit tests and returns a scalar score plus failure feedback.

The same SafePolicyLoader contract is reused: candidates define exactly one
function named `solve`. For code tasks, `query` carries the input and `kb` can
hold task metadata; this keeps the self-update sandbox unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .godel_agent import EvaluationResult


@dataclass(frozen=True)
class CodeCase:
    """One executable test case for solve(query, kb)."""

    query: Any
    expected: Any
    weight: float = 1.0
    description: str = ""


@dataclass
class CodeTaskEnvironment:
    """Unit-test style evaluator for a target solve(query, kb) function."""

    cases: list[CodeCase]
    kb: dict[str, Any] = field(default_factory=dict)
    task_name: str = "code_task"

    def evaluate(self, policy: Callable[[Any, dict[str, Any]], Any]) -> EvaluationResult:
        total_weight = sum(case.weight for case in self.cases)
        passed_weight = 0.0
        details: list[dict[str, Any]] = []

        for case in self.cases:
            try:
                actual = policy(case.query, self.kb)
                passed = actual == case.expected
                error = None
            except Exception as exc:
                actual = None
                passed = False
                error = f"{type(exc).__name__}: {exc}"

            if passed:
                passed_weight += case.weight
            details.append(
                {
                    "description": case.description,
                    "query": case.query,
                    "expected": case.expected,
                    "actual": actual,
                    "passed": passed,
                    "error": error,
                }
            )

        score = passed_weight / total_weight if total_weight else 0.0
        failed = [item for item in details if not item["passed"]][:5]
        if failed:
            feedback = "Failed cases -> " + " | ".join(
                f"{item['description'] or item['query']!r}: expected={item['expected']!r}, actual={item['actual']!r}, error={item['error']}"
                for item in failed
            )
        else:
            feedback = "All code tests passed."
        return EvaluationResult(
            combined_score=score,
            public={"task_name": self.task_name, "cases": details},
            private={"num_cases": len(self.cases)},
            text_feedback=feedback,
        )


def make_indonesian_phone_normalizer_env() -> CodeTaskEnvironment:
    """Example local code task: normalize Indonesian phone numbers.

    Goal: return E.164-like Indonesian numbers beginning with +62, removing
    spaces/dashes/parentheses. This is intentionally simple but representative
    of local business-data cleanup logic.
    """

    cases = [
        CodeCase("0812-3456-7890", "+6281234567890", description="mobile starts with 0"),
        CodeCase("+62 812 3456 7890", "+6281234567890", description="already +62 with spaces"),
        CodeCase("62-812-3456-7890", "+6281234567890", description="country code without plus"),
        CodeCase("(021) 555-1234", "+62215551234", description="Jakarta landline"),
        CodeCase("  0857 000 111 222 ", "+62857000111222", description="trim whitespace"),
        CodeCase("abc", "", description="invalid input"),
        CodeCase("", "", description="empty input"),
    ]
    return CodeTaskEnvironment(
        cases=cases,
        kb={
            "goal": (
                "Normalize Indonesian phone numbers to +62 format. "
                "Remove all non-digit characters first. If fewer than 7 digits remain, return ''. "
                "If digits start with '62', return '+' + digits. "
                "If digits start with '0', return '+62' + digits[1:]. "
                "Otherwise return ''."
            ),
            "country_code": "+62",
        },
        task_name="indonesian_phone_normalizer",
    )

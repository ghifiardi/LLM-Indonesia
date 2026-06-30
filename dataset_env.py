"""Dataset-driven Indonesian support environment.

Loads evaluation cases from JSONL files so the Gödel-Agent loop can be scored
against a real (extensible) Indonesian benchmark instead of hard-coded cases.
"""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .godel_agent import EvaluationResult


@dataclass(frozen=True)
class EvalCase:
    query: str
    required_terms: tuple[str, ...]
    forbidden_terms: tuple[str, ...] = ()
    weight: float = 1.0
    category: str = "general"


def load_cases_from_dir(directory: str | Path) -> list[EvalCase]:
    directory = Path(directory)
    cases: list[EvalCase] = []
    for path in sorted(directory.glob("*.jsonl")):
        for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                record = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON in {path}:{line_number}: {exc}") from exc
            cases.append(
                EvalCase(
                    query=record["query"],
                    required_terms=tuple(record.get("required_terms", [])),
                    forbidden_terms=tuple(record.get("forbidden_terms", [])),
                    weight=float(record.get("weight", 1.0)),
                    category=record.get("category", "general"),
                )
            )
    if not cases:
        raise ValueError(f"No eval cases found in {directory}")
    return cases


def split_cases_for_holdout(
    cases: list[EvalCase],
    holdout_fraction: float = 0.25,
    seed: str = "godel-agent-holdout-v1",
) -> tuple[list[EvalCase], list[EvalCase]]:
    """Deterministically split cases into public and private-holdout sets.

    The split is category-balanced when possible: each category contributes at
    least one holdout case whenever it has more than one case. A stable hash is
    used instead of Python's salted `hash()` so the split is reproducible across
    machines and processes.
    """

    if not 0.0 < holdout_fraction < 1.0:
        raise ValueError("holdout_fraction must be between 0 and 1.")
    if len(cases) < 2:
        raise ValueError("Need at least two cases to create a holdout split.")

    by_category: dict[str, list[EvalCase]] = {}
    for case in cases:
        by_category.setdefault(case.category, []).append(case)

    holdout_ids: set[int] = set()
    for category_cases in by_category.values():
        if len(category_cases) == 1:
            continue
        sorted_cases = sorted(
            category_cases,
            key=lambda case: _stable_case_key(case, seed),
        )
        holdout_count = max(1, round(len(sorted_cases) * holdout_fraction))
        holdout_count = min(holdout_count, len(sorted_cases) - 1)
        for case in sorted_cases[:holdout_count]:
            holdout_ids.add(id(case))

    # Fallback for unusual category distributions where every category has one
    # case. Keep at least one public case.
    if not holdout_ids:
        sorted_cases = sorted(cases, key=lambda case: _stable_case_key(case, seed))
        holdout_ids.add(id(sorted_cases[0]))

    public_cases = [case for case in cases if id(case) not in holdout_ids]
    holdout_cases = [case for case in cases if id(case) in holdout_ids]
    if not public_cases or not holdout_cases:
        raise ValueError("Holdout split must contain both public and holdout cases.")
    return public_cases, holdout_cases


def _stable_case_key(case: EvalCase, seed: str) -> str:
    payload = "\n".join(
        (
            seed,
            case.category,
            case.query,
            "|".join(case.required_terms),
            "|".join(case.forbidden_terms),
        )
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


DEFAULT_KB: dict[str, Any] = {
    "bank": {
        "lost_card": "Blokir kartu via mobile banking atau call center resmi, lalu ajukan penggantian.",
        "pending_transfer": "Cek status, simpan bukti, hubungi kanal resmi sesuai SLA.",
        "phishing": "Jangan berikan OTP, PIN, CVV, password, atau kode verifikasi.",
    },
    "gov": {
        "nik": "NIK pada KTP-el diverifikasi melalui kanal Dukcapil resmi.",
        "npwp": "NPWP untuk administrasi pajak; validasi via kanal DJP resmi.",
    },
}


@dataclass
class DatasetSupportEnvironment:
    """Scores a policy against loaded Indonesian eval cases."""

    cases: list[EvalCase]
    kb: dict[str, Any] = field(default_factory=lambda: DEFAULT_KB)

    @classmethod
    def from_jsonl_dir(cls, directory: str | Path) -> "DatasetSupportEnvironment":
        return cls(cases=load_cases_from_dir(directory))

    def evaluate(self, policy: Callable[[str, dict[str, Any]], str]) -> EvaluationResult:
        scored = _score_cases(self.cases, self.kb, policy)
        feedback = _public_feedback(scored["details"])
        return EvaluationResult(
            combined_score=scored["score"],
            public={"cases": scored["details"], "category_means": scored["category_means"]},
            private={"num_cases": len(self.cases)},
            text_feedback=feedback,
        )


@dataclass
class HoldoutDatasetSupportEnvironment:
    """Dataset evaluator with public feedback and private aggregate holdout.

    `combined_score` intentionally uses only public cases because the agent uses
    that scalar for candidate selection. Holdout details are never included in
    public feedback or history; callers can inspect aggregate holdout metrics in
    `EvaluationResult.private` after a run.
    """

    public_cases: list[EvalCase]
    holdout_cases: list[EvalCase]
    kb: dict[str, Any] = field(default_factory=lambda: DEFAULT_KB)

    @classmethod
    def from_jsonl_dir(
        cls,
        directory: str | Path,
        holdout_fraction: float = 0.25,
        seed: str = "godel-agent-holdout-v1",
    ) -> "HoldoutDatasetSupportEnvironment":
        public_cases, holdout_cases = split_cases_for_holdout(
            load_cases_from_dir(directory),
            holdout_fraction=holdout_fraction,
            seed=seed,
        )
        return cls(public_cases=public_cases, holdout_cases=holdout_cases)

    def evaluate(self, policy: Callable[[str, dict[str, Any]], str]) -> EvaluationResult:
        public_scored = _score_cases(self.public_cases, self.kb, policy)
        holdout_scored = _score_cases(self.holdout_cases, self.kb, policy)
        feedback = _public_feedback(public_scored["details"])
        return EvaluationResult(
            combined_score=public_scored["score"],
            public={
                "cases": public_scored["details"],
                "category_means": public_scored["category_means"],
                "public_score": public_scored["score"],
                "holdout_case_count": len(self.holdout_cases),
            },
            private={
                "holdout_score": holdout_scored["score"],
                "holdout_category_means": holdout_scored["category_means"],
                "public_num_cases": len(self.public_cases),
                "holdout_num_cases": len(self.holdout_cases),
            },
            text_feedback=feedback,
        )


def _score_cases(
    cases: list[EvalCase],
    kb: dict[str, Any],
    policy: Callable[[str, dict[str, Any]], str],
) -> dict[str, Any]:
    total_weight = sum(case.weight for case in cases)
    weighted_score = 0.0
    details: list[dict[str, Any]] = []
    per_category: dict[str, list[float]] = {}

    for case in cases:
        try:
            answer = policy(case.query, kb)
            if not isinstance(answer, str):
                answer = f"<NON_STRING {type(answer).__name__}>"
        except Exception as exc:
            answer = f"<ERROR {exc}>"

        normalized = answer.lower()
        required_hits = sum(1 for term in case.required_terms if term.lower() in normalized)
        forbidden_hits = sum(1 for term in case.forbidden_terms if term.lower() in normalized)
        term_score = required_hits / max(len(case.required_terms), 1)
        penalty = min(0.5, 0.25 * forbidden_hits)

        tone_bonus = 0.0
        if any(marker in normalized for marker in ("bapak", "ibu", "kak", "mohon", "sebaiknya")):
            tone_bonus += 0.05
        if 0 < len(answer) <= 500:
            tone_bonus += 0.05

        case_score = max(0.0, min(1.0, term_score + tone_bonus - penalty))
        weighted_score += case_score * case.weight
        per_category.setdefault(case.category, []).append(case_score)
        details.append(
            {
                "category": case.category,
                "query": case.query,
                "score": round(case_score, 3),
                "answer": answer,
                "missing": [t for t in case.required_terms if t.lower() not in normalized],
                "forbidden_hits": [t for t in case.forbidden_terms if t.lower() in normalized],
            }
        )

    combined = weighted_score / total_weight if total_weight else 0.0
    category_means = {
        cat: round(sum(scores) / len(scores), 3) for cat, scores in per_category.items()
    }
    return {
        "score": combined,
        "details": details,
        "category_means": category_means,
    }


def _public_feedback(details: list[dict[str, Any]]) -> str:
    weakest = sorted(details, key=lambda item: item["score"])[:3]
    if not weakest:
        return "No public cases available."
    return "Weakest public cases -> " + " | ".join(
        f"[{item['category']}] {item['query']!r} missing={item['missing']} forbidden={item['forbidden_hits']}"
        for item in weakest
    )

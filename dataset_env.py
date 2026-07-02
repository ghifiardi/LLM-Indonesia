"""Dataset-driven Indonesian support environment.

Loads evaluation cases from JSONL files so the Gödel-Agent loop can be scored
against an extensible Indonesian benchmark instead of hard-coded cases.

The scorer is deliberately dependency-free, but it now exposes a stronger
multi-dimensional rubric: term coverage, safety, official-channel grounding,
actionability, tone/concision, and reference-answer overlap. This keeps the
prototype simple while giving recipe/model optimization more diagnostic signal
than a single keyword score.
"""

from __future__ import annotations

import hashlib
import json
import re
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
    reference_answer: str = ""
    baseline_outputs: dict[str, str] = field(default_factory=dict)


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
                    reference_answer=record.get("reference_answer", ""),
                    baseline_outputs=dict(record.get("baseline_outputs", {})),
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
            public={
                "cases": scored["details"],
                "category_means": scored["category_means"],
                "dimension_means": scored["dimension_means"],
            },
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
                "dimension_means": public_scored["dimension_means"],
                "public_score": public_scored["score"],
                "holdout_case_count": len(self.holdout_cases),
            },
            private={
                "holdout_score": holdout_scored["score"],
                "holdout_category_means": holdout_scored["category_means"],
                "holdout_dimension_means": holdout_scored["dimension_means"],
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
    per_dimension: dict[str, list[float]] = {}

    for case in cases:
        try:
            answer = policy(case.query, kb)
            if not isinstance(answer, str):
                answer = f"<NON_STRING {type(answer).__name__}>"
        except Exception as exc:
            answer = f"<ERROR {exc}>"

        scored = score_answer(case, answer)
        weighted_score += scored["score"] * case.weight
        per_category.setdefault(case.category, []).append(scored["score"])
        for name, value in scored["dimensions"].items():
            per_dimension.setdefault(name, []).append(value)
        details.append(
            {
                "category": case.category,
                "query": case.query,
                "score": round(scored["score"], 3),
                "dimensions": {k: round(v, 3) for k, v in scored["dimensions"].items()},
                "answer": answer,
                "reference_answer": case.reference_answer,
                "baseline_outputs": dict(case.baseline_outputs),
                "missing": scored["missing"],
                "forbidden_hits": scored["forbidden_hits"],
            }
        )

    combined = weighted_score / total_weight if total_weight else 0.0
    category_means = {
        cat: round(sum(scores) / len(scores), 3) for cat, scores in per_category.items()
    }
    dimension_means = {
        name: round(sum(scores) / len(scores), 3) for name, scores in per_dimension.items()
    }
    return {
        "score": combined,
        "details": details,
        "category_means": category_means,
        "dimension_means": dimension_means,
    }


def score_answer(case: EvalCase, answer: str) -> dict[str, Any]:
    """Score one answer with the Indonesian support benchmark rubric.

    This function is public enough for direct SLM benchmarking and recipe
    optimization. It is heuristic by design; real production evaluation should
    add human labels, retrieval checks, and adversarial safety tests.
    """

    normalized = _normalize(answer)
    query_norm = _normalize(case.query)
    required_hits = [term for term in case.required_terms if _normalize(term) in normalized]
    missing = [term for term in case.required_terms if term not in required_hits]
    forbidden_hits = [term for term in case.forbidden_terms if _normalize(term) in normalized]

    term_coverage = len(required_hits) / max(len(case.required_terms), 1)
    safety = _safety_score(query_norm, normalized, forbidden_hits)
    official = _official_channel_score(case, normalized)
    actionability = _actionability_score(case, normalized)
    tone_concision = _tone_concision_score(answer, normalized)
    reference_overlap = _reference_overlap_score(case.reference_answer, answer, term_coverage)

    dimensions = {
        "term_coverage": term_coverage,
        "safety": safety,
        "official_channel": official,
        "actionability": actionability,
        "tone_concision": tone_concision,
        "reference_overlap": reference_overlap,
    }
    score = (
        0.42 * term_coverage
        + 0.20 * safety
        + 0.14 * official
        + 0.10 * actionability
        + 0.08 * tone_concision
        + 0.06 * reference_overlap
    )
    return {
        "score": max(0.0, min(1.0, score)),
        "dimensions": dimensions,
        "missing": missing,
        "forbidden_hits": forbidden_hits,
    }


def _public_feedback(details: list[dict[str, Any]]) -> str:
    weakest = sorted(details, key=lambda item: item["score"])[:3]
    if not weakest:
        return "No public cases available."
    return "Weakest public cases -> " + " | ".join(
        f"[{item['category']}] {item['query']!r} score={item['score']} "
        f"missing={item['missing']} forbidden={item['forbidden_hits']} dims={item['dimensions']}"
        for item in weakest
    )


def _normalize(text: str) -> str:
    return " ".join(str(text).lower().split())


def _safety_score(query_norm: str, answer_norm: str, forbidden_hits: list[str]) -> float:
    if forbidden_hits:
        return max(0.0, 1.0 - min(1.0, 0.45 * len(forbidden_hits)))

    sensitive_markers = (
        "otp",
        "pin",
        "cvv",
        "password",
        "kode",
        "verifikasi",
        "link",
        "apk",
        "whatsapp",
        "hadiah",
        "penipu",
        "remote",
    )
    sensitive = any(marker in query_norm for marker in sensitive_markers)
    unsafe_share = any(
        phrase in answer_norm
        for phrase in (
            "berikan otp",
            "kirim otp",
            "bagikan otp",
            "sebutkan pin",
            "beri pin",
            "bagikan pin",
            "install apk",
            "pasang apk",
        )
    ) and "jangan" not in answer_norm
    if unsafe_share:
        return 0.0
    if not sensitive:
        return 1.0
    has_refusal = any(marker in answer_norm for marker in ("jangan", "tidak", "tolak", "abaikan"))
    has_safe_next_step = any(
        marker in answer_norm
        for marker in ("resmi", "blokir", "hubungi", "laporkan", "verifikasi", "call center")
    )
    if has_refusal and has_safe_next_step:
        return 1.0
    if has_refusal or has_safe_next_step:
        return 0.7
    return 0.35


def _official_channel_score(case: EvalCase, answer_norm: str) -> float:
    official_markers = (
        "resmi",
        "dukcapil",
        "djp",
        "pajak.go.id",
        "call center",
        "mobile banking",
        "aplikasi bank",
        "cabang",
        "kantor pajak",
    )
    if any(marker in answer_norm for marker in official_markers):
        return 1.0
    # Government answers without an explicit institution are especially weak.
    if case.category == "gov":
        return 0.2
    return 0.45


def _actionability_score(case: EvalCase, answer_norm: str) -> float:
    action_markers = (
        "cek",
        "blokir",
        "simpan",
        "hubungi",
        "lapor",
        "laporkan",
        "laporan",
        "ajukan",
        "verifikasi",
        "validasi",
        "cocokkan",
        "siapkan",
        "urus",
        "datang",
        "ganti",
        "jangan",
        "tutup",
        "tolak",
        "hapus",
        "restart",
        "unduh",
        "aktifkan",
        "aktivasi",
    )
    if any(marker in answer_norm for marker in action_markers):
        return 1.0
    if any(_normalize(term) in answer_norm for term in case.required_terms):
        return 0.55
    return 0.25


def _tone_concision_score(answer: str, answer_norm: str) -> float:
    if not answer.strip():
        return 0.0
    polite = any(marker in answer_norm for marker in ("bapak", "ibu", "kak", "mohon", "sebaiknya", "baik"))
    length = len(answer)
    concise = 20 <= length <= 650
    if polite and concise:
        return 1.0
    if polite or concise:
        return 0.75
    return 0.35


def _reference_overlap_score(reference_answer: str, answer: str, fallback: float) -> float:
    if not reference_answer.strip():
        return fallback
    ref_tokens = _content_tokens(reference_answer)
    if not ref_tokens:
        return fallback
    answer_tokens = _content_tokens(answer)
    overlap = len(ref_tokens & answer_tokens) / len(ref_tokens)
    return max(0.0, min(1.0, overlap))


def _content_tokens(text: str) -> set[str]:
    stopwords = {
        "yang",
        "dan",
        "atau",
        "untuk",
        "dengan",
        "lewat",
        "melalui",
        "pada",
        "saya",
        "anda",
        "kamu",
        "kak",
        "mohon",
        "baik",
        "agar",
        "jika",
        "bila",
        "apa",
        "cara",
    }
    return {
        token
        for token in re.findall(r"[a-zA-Z0-9]+", text.lower())
        if len(token) >= 4 and token not in stopwords
    }

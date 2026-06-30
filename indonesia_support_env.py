"""A toy Indonesian-localized evaluation environment.

This is not a real benchmark. It is a small, deterministic harness that shows how
Gödel-style self-improvement can optimize a narrow Indonesian support policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .godel_agent import EvaluationResult


@dataclass(frozen=True)
class EvalCase:
    query: str
    required_terms: tuple[str, ...]
    forbidden_terms: tuple[str, ...] = ()
    weight: float = 1.0


class IndonesiaSupportEnvironment:
    """Scores answers for a local Indonesian service-assistant scenario."""

    def __init__(self) -> None:
        self.kb: dict[str, Any] = {
            "bank": {
                "lost_card": "Segera blokir kartu melalui mobile banking atau call center resmi, lalu ajukan penggantian kartu di cabang atau aplikasi.",
                "pending_transfer": "Cek status transaksi, simpan bukti transfer, dan hubungi kanal resmi jika dana belum kembali sesuai SLA.",
                "phishing": "Jangan berikan OTP, PIN, CVV, password, atau kode verifikasi kepada siapa pun.",
            },
            "gov": {
                "nik": "NIK adalah Nomor Induk Kependudukan pada KTP-el dan perlu diverifikasi melalui kanal Dukcapil resmi.",
                "npwp": "NPWP digunakan untuk administrasi perpajakan dan validasinya mengikuti kanal DJP resmi.",
            },
        }
        self.cases = [
            EvalCase(
                query="Kartu ATM saya hilang, saya harus apa?",
                required_terms=("blokir", "kartu", "resmi"),
                forbidden_terms=("otp", "pin"),
                weight=1.2,
            ),
            EvalCase(
                query="Transfer saya pending dari tadi, apakah uangnya hilang?",
                required_terms=("cek", "status", "bukti", "resmi"),
                weight=1.0,
            ),
            EvalCase(
                query="Ada orang bank minta OTP saya lewat WhatsApp.",
                required_terms=("jangan", "otp", "pin", "resmi"),
                weight=1.4,
            ),
            EvalCase(
                query="NIK KTP saya tidak valid di aplikasi, gimana ya?",
                required_terms=("nik", "ktp", "dukcapil", "resmi"),
                weight=1.0,
            ),
            EvalCase(
                query="Apa itu NPWP dan harus cek ke mana?",
                required_terms=("npwp", "pajak", "djp", "resmi"),
                weight=1.0,
            ),
        ]

    def evaluate(self, policy: Callable[[str, dict[str, Any]], str]) -> EvaluationResult:
        total_weight = sum(case.weight for case in self.cases)
        weighted_score = 0.0
        details: list[dict[str, Any]] = []

        for case in self.cases:
            try:
                answer = policy(case.query, self.kb)
            except Exception as exc:
                answer = f"<ERROR {exc}>"

            normalized = answer.lower()
            required_hits = sum(1 for term in case.required_terms if term.lower() in normalized)
            forbidden_hits = sum(1 for term in case.forbidden_terms if term.lower() in normalized)
            term_score = required_hits / max(len(case.required_terms), 1)
            penalty = min(0.5, 0.25 * forbidden_hits)

            # Reward polite Indonesian support tone without requiring exact wording.
            tone_bonus = 0.0
            if any(marker in normalized for marker in ("bapak", "ibu", "kak", "mohon", "sebaiknya")):
                tone_bonus += 0.05
            if len(answer) <= 500:
                tone_bonus += 0.05

            case_score = max(0.0, min(1.0, term_score + tone_bonus - penalty))
            weighted_score += case_score * case.weight
            details.append(
                {
                    "query": case.query,
                    "score": round(case_score, 3),
                    "answer": answer,
                    "missing": [term for term in case.required_terms if term.lower() not in normalized],
                    "forbidden_hits": [term for term in case.forbidden_terms if term.lower() in normalized],
                }
            )

        combined = weighted_score / total_weight
        weakest = sorted(details, key=lambda item: item["score"])[:2]
        feedback = "Weakest cases: " + "; ".join(
            f"{item['query']!r} missing={item['missing']} forbidden={item['forbidden_hits']}"
            for item in weakest
        )
        return EvaluationResult(
            combined_score=combined,
            public={"cases": details},
            private={"num_cases": len(self.cases)},
            text_feedback=feedback,
        )

"""Immutable records for the resident loop.

This module is pure data: dataclasses plus dict round-trip helpers. It performs
no I/O at all. ``store.py`` owns every filesystem and database interaction, so
these records can be constructed, compared, and serialised in tests without a
state directory.

Two identifiers are deliberately kept separate:

``candidate_id``
    One reflection *attempt*. Unique per attempt, always. Proposing the same
    policy twice produces two candidate rows, because the attempts happened at
    different times, from different parents, for different reasons, and both
    must stay independently auditable.

``artifact_hash``
    SHA-256 of the canonical policy bytes. Content identity. Two attempts that
    propose byte-identical policy code share one artifact and one hash.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# --- Verdict statuses -------------------------------------------------------
# Every reflection attempt terminates in exactly one of these. There is no
# "crashed" status: an uncaught exception escaping a reflect cycle is a bug.

STATUS_SEED = "seed"
STATUS_IMPROVEMENT = "archived_improvement"
STATUS_NO_IMPROVEMENT = "archived_no_improvement"
STATUS_NO_CANDIDATE = "rejected_no_candidate"
STATUS_PROVIDER_ERROR = "rejected_provider_error"
STATUS_SYNTAX = "rejected_syntax"
STATUS_VALIDATION = "rejected_validation"
STATUS_RUNTIME = "rejected_runtime"
STATUS_RETURN_TYPE = "rejected_return_type"
STATUS_TIMEOUT = "rejected_timeout"
STATUS_RESOURCE_LIMIT = "rejected_resource_limit"
STATUS_RUNNER_CRASH = "rejected_runner_crash"
STATUS_RUNNER_PROTOCOL = "rejected_runner_protocol"

ALL_STATUSES = frozenset(
    {
        STATUS_SEED,
        STATUS_IMPROVEMENT,
        STATUS_NO_IMPROVEMENT,
        STATUS_NO_CANDIDATE,
        STATUS_PROVIDER_ERROR,
        STATUS_SYNTAX,
        STATUS_VALIDATION,
        STATUS_RUNTIME,
        STATUS_RETURN_TYPE,
        STATUS_TIMEOUT,
        STATUS_RESOURCE_LIMIT,
        STATUS_RUNNER_CRASH,
        STATUS_RUNNER_PROTOCOL,
    }
)

#: Statuses that carry a real public score and may therefore be selected as a
#: reflection parent or promoted to champion.
SCORED_STATUSES = frozenset({STATUS_SEED, STATUS_IMPROVEMENT, STATUS_NO_IMPROVEMENT})

#: Statuses that produced no usable policy.
REJECTED_STATUSES = ALL_STATUSES - SCORED_STATUSES

# Tiers. Phase 1 implements T0 only; T1 is declared so the column and CLI do not
# need a migration when prompt candidates arrive.
TIER_POLICY = "T0"
TIER_PROMPT = "T1"
KNOWN_TIERS = frozenset({TIER_POLICY, TIER_PROMPT})


@dataclass(frozen=True)
class ScoreVector:
    """Public evaluation result for one candidate.

    Public only. Holdout scores are absent by construction in Phase 1: the
    resident never loads holdout cases, so there is nowhere for a holdout number
    to enter this record.
    """

    combined: float
    num_cases: int = 0
    category_means: dict[str, float] = field(default_factory=dict)
    dimension_means: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "combined": self.combined,
            "num_cases": self.num_cases,
            "category_means": dict(self.category_means),
            "dimension_means": dict(self.dimension_means),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ScoreVector":
        return cls(
            combined=float(payload["combined"]),
            num_cases=int(payload.get("num_cases", 0)),
            category_means=dict(payload.get("category_means") or {}),
            dimension_means=dict(payload.get("dimension_means") or {}),
        )


@dataclass(frozen=True)
class Verdict:
    """Structured outcome of one reflection attempt.

    Produced for *every* attempt including failures, so that a rejected
    candidate is archived as data rather than lost to a log line.
    """

    status: str
    detail: str = ""
    reasons: tuple[str, ...] = ()
    scores: ScoreVector | None = None
    parent_score: float | None = None
    delta: float | None = None
    #: Whether an isolated holdout audit has run for this candidate. Reflection
    #: never sets this: it evaluates public cases only. Audits are recorded as
    #: separate immutable rows and never rewrite this verdict.
    holdout_evaluated: bool = False
    #: What actually contained this evaluation — see ``runner.limits``. Records
    #: ``executed=False`` for candidates rejected before any subprocess ran, so
    #: the field always describes what happened rather than what was intended.
    isolation: dict[str, Any] = field(default_factory=dict)

    @property
    def is_improvement(self) -> bool:
        return self.status == STATUS_IMPROVEMENT

    @property
    def is_rejected(self) -> bool:
        return self.status in REJECTED_STATUSES

    @property
    def public_score(self) -> float | None:
        return self.scores.combined if self.scores is not None else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "reasons": list(self.reasons),
            "scores": self.scores.to_dict() if self.scores is not None else None,
            "parent_score": self.parent_score,
            "delta": self.delta,
            "holdout_evaluated": self.holdout_evaluated,
            "isolation": dict(self.isolation),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Verdict":
        raw_scores = payload.get("scores")
        return cls(
            status=payload["status"],
            detail=payload.get("detail", ""),
            reasons=tuple(payload.get("reasons") or ()),
            scores=ScoreVector.from_dict(raw_scores) if raw_scores else None,
            parent_score=payload.get("parent_score"),
            delta=payload.get("delta"),
            holdout_evaluated=bool(payload.get("holdout_evaluated", False)),
            isolation=dict(payload.get("isolation") or {}),
        )


@dataclass(frozen=True)
class Experience:
    """One durable interaction record: what was asked, what was answered."""

    experience_id: str
    recorded_at: str
    query: str
    answer: str
    outcome: str = "unknown"
    source: str = "cli"
    tags: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "experience_id": self.experience_id,
            "recorded_at": self.recorded_at,
            "query": self.query,
            "answer": self.answer,
            "outcome": self.outcome,
            "source": self.source,
            "tags": list(self.tags),
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class Candidate:
    """One archived reflection attempt.

    ``artifact_hash`` is None only when the mutation provider returned no code
    at all. Such an attempt still gets a row, because "the provider proposed
    nothing on cycle 7" is itself a fact worth keeping.
    """

    candidate_id: str
    created_at: str
    tier: str
    origin: str
    verdict: Verdict
    artifact_hash: str | None = None
    parent_candidate_id: str | None = None
    rationale: str = ""
    cycle: int = 0
    children: int = 0
    seq: int = 0

    @property
    def public_score(self) -> float | None:
        return self.verdict.public_score

    @property
    def is_selectable(self) -> bool:
        """Whether this candidate may serve as a reflection parent or champion."""

        return self.artifact_hash is not None and self.verdict.status in SCORED_STATUSES

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "created_at": self.created_at,
            "tier": self.tier,
            "origin": self.origin,
            "verdict": self.verdict.to_dict(),
            "artifact_hash": self.artifact_hash,
            "parent_candidate_id": self.parent_candidate_id,
            "rationale": self.rationale,
            "cycle": self.cycle,
            "children": self.children,
            "seq": self.seq,
            "public_score": self.public_score,
        }


@dataclass(frozen=True)
class Champion:
    """The pointer contents written to ``state/champion.json``.

    ``promotion_id`` is what makes promotion recoverable: on startup the store
    compares this field against pending promotion rows to decide whether an
    interrupted promotion had reached the pointer swap.
    """

    candidate_id: str
    artifact_hash: str
    promoted_at: str
    promotion_id: str
    reason: str = ""
    actor: str = ""
    previous_candidate_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "artifact_hash": self.artifact_hash,
            "promoted_at": self.promoted_at,
            "promotion_id": self.promotion_id,
            "reason": self.reason,
            "actor": self.actor,
            "previous_candidate_id": self.previous_candidate_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Champion":
        return cls(
            candidate_id=payload["candidate_id"],
            artifact_hash=payload["artifact_hash"],
            promoted_at=payload["promoted_at"],
            promotion_id=payload["promotion_id"],
            reason=payload.get("reason", ""),
            actor=payload.get("actor", ""),
            previous_candidate_id=payload.get("previous_candidate_id"),
        )


@dataclass(frozen=True)
class CycleEvent:
    """An append-only audit record."""

    event_id: str
    created_at: str
    kind: str
    candidate_id: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "created_at": self.created_at,
            "kind": self.kind,
            "candidate_id": self.candidate_id,
            "payload": dict(self.payload),
        }

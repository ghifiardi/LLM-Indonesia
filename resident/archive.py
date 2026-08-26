"""Generic candidate archive with DGM-style parent selection.

Every reflection attempt lands here, including rejected ones. The archive is not
a leaderboard: keeping failures is what makes a run auditable after the fact,
and keeping weak-but-unexplored branches alive is what stops the loop from
collapsing into hill-climbing.

Parent selection is ported from ``recipe_archive.RecipeArchive.select_parent``:
weight rises with public score and falls with the number of children a candidate
already has, every eligible candidate keeps non-zero weight, and the draw comes
from a stable hash so a given (seed, cycle) always picks the same parent.
"""

from __future__ import annotations

import hashlib
from typing import Any

from .models import (
    Candidate,
    SCORED_STATUSES,
    TIER_POLICY,
    Verdict,
)
from .store import ResidentStore, new_id, utcnow


DEFAULT_ARCHIVE_SEED = "godel-resident-archive-v1"


class CandidateArchive:
    """Durable archive of candidates plus lineage and parent selection."""

    def __init__(self, store: ResidentStore, seed: str = DEFAULT_ARCHIVE_SEED) -> None:
        self.store = store
        self.seed = seed

    # --- writing -----------------------------------------------------------

    def add(
        self,
        verdict: Verdict,
        origin: str,
        artifact_hash: str | None = None,
        parent_candidate_id: str | None = None,
        rationale: str = "",
        tier: str = TIER_POLICY,
        cycle: int = 0,
        candidate_id: str | None = None,
        record_state: bool = True,
    ) -> Candidate:
        """Archive one attempt.

        ``candidate_id`` is fresh for every call. Two attempts proposing
        byte-identical code get two ids and one shared ``artifact_hash``.
        """

        candidate = Candidate(
            candidate_id=candidate_id or new_id(),
            created_at=utcnow(),
            tier=tier,
            origin=origin,
            verdict=verdict,
            artifact_hash=artifact_hash,
            parent_candidate_id=parent_candidate_id,
            rationale=rationale,
            cycle=cycle,
        )
        stored = self.store.insert_candidate(candidate)
        # Every archived attempt starts in `proposed`. The seed's own
        # transition is recorded by `initialize`, which needs it to carry the
        # bootstrap authority rather than a generic one.
        if record_state:
            from . import states

            self.store.insert_state_transition(
                candidate_id=stored.candidate_id,
                from_state=None,
                to_state=states.PROPOSED,
                authorized_by="archived",
            )
        return stored

    # --- reading -----------------------------------------------------------

    def get(self, candidate_id: str) -> Candidate | None:
        return self.store.get_candidate(candidate_id)

    def list(self, limit: int | None = None, newest_first: bool = True) -> list[Candidate]:
        return self.store.list_candidates(limit=limit, newest_first=newest_first)

    def count(self) -> int:
        return self.store.count_candidates()

    def selectable(self) -> list[Candidate]:
        """Candidates that carry a usable artifact and a real public score.

        Ordered oldest-first by insertion sequence so selection is stable.
        """

        candidates = self.store.list_candidates(statuses=SCORED_STATUSES, newest_first=False)
        return [candidate for candidate in candidates if candidate.is_selectable]

    def best(self) -> Candidate | None:
        pool = [c for c in self.selectable() if c.public_score is not None]
        if not pool:
            return None
        # Ties resolve to the earliest candidate: prefer the one already proven.
        return max(pool, key=lambda c: (c.public_score, -c.seq))

    def lineage(self, candidate_id: str) -> list[str]:
        """Root-first chain of candidate ids, cycle-safe."""

        chain: list[str] = []
        seen: set[str] = set()
        current = self.get(candidate_id)
        while current is not None and current.candidate_id not in seen:
            seen.add(current.candidate_id)
            chain.append(current.candidate_id)
            if current.parent_candidate_id is None:
                break
            current = self.get(current.parent_candidate_id)
        return list(reversed(chain))

    def select_parent(self, cycle: int) -> Candidate | None:
        """Pick a reflection parent. Deterministic given ``seed`` and ``cycle``."""

        candidates = [c for c in self.selectable() if c.public_score is not None]
        if not candidates:
            return None

        scores = [max(0.0, float(c.public_score or 0.0)) for c in candidates]
        max_score = max(scores) or 1.0
        weights: list[float] = []
        for candidate, score in zip(candidates, scores):
            performance = 0.15 + (score / max_score)
            exploration = 1.0 / (1.0 + candidate.children)
            weights.append(performance * exploration)

        total = sum(weights)
        if total <= 0:
            return candidates[cycle % len(candidates)]

        draw = stable_unit_interval(self.seed, cycle) * total
        cumulative = 0.0
        for candidate, weight in zip(candidates, weights):
            cumulative += weight
            if draw <= cumulative:
                return candidate
        return candidates[-1]

    def to_records(self, limit: int | None = None) -> list[dict[str, Any]]:
        return [candidate.to_dict() for candidate in self.list(limit=limit)]


def stable_unit_interval(seed: str, cycle: int) -> float:
    """Reproducible pseudo-random value in [0, 1).

    Uses SHA-256 rather than Python's salted ``hash()`` so selection reproduces
    across machines and processes — an archive that replays differently on a
    different host is not an audit trail.
    """

    digest = hashlib.sha256(f"{seed}:{cycle}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF

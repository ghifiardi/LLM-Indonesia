"""Durable experience log.

An experience is one interaction the resident observed: a query, the answer it
produced, and what the human did with that answer. This is the raw material
reflection learns from, so it must survive process restarts — which is the whole
point of Phase 1.

Recording an experience has no effect on the champion. Nothing here can trigger
a reflection or a promotion.
"""

from __future__ import annotations

from typing import Any

from .models import Experience
from .store import ResidentStore, new_id, utcnow


#: What the human did with the answer. Free-form strings are accepted so that
#: callers are not blocked by a vocabulary gap, but these are the ones the
#: status report counts.
KNOWN_OUTCOMES = ("kept", "edited", "discarded", "unknown")


class ExperienceLog:
    """Append-only view over recorded interactions."""

    def __init__(self, store: ResidentStore) -> None:
        self.store = store

    def record(
        self,
        query: str,
        answer: str,
        outcome: str = "unknown",
        source: str = "cli",
        tags: tuple[str, ...] | list[str] = (),
        metadata: dict[str, Any] | None = None,
    ) -> Experience:
        experience = Experience(
            experience_id=new_id(),
            recorded_at=utcnow(),
            query=query,
            answer=answer,
            outcome=outcome or "unknown",
            source=source or "cli",
            tags=tuple(tags),
            metadata=dict(metadata or {}),
        )
        self.store.insert_experience(experience)
        self.store.append_event(
            "experience_recorded",
            payload={"experience_id": experience.experience_id, "outcome": experience.outcome},
        )
        return experience

    def recent(self, limit: int = 20) -> list[Experience]:
        return self.store.list_experiences(limit=limit, newest_first=True)

    def count(self) -> int:
        return self.store.count_experiences()

    def outcome_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for experience in self.store.list_experiences():
            counts[experience.outcome] = counts.get(experience.outcome, 0) + 1
        return counts

    def feedback_digest(self, limit: int = 8) -> str:
        """A short text summary of recent non-kept experiences.

        Passed to mutation providers as public context. Only experiences the
        resident itself recorded are included; holdout material is never loaded
        into this process, so it cannot leak here.
        """

        interesting = [
            experience
            for experience in self.recent(limit=limit * 4)
            if experience.outcome in ("edited", "discarded")
        ][:limit]
        if not interesting:
            return ""
        lines = [
            f"- [{experience.outcome}] {experience.query.strip()[:160]}"
            for experience in interesting
        ]
        return "Recent unsatisfactory interactions:\n" + "\n".join(lines)

"""Candidate lifecycle states and the legal transitions between them.

    proposed ──gate pass──> shadow ──promote──> champion ──promote──> superseded
        │                     │                     │
        └──gate fail──> rejected                    └──rollback──> rolled_back

    superseded ──rollback──> champion

Every transition is recorded immutably and names what authorized it: a gate
verdict id, a rollback's motivating evidence, or the seed bootstrap.

``canary`` sits between ``shadow`` and ``champion`` and now has a reader: the
serving process routes a deterministic slice of traffic to it. It was
deliberately absent until that reader existed, because a recorded state with a
pointer nothing reads gets mistaken for a working traffic split.
"""

from __future__ import annotations

from typing import Any

PROPOSED = "proposed"
SHADOW = "shadow"
CANARY = "canary"
CHAMPION = "champion"
SUPERSEDED = "superseded"
ROLLED_BACK = "rolled_back"
REJECTED = "rejected"

STATES = frozenset(
    {PROPOSED, SHADOW, CANARY, CHAMPION, SUPERSEDED, ROLLED_BACK, REJECTED}
)

#: ``None`` is the pre-state of a candidate that has just been archived.
LEGAL_TRANSITIONS: dict[str | None, frozenset[str]] = {
    None: frozenset({PROPOSED}),
    PROPOSED: frozenset({SHADOW, REJECTED}),
    SHADOW: frozenset({CANARY, CHAMPION, REJECTED}),
    # A canary serves a slice; it is not champion. Clearing it is a demotion of
    # something that was never promoted, which is why that one step may happen
    # automatically while promotion stays human-invoked.
    CANARY: frozenset({CHAMPION, REJECTED}),
    CHAMPION: frozenset({SUPERSEDED, ROLLED_BACK}),
    # A superseded candidate can be restored: that is what rollback does.
    SUPERSEDED: frozenset({CHAMPION}),
    # Terminal. Something was rolled back *away from*; making it champion again
    # would discard the reason it was reverted. A new attempt is a new candidate.
    ROLLED_BACK: frozenset(),
    REJECTED: frozenset(),
}

#: Reasons a transition may be authorized by, beyond a gate verdict id.
AUTHORITY_SEED_BOOTSTRAP = "seed_bootstrap"
AUTHORITY_ROLLBACK = "rollback"
AUTHORITY_CANARY_ACTIVATION = "canary_activation"
AUTHORITY_CANARY_AUTO_REVERT = "canary_auto_revert"


class IllegalTransitionError(ValueError):
    """Raised when a transition is not in the table. Nothing is persisted."""


def is_legal(from_state: str | None, to_state: str) -> bool:
    return to_state in LEGAL_TRANSITIONS.get(from_state, frozenset())


def require_legal(from_state: str | None, to_state: str, candidate_id: str) -> None:
    if to_state not in STATES:
        raise IllegalTransitionError(f"Unknown state {to_state!r}.")
    if not is_legal(from_state, to_state):
        allowed = sorted(LEGAL_TRANSITIONS.get(from_state, frozenset()))
        raise IllegalTransitionError(
            f"Candidate {candidate_id!r} cannot move {from_state!r} -> {to_state!r}. "
            f"Legal from {from_state!r}: {allowed or '(terminal)'}."
        )

"""Candidate lifecycle states and the legal transitions between them.

    proposed ──gate pass──> shadow ──promote──> champion ──promote──> superseded
        │                     │                     │
        └──gate fail──> rejected                    └──rollback──> rolled_back

    superseded ──rollback──> champion

Every transition is recorded immutably and names what authorized it: a gate
verdict id, a rollback's motivating evidence, or the seed bootstrap.

**Canary is deliberately absent.** It has no meaning until a serving path
exists — a recorded state with a pointer nothing reads is the kind of
aspirational surface that later gets mistaken for a working traffic split.
Phase 4 inserts it between ``shadow`` and ``champion`` by adding ``CANARY`` to
``LEGAL_TRANSITIONS[SHADOW]`` and a ``CANARY -> CHAMPION`` entry; no existing
transition changes.
"""

from __future__ import annotations

from typing import Any

PROPOSED = "proposed"
SHADOW = "shadow"
CHAMPION = "champion"
SUPERSEDED = "superseded"
ROLLED_BACK = "rolled_back"
REJECTED = "rejected"

STATES = frozenset({PROPOSED, SHADOW, CHAMPION, SUPERSEDED, ROLLED_BACK, REJECTED})

#: ``None`` is the pre-state of a candidate that has just been archived.
LEGAL_TRANSITIONS: dict[str | None, frozenset[str]] = {
    None: frozenset({PROPOSED}),
    PROPOSED: frozenset({SHADOW, REJECTED}),
    # Phase 4 adds CANARY here.
    SHADOW: frozenset({CHAMPION, REJECTED}),
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

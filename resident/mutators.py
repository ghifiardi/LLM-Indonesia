"""Candidate generation for the resident loop.

The existing ``MutationProvider`` implementations speak the ``GodelAgent``
protocol: given a ``SelfState`` they return a *list* of actions, any number of
which may be ``self_update``. The resident needs something narrower and
predictable — one attempt produces at most one candidate — so this module wraps
them rather than rewriting them.

Normalisation rules for provider output (deterministic, never raises):

* **zero** ``self_update`` actions -> no candidate. ``MutationProposal.code`` is
  None with a reason; the attempt is still archived.
* **one** -> that action's code and rationale.
* **many** -> the *first* one, in the order the provider returned them. The
  count of dropped alternatives is carried on the proposal and recorded in the
  verdict, so a provider quietly emitting three candidates per cycle is visible
  in the archive instead of invisible.
* **provider raises** -> no candidate, with the exception text as the reason.

``self_update`` actions with empty or whitespace-only code do not count as
candidates; they are dropped before the rules above are applied.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from ..godel_agent import Action, MutationProvider, SelfState


@dataclass(frozen=True)
class MutationRequest:
    """Public context handed to a mutation provider.

    Everything here is public by construction. Holdout cases are never loaded
    into the resident process, so no field can carry private evaluation data.
    """

    parent_code: str
    cycle: int
    parent_score: float | None = None
    best_score: float | None = None
    feedback: str = ""
    history_tail: tuple[str, ...] = ()

    def to_self_state(self) -> SelfState:
        """Adapt to the ``GodelAgent`` view the existing providers expect.

        ``iteration`` is the resident cycle number, which is what lets the
        deterministic rule-based providers advance through their staged
        candidates across separate ``reflect-once`` invocations.
        """

        return SelfState(
            iteration=self.cycle,
            best_score=self.best_score if self.best_score is not None else float("-inf"),
            current_score=self.parent_score if self.parent_score is not None else float("-inf"),
            policy_code=self.parent_code,
            history_tail=tuple(self.history_tail),
            last_feedback=self.feedback,
        )


@dataclass(frozen=True)
class MutationProposal:
    """At most one candidate. ``code is None`` means the provider offered none."""

    origin: str
    code: str | None = None
    rationale: str = ""
    reason: str = ""
    dropped_alternatives: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def has_candidate(self) -> bool:
        return bool(self.code and self.code.strip())


class Mutator(Protocol):
    """What ``reflect_once`` needs from a candidate generator."""

    name: str

    def propose(self, request: MutationRequest) -> MutationProposal:
        ...


@dataclass
class MutationProviderAdapter(Mutator):
    """Adapt an existing ``MutationProvider`` to the resident's one-shot contract."""

    provider: MutationProvider
    name: str = "mutation-provider"

    def propose(self, request: MutationRequest) -> MutationProposal:
        state = request.to_self_state()
        try:
            actions = self.provider.propose_actions(state)
        except Exception as exc:
            # A failing provider is an ordinary outcome, not a crash: the
            # attempt gets archived with the failure recorded.
            return MutationProposal(
                origin=self.name,
                reason=f"provider raised {type(exc).__name__}: {exc}",
            )

        actions = list(actions or [])
        updates = [
            action
            for action in actions
            if isinstance(action, Action)
            and action.name == "self_update"
            and action.code
            and action.code.strip()
        ]
        thoughts = [
            action.rationale.strip()
            for action in actions
            if isinstance(action, Action) and action.name == "think" and action.rationale.strip()
        ]

        if not updates:
            return MutationProposal(
                origin=self.name,
                reason="provider returned no self_update action with code",
                metadata={"action_names": [a.name for a in actions if isinstance(a, Action)]},
            )

        chosen = updates[0]
        rationale = chosen.rationale.strip() or (thoughts[0] if thoughts else "")
        return MutationProposal(
            origin=self.name,
            code=chosen.code,
            rationale=rationale,
            dropped_alternatives=len(updates) - 1,
            metadata={"thoughts": thoughts[:3]},
        )


@dataclass
class StaticMutator(Mutator):
    """Deterministic generator over a fixed list of candidate sources.

    Used by tests and as an offline fallback. Cycle ``n`` yields entry ``n - 1``;
    past the end of the list it yields no candidate, which exercises the
    zero-candidate path.
    """

    candidates: list[str]
    name: str = "static"
    rationale: str = "static candidate"

    def propose(self, request: MutationRequest) -> MutationProposal:
        index = max(0, request.cycle - 1)
        if index >= len(self.candidates):
            return MutationProposal(
                origin=self.name,
                reason=f"static mutator exhausted at cycle {request.cycle}",
            )
        return MutationProposal(
            origin=self.name,
            code=self.candidates[index],
            rationale=f"{self.rationale} #{index + 1}",
        )

"""Rollback to the best safe ancestor of the current champion.

Bounded, not free: rolling back means returning to something this resident has
already stood behind, not jumping to whatever else happens to score well. An
unrelated candidate that never served is not a retreat.

Two things count as such a target, and both are needed:

* **champion history** — anything that has previously been champion. This is
  what "revert" ordinarily means, and it is the important one: a new champion
  need not descend from the one it replaced, so lineage alone would leave the
  system unable to return to the thing it was serving yesterday.
* **archive lineage** — strict ancestors of the current champion, which are the
  candidates it was derived from.

"Safe" is a conjunction, and every part must hold against the *current* dataset:
selectable, artifact verifies, and — where the environment has a holdout — a
current passing audit with zero safety failures. If nothing qualifies, rollback
refuses. Falling back to an unaudited or lower-safety candidate would be the
opposite of what a rollback is for.

Rollback remains available while frozen. It records the evidence that motivated
it, and it does **not** clear the freeze: unfreezing stays a separate, explicit,
id-checked act.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import states
from .anchors import resolve_anchors_dir
from .archive import CandidateArchive
from .freeze import active_freeze
from .gate import current_audit
from .models import Candidate, Champion
from .reflect import bound_environment, get_environment_spec
from .store import (
    CONFIG_DATASET_IDENTITY,
    ArtifactIntegrityError,
    ArtifactMissingError,
    ResidentError,
    ResidentStore,
    utcnow,
)

ROLLBACK_EVENT = "champion_rolled_back"


class RollbackError(ResidentError):
    """Raised when no safe ancestor exists, or rollback cannot proceed."""


@dataclass(frozen=True)
class AncestorAssessment:
    candidate: Candidate
    safe: bool
    reason: str


def rollback_target_ids(store: ResidentStore) -> list[str]:
    """Candidates eligible to be rolled back to, newest-served first.

    Previous champions come first because reverting to what was last served is
    the ordinary meaning of a rollback; the current champion's archive lineage
    follows.
    """

    champion = store.require_champion()
    ordered: list[str] = []

    def add(candidate_id: str | None) -> None:
        if candidate_id and candidate_id != champion.candidate_id and candidate_id not in ordered:
            ordered.append(candidate_id)

    # Champion history, most recently served first.
    for promotion in store.list_promotions():
        if promotion.get("state") == "finalized":
            add(promotion.get("candidate_id"))
            add(promotion.get("previous_candidate_id"))
    # Then the lineage the current champion was derived from, nearest first.
    for candidate_id in reversed(CandidateArchive(store).lineage(champion.candidate_id)):
        add(candidate_id)
    return ordered


def assess_ancestors(
    store: ResidentStore, anchors_dir: str | Path | None = None
) -> list[AncestorAssessment]:
    """Every rollback target, with why it does or does not qualify."""

    archive = CandidateArchive(store)
    dataset_identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY) or "{}")
    has_holdout = get_environment_spec(bound_environment(store)).has_holdout

    assessments: list[AncestorAssessment] = []
    for candidate_id in rollback_target_ids(store):
        candidate = archive.get(candidate_id)
        if candidate is None:
            continue
        assessments.append(_assess(store, candidate, dataset_identity, has_holdout))
    return assessments


def _assess(
    store: ResidentStore,
    candidate: Candidate,
    dataset_identity: dict[str, Any],
    has_holdout: bool,
) -> AncestorAssessment:
    if not candidate.is_selectable:
        return AncestorAssessment(candidate, False, f"not selectable ({candidate.verdict.status})")
    if candidate.artifact_hash is None:
        return AncestorAssessment(candidate, False, "no artifact")
    try:
        store.verify_artifact(candidate.artifact_hash)
    except (ArtifactMissingError, ArtifactIntegrityError) as exc:
        return AncestorAssessment(candidate, False, f"artifact unusable: {exc}")
    if store.candidate_state(candidate.candidate_id) == states.ROLLED_BACK:
        return AncestorAssessment(
            candidate, False, "already rolled back away from; restoring it would discard that"
        )
    if has_holdout:
        audit = current_audit(
            store, candidate.candidate_id, candidate.artifact_hash, dataset_identity
        )
        if audit is None:
            return AncestorAssessment(
                candidate, False, "no current passing audit against the present dataset"
            )
        if audit.safety_failure_count != 0:
            return AncestorAssessment(
                candidate, False, f"{audit.safety_failure_count} holdout safety failure(s)"
            )
    return AncestorAssessment(candidate, True, "")


def best_safe_ancestor(
    store: ResidentStore, anchors_dir: str | Path | None = None
) -> Candidate | None:
    safe = [a.candidate for a in assess_ancestors(store, anchors_dir) if a.safe]
    scored = [c for c in safe if c.public_score is not None]
    if not scored:
        return None
    return max(scored, key=lambda c: (c.public_score, -c.seq))


def rollback(
    store: ResidentStore,
    reason: str,
    actor: str = "",
    anchors_dir: str | Path | None = None,
    target_candidate_id: str | None = None,
) -> Champion:
    """Revert the champion to its best safe ancestor. Available while frozen."""

    if not reason.strip():
        raise RollbackError("A rollback must record a reason.")

    champion = store.require_champion()
    archive = CandidateArchive(store)
    assessments = assess_ancestors(store, anchors_dir)

    if target_candidate_id is not None:
        chosen = next(
            (a.candidate for a in assessments if a.candidate.candidate_id == target_candidate_id),
            None,
        )
        if chosen is None:
            raise RollbackError(
                f"Candidate {target_candidate_id!r} is not a rollback target: it has never "
                "been champion and is not an ancestor of the current one."
            )
        assessment = next(a for a in assessments if a.candidate.candidate_id == target_candidate_id)
        if not assessment.safe:
            raise RollbackError(
                f"Candidate {target_candidate_id!r} is not a safe rollback target: "
                f"{assessment.reason}."
            )
    else:
        chosen = best_safe_ancestor(store, anchors_dir)

    if chosen is None:
        rejected = "; ".join(
            f"{a.candidate.candidate_id[:12]}: {a.reason}" for a in assessments if not a.safe
        )
        raise RollbackError(
            "No safe rollback target. Refusing rather than reverting to an unaudited "
            "or lower-safety candidate. "
            + (
                f"Considered — {rejected}."
                if rejected
                else "The champion has no predecessors or ancestors."
            )
        )

    freeze_record = active_freeze(store)
    evidence: dict[str, Any] = {
        "reason": reason,
        "from_candidate_id": champion.candidate_id,
        "to_candidate_id": chosen.candidate_id,
    }
    if freeze_record is not None:
        evidence["freeze_id"] = freeze_record.freeze_id
        evidence["freeze_reason"] = freeze_record.reason
        evidence["freeze_trigger"] = freeze_record.trigger

    # Same recoverable protocol as promotion: intent, atomic pointer, finalize.
    promotion_id = store.begin_promotion(
        candidate_id=chosen.candidate_id,
        artifact_hash=chosen.artifact_hash or "",
        previous_candidate_id=champion.candidate_id,
        reason=f"rollback: {reason}",
        actor=actor,
    )
    store.append_event(
        "promotion_intended",
        candidate_id=chosen.candidate_id,
        payload={"promotion_id": promotion_id, "rollback": True, **evidence},
    )
    new_champion = Champion(
        candidate_id=chosen.candidate_id,
        artifact_hash=chosen.artifact_hash or "",
        promoted_at=utcnow(),
        promotion_id=promotion_id,
        reason=f"rollback: {reason}",
        actor=actor,
        previous_candidate_id=champion.candidate_id,
    )
    store.write_champion(new_champion)
    store.finalize_promotion(promotion_id, note="rolled back")

    from .promote import _record_transition

    outgoing = archive.get(champion.candidate_id)
    if outgoing is not None:
        _record_transition(
            store, outgoing, states.ROLLED_BACK, states.AUTHORITY_ROLLBACK, evidence=evidence
        )
    _record_transition(
        store, chosen, states.CHAMPION, states.AUTHORITY_ROLLBACK, evidence=evidence
    )
    store.append_event(ROLLBACK_EVENT, candidate_id=chosen.candidate_id, payload=evidence)
    # Deliberately does not clear any active freeze: retreating and declaring
    # the problem understood are different decisions.
    return new_champion

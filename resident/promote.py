"""Champion transitions: bootstrap and human-invoked promotion.

Promotion is the only operation that changes what the resident serves, and in
Phase 1 it happens only when a person runs the command. There is no automatic
path — not behind a flag, not behind a config key. ``reflect.py`` does not
import this module.

Disk and database access all go through ``store``; this module orchestrates the
protocol and owns none of the I/O.

The protocol is recoverable at every interruption point:

1. **intent** — insert a ``promotions`` row in state ``intended`` (committed).
2. **pointer** — atomically replace ``state/champion.json``, stamped with this
   promotion's id.
3. **finalize** — mark the row ``finalized`` (committed).

A crash between 1 and 2 leaves a pending row whose id the pointer does not
carry, so recovery abandons it and the previous champion stands. A crash
between 2 and 3 leaves a pending row whose id the pointer *does* carry, so
recovery finalizes it and the new champion stands. A crash after 3 leaves
nothing pending. Recovery runs on every ``ResidentStore.open`` and is a pure
function of the pointer's contents, so repeating it is a no-op.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .anchors import resolve_anchors_dir

from ..godel_agent import SafePolicyLoader
from .anchors import ThresholdError, load_thresholds
from .archive import CandidateArchive
from . import states
from .gate import INTRINSIC_VETOES, GateVerdict, evaluate_gate
from .models import (
    Candidate,
    Champion,
    STATUS_SEED,
    TIER_POLICY,
    Verdict,
)
from .reflect import (
    DEFAULT_ENVIRONMENT,
    evaluate_policy_source,
    get_environment_spec,
)
from .anchors import resolve_anchors_dir
from .runner import CandidateRunner, RunnerLimits
from .store import (
    CONFIG_DATASET_IDENTITY,
    CONFIG_ENVIRONMENT,
    CONFIG_THRESHOLD_IDENTITY,
    EnvironmentMismatchError,
    ResidentError,
    ResidentStore,
    new_id,
    utcnow,
)


class PromotionError(ResidentError):
    """Raised when a promotion is refused before any state is changed."""


class AlreadyInitializedError(ResidentError):
    """Raised when ``init`` runs against a state directory that has a champion."""


#: Test-only interruption points for ``promote``. Passing one of these stops the
#: protocol partway and returns None, so tests can reopen the store and assert
#: that recovery converges. Never set from production code paths.
STOP_AFTER_INTENT = "intent"
STOP_AFTER_POINTER = "pointer"
STOP_POINTS = (STOP_AFTER_INTENT, STOP_AFTER_POINTER)


def promote(
    store: ResidentStore,
    candidate_id: str,
    reason: str = "",
    actor: str = "",
    verify_loadable: bool = True,
    stop_after: str | None = None,
    gate_verdict: GateVerdict | None = None,
    gate_verdict_id: str | None = None,
    anchors_dir: str | None = None,
    skip_gate: bool = False,
    runner: CandidateRunner | None = None,
    limits: RunnerLimits | None = None,
) -> Champion | None:
    """Make an archived candidate the champion. Human-invoked only.

    Refuses, before changing anything, when the candidate is unknown, has no
    artifact, carries a rejected verdict, fails its integrity check, or no
    longer passes the sandbox gate. Returns None only when ``stop_after`` was
    given.
    """

    if stop_after is not None and stop_after not in STOP_POINTS:
        raise ValueError(f"stop_after must be one of {STOP_POINTS} or None, got {stop_after!r}")

    archive = CandidateArchive(store)
    candidate = archive.get(candidate_id)
    if candidate is None:
        raise PromotionError(f"No candidate {candidate_id!r} in the archive.")
    if candidate.artifact_hash is None:
        if store.candidate_state(candidate.candidate_id) in (states.PROPOSED, states.SHADOW):
            _record_transition(
                store,
                candidate,
                states.REJECTED,
                "reflection_verdict",
                evidence={"verdict_status": candidate.verdict.status, "reason": "no artifact"},
            )
        raise PromotionError(
            f"Candidate {candidate_id!r} has no artifact "
            f"(status {candidate.verdict.status}); there is nothing to promote."
        )
    if not candidate.is_selectable:
        # A rejected candidate's code can still be syntactically loadable — a
        # policy that made the environment raise, for instance. Loadable is not
        # the same as promotable, and only the verdict knows the difference.
        #
        # Retire it here so the state machine agrees with the verdict: the
        # candidate never reaches the gate, so nothing downstream would
        # otherwise record what its verdict already established.
        if store.candidate_state(candidate.candidate_id) in (states.PROPOSED, states.SHADOW):
            _record_transition(
                store,
                candidate,
                states.REJECTED,
                "reflection_verdict",
                evidence={"verdict_status": candidate.verdict.status},
            )
        raise PromotionError(
            f"Candidate {candidate_id!r} is not promotable "
            f"(status {candidate.verdict.status})."
        )

    # Fails closed on a tampered or missing artifact.
    code = store.read_artifact(candidate.artifact_hash)

    if verify_loadable:
        try:
            SafePolicyLoader().load(code)
        except Exception as exc:
            raise PromotionError(
                f"Candidate {candidate_id!r} no longer passes the sandbox gate: {exc}"
            ) from exc

    previous = store.read_champion()
    previous_candidate_id = previous.candidate_id if previous is not None else None
    if previous is not None and previous.candidate_id == candidate_id:
        raise PromotionError(f"Candidate {candidate_id!r} is already the champion.")

    # The gate runs before anything is changed. ``skip_gate`` exists for the
    # seed bootstrap only, where there is no incumbent to compare against.
    authority = states.AUTHORITY_SEED_BOOTSTRAP
    if not skip_gate:
        verdict = _resolve_gate_verdict(
            store,
            candidate,
            previous,
            gate_verdict=gate_verdict,
            gate_verdict_id=gate_verdict_id,
            anchors_dir=anchors_dir,
            runner=runner,
            limits=limits,
        )
        if not verdict.passed:
            # Only an intrinsic failure retires the candidate. A missing audit
            # or a swapped threshold file is fixable, and marking such a
            # candidate terminal would discard work over a recoverable problem.
            intrinsic = [v for v in verdict.failures() if v.name in INTRINSIC_VETOES]
            if intrinsic and store.candidate_state(candidate.candidate_id) in (
                states.PROPOSED,
                states.SHADOW,
            ):
                _record_transition(
                    store,
                    candidate,
                    states.REJECTED,
                    verdict.gate_verdict_id,
                    evidence={"intrinsic_failures": [v.name for v in intrinsic]},
                )
            raise PromotionError(
                f"Gate refused candidate {candidate_id!r}: {verdict.failure_summary()}"
            )
        authority = verdict.gate_verdict_id
        # proposed -> shadow, authorised by this verdict.
        if store.candidate_state(candidate.candidate_id) == states.PROPOSED:
            _record_transition(store, candidate, states.SHADOW, verdict.gate_verdict_id)

    # Step 1: intent.
    promotion_id = store.begin_promotion(
        candidate_id=candidate.candidate_id,
        artifact_hash=candidate.artifact_hash,
        previous_candidate_id=previous_candidate_id,
        reason=reason,
        actor=actor,
    )
    store.append_event(
        "promotion_intended",
        candidate_id=candidate.candidate_id,
        payload={
            "promotion_id": promotion_id,
            "artifact_hash": candidate.artifact_hash,
            "previous_candidate_id": previous_candidate_id,
            "reason": reason,
            "actor": actor,
        },
    )
    if stop_after == STOP_AFTER_INTENT:
        return None

    # Step 2: atomic pointer swap.
    champion = Champion(
        candidate_id=candidate.candidate_id,
        artifact_hash=candidate.artifact_hash,
        promoted_at=utcnow(),
        promotion_id=promotion_id,
        reason=reason,
        actor=actor,
        previous_candidate_id=previous_candidate_id,
    )
    store.write_champion(champion)
    if stop_after == STOP_AFTER_POINTER:
        return None

    # Step 3: finalize.
    store.finalize_promotion(promotion_id, note="promoted")
    _record_transition(store, candidate, states.CHAMPION, authority)
    if previous is not None:
        previous_candidate = archive.get(previous.candidate_id)
        if previous_candidate is not None:
            _record_transition(store, previous_candidate, states.SUPERSEDED, authority)
    store.append_event(
        "promotion_finalized",
        candidate_id=candidate.candidate_id,
        payload={"promotion_id": promotion_id, "previous_candidate_id": previous_candidate_id},
    )
    return champion


def _record_transition(
    store: ResidentStore,
    candidate: Candidate,
    to_state: str,
    authorized_by: str,
    evidence: dict[str, Any] | None = None,
) -> None:
    """Validate against the transition table, then record it immutably."""

    current = store.candidate_state(candidate.candidate_id)
    states.require_legal(current, to_state, candidate.candidate_id)
    store.insert_state_transition(
        candidate_id=candidate.candidate_id,
        from_state=current,
        to_state=to_state,
        authorized_by=authorized_by,
        evidence=evidence,
    )


def _resolve_gate_verdict(
    store: ResidentStore,
    candidate: Candidate,
    previous: Champion | None,
    gate_verdict: GateVerdict | None,
    gate_verdict_id: str | None,
    anchors_dir: str | None,
    runner: CandidateRunner | None,
    limits: RunnerLimits | None,
) -> GateVerdict:
    """Return a verdict that is current for this exact comparison.

    A supplied verdict is checked for staleness rather than trusted: a pass is
    evidence about one candidate against one champion under one set of
    thresholds and one dataset, and if any of those moved the evidence no
    longer describes the promotion being attempted.
    """

    if gate_verdict is None and gate_verdict_id is not None:
        gate_verdict = store.get_gate_verdict(gate_verdict_id)
        if gate_verdict is None:
            raise PromotionError(f"No gate verdict {gate_verdict_id!r}.")

    if gate_verdict is None:
        return evaluate_gate(
            store,
            candidate.candidate_id,
            anchors_dir=anchors_dir,
            runner=runner,
            limits=limits,
        )

    dataset_identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY) or "{}")
    try:
        threshold_identity, _gate, _budget = load_thresholds(resolve_anchors_dir(anchors_dir))
        threshold_payload = threshold_identity.to_dict()
    except ThresholdError as exc:
        raise PromotionError(f"Gate thresholds are unusable: {exc}") from exc

    stale = gate_verdict.staleness_reason(
        champion_candidate_id=previous.candidate_id if previous else None,
        champion_artifact_hash=previous.artifact_hash if previous else None,
        dataset_identity=dataset_identity,
        threshold_identity=threshold_payload,
        artifact_hash=candidate.artifact_hash or "",
    )
    if stale:
        raise PromotionError(
            f"Gate verdict {gate_verdict.gate_verdict_id} is stale: {stale}. "
            "Re-run the gate."
        )
    return gate_verdict


def initialize(
    store: ResidentStore,
    env_name: str = DEFAULT_ENVIRONMENT,
    seed_policy: str | None = None,
    actor: str = "",
    force: bool = False,
    anchors_dir: str | None = None,
    runner: CandidateRunner | None = None,
    limits: RunnerLimits | None = None,
) -> tuple[Candidate, Champion]:
    """Establish the seed candidate and the first champion.

    Reflection selects a parent from the archive, so an archive with no scored
    candidate has nothing to reflect from. ``init`` fills that gap explicitly:
    it evaluates the seed policy for a real baseline score, archives it as a
    ``seed`` candidate, and promotes it through the ordinary protocol.

    A missing champion is never invented implicitly anywhere else — every other
    entry point raises ``ResidentNotInitializedError`` and points here.

    ``init`` also binds the state directory to one environment, and writes the
    public-only evaluation snapshot that reflection will read. ``--force``
    re-seeds within the bound environment; it never re-binds to a different one.
    """

    existing = store.read_champion()
    if existing is not None and not force:
        raise AlreadyInitializedError(
            f"{store.state_dir} already has champion {existing.candidate_id}. "
            "Pass --force to seed a new champion."
        )

    spec = get_environment_spec(env_name)
    already_bound = store.get_config(CONFIG_ENVIRONMENT)
    if already_bound is not None and already_bound != spec.name:
        raise EnvironmentMismatchError(
            f"{store.state_dir} is already bound to environment {already_bound!r}; "
            f"refusing to re-initialise it as {spec.name!r}, with or without --force. "
            "One state directory serves one task domain. Use a separate --state-dir."
        )

    code = seed_policy if seed_policy is not None else spec.seed_policy

    # Runs before anything is archived: this is the one path allowed to read the
    # source eval set, and it writes public cases only.
    resolved_anchors = resolve_anchors_dir(anchors_dir)
    identity = spec.prepare(store, resolved_anchors)
    if identity is not None:
        store.set_config(CONFIG_DATASET_IDENTITY, json.dumps(identity.to_dict(), sort_keys=True))

    # Threshold identity is recorded alongside dataset identity so the gate can
    # detect a later swap. A missing or invalid file fails init loudly rather
    # than leaving the gate unable to evaluate later.
    threshold_identity, _gate_thresholds, _budget_limits = load_thresholds(resolved_anchors)
    store.set_config(
        CONFIG_THRESHOLD_IDENTITY, json.dumps(threshold_identity.to_dict(), sort_keys=True)
    )
    outcome = evaluate_policy_source(store, spec, code, runner=runner, limits=limits)
    if outcome.scores is None:
        raise PromotionError(
            f"Seed policy for environment {spec.name!r} could not be evaluated "
            f"({outcome.status or 'no status'}): {outcome.error}"
        )
    scores = outcome.scores

    store.set_config(CONFIG_ENVIRONMENT, spec.name)
    artifact_hash = store.write_artifact(
        code, metadata={"kind": "seed", "environment": spec.name, "tier": TIER_POLICY}
    )
    archive = CandidateArchive(store)
    candidate = archive.add(
        verdict=Verdict(
            status=STATUS_SEED,
            detail=f"seed policy for environment {spec.name}",
            scores=scores,
            parent_score=None,
            delta=None,
            isolation=outcome.isolation.to_dict(),
        ),
        origin="seed",
        artifact_hash=artifact_hash,
        parent_candidate_id=None,
        rationale="initial champion established by `init`",
        tier=TIER_POLICY,
        cycle=0,
        record_state=False,
    )
    # The seed bypasses the gate: a gate compares a candidate against an
    # incumbent, and at init there is none. The bypass is recorded in the
    # transition log as `seed_bootstrap` rather than left implicit.
    _record_transition(store, candidate, states.PROPOSED, states.AUTHORITY_SEED_BOOTSTRAP)
    _record_transition(store, candidate, states.SHADOW, states.AUTHORITY_SEED_BOOTSTRAP)
    champion = promote(
        store,
        candidate.candidate_id,
        reason=f"initial seed champion for environment {spec.name}",
        actor=actor,
        skip_gate=True,
    )
    assert champion is not None  # no stop_after was passed
    store.append_event(
        "resident_initialized",
        candidate_id=candidate.candidate_id,
        payload={
            "environment": spec.name,
            "artifact_hash": artifact_hash,
            "public_score": scores.combined,
            "forced": force,
            "anchors_dir": str(resolved_anchors),
            "dataset_identity": identity.to_dict() if identity is not None else None,
        },
    )
    return candidate, champion

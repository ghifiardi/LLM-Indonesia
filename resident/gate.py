"""The promotion gate: immutable, single-use verdicts over a fixed veto set.

The gate decides whether a candidate *may* be promoted. It never promotes:
this module does not import ``promote``, and no scheduler calls it. Promotion
stays human-invoked until Phase 5.

Two properties the design leans on:

**Every veto is evaluated.** No short-circuit. A verdict records the result of
each veto including the ones that could not be evaluated, so a rejection
explains everything that was wrong rather than the first thing found.

**Not evaluable is a failure.** If a veto's inputs are missing — no audit, no
thresholds, an unreadable artifact — it records ``evaluable=False`` and fails.
A gate that passes because it could not check something is not a gate.

Verdicts are single-use. A pass is bound to the exact candidate artifact,
champion, dataset identity, and threshold identity in force when it was
produced; if any of those move, the verdict is stale and the gate must re-run.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..godel_agent import PolicyValidationError, SafePolicyLoader
from .anchors import (
    DatasetIdentity,
    GateThresholds,
    ThresholdError,
    ThresholdIdentity,
    load_thresholds,
    resolve_anchors_dir,
)
from .archive import CandidateArchive
from .models import (
    AUDIT_OK,
    AuditRecord,
    Candidate,
    SCORED_STATUSES,
    TIER_POLICY,
    TIER_PROMPT,
)
from .runner import RunnerLimits, SubprocessCandidateRunner
from .store import (
    CONFIG_DATASET_IDENTITY,
    CONFIG_THRESHOLD_IDENTITY,
    ArtifactIntegrityError,
    ArtifactMissingError,
    ResidentError,
    ResidentStore,
    new_id,
    utcnow,
)

GATE_SCHEMA_VERSION = 1

#: Phase 3 gates T0 and T1 only. T1 has no producer yet — no mutator emits
#: prompt candidates — so in practice everything gated today is T0. The tier is
#: still checked so a future producer cannot widen the gate by accident.
ALLOWED_TIERS = frozenset({TIER_POLICY, TIER_PROMPT})

VETO_TIER = "tier_allowed"
VETO_THRESHOLDS = "thresholds_valid"
VETO_ARTIFACT = "artifact_integrity"
VETO_ISOLATION = "isolated_execution"
VETO_PUBLIC_IMPROVEMENT = "public_improvement"
VETO_REPLAY = "replay_determinism"
VETO_AUDIT_CURRENCY = "audit_currency"
VETO_SAFETY_FLOOR = "safety_floor"
VETO_HOLDOUT = "holdout_no_regression"

#: Vetoes about the candidate itself, which no amount of running audits or
#: fixing thresholds can satisfy. Only these retire a candidate to `rejected`;
#: a failure on an environmental veto (a missing audit, a swapped threshold
#: file) leaves the candidate where it is, because it is fixable and the
#: immutable verdict already records what went wrong.
INTRINSIC_VETOES = frozenset({VETO_TIER, VETO_ARTIFACT, VETO_ISOLATION})

#: Order is presentation only; all are evaluated regardless.
VETO_NAMES = (
    VETO_TIER,
    VETO_THRESHOLDS,
    VETO_ARTIFACT,
    VETO_ISOLATION,
    VETO_AUDIT_CURRENCY,
    VETO_PUBLIC_IMPROVEMENT,
    VETO_REPLAY,
    VETO_SAFETY_FLOOR,
    VETO_HOLDOUT,
)


class GateError(ResidentError):
    """Raised when a gate evaluation cannot be attempted at all."""


@dataclass(frozen=True)
class VetoResult:
    """One condition's outcome.

    Three outcomes, and the difference between the last two matters:

    * evaluated and passed / failed;
    * ``evaluable=False`` — the check *should* have been possible but its
      inputs were missing. Always fails: a gate that passes because it could
      not check something is not a gate.
    * ``applicable=False`` — the condition does not exist for this task, as
      holdout regression does not exist for an environment with no holdout.
      Passes, and is recorded as inapplicable so a reader can see the gate was
      correspondingly narrower.
    """

    name: str
    passed: bool
    evaluable: bool = True
    applicable: bool = True
    detail: str = ""
    observed: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "evaluable": self.evaluable,
            "applicable": self.applicable,
            "detail": self.detail,
            "observed": dict(self.observed),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "VetoResult":
        return cls(
            name=payload["name"],
            passed=bool(payload["passed"]),
            evaluable=bool(payload.get("evaluable", True)),
            applicable=bool(payload.get("applicable", True)),
            detail=payload.get("detail", ""),
            observed=dict(payload.get("observed") or {}),
        )


def _not_evaluable(name: str, detail: str, **observed: Any) -> VetoResult:
    return VetoResult(name=name, passed=False, evaluable=False, detail=detail, observed=observed)


def _not_applicable(name: str, detail: str) -> VetoResult:
    return VetoResult(name=name, passed=True, applicable=False, detail=detail)


@dataclass(frozen=True)
class GateVerdict:
    """Immutable record of one gate evaluation."""

    gate_verdict_id: str
    created_at: str
    gate_schema_version: int
    candidate_id: str
    artifact_hash: str
    champion_candidate_id: str | None
    champion_artifact_hash: str | None
    dataset_identity: dict[str, Any]
    threshold_identity: dict[str, Any]
    vetoes: tuple[VetoResult, ...]
    passed: bool

    def failures(self) -> list[VetoResult]:
        return [veto for veto in self.vetoes if not veto.passed]

    def failure_summary(self) -> str:
        parts = [f"{veto.name}: {veto.detail}" for veto in self.failures()]
        return "; ".join(parts) if parts else "all conditions passed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_verdict_id": self.gate_verdict_id,
            "created_at": self.created_at,
            "gate_schema_version": self.gate_schema_version,
            "candidate_id": self.candidate_id,
            "artifact_hash": self.artifact_hash,
            "champion_candidate_id": self.champion_candidate_id,
            "champion_artifact_hash": self.champion_artifact_hash,
            "dataset_identity": dict(self.dataset_identity),
            "threshold_identity": dict(self.threshold_identity),
            "vetoes": [veto.to_dict() for veto in self.vetoes],
            "passed": self.passed,
        }

    def staleness_reason(
        self,
        champion_candidate_id: str | None,
        champion_artifact_hash: str | None,
        dataset_identity: dict[str, Any],
        threshold_identity: dict[str, Any],
        artifact_hash: str,
    ) -> str:
        """Why this verdict may no longer authorize a promotion; '' if current.

        A pass is evidence about a specific comparison. Change either side of
        that comparison and the evidence no longer describes it.
        """

        if self.artifact_hash != artifact_hash:
            return "the candidate artifact changed since this verdict"
        if self.champion_candidate_id != champion_candidate_id:
            return "the champion changed since this verdict"
        if self.champion_artifact_hash != champion_artifact_hash:
            return "the champion artifact changed since this verdict"
        if self.dataset_identity != dict(dataset_identity):
            return "the dataset identity changed since this verdict"
        if self.threshold_identity != dict(threshold_identity):
            return "the gate thresholds changed since this verdict"
        return ""


def current_audit(
    store: ResidentStore, candidate_id: str, artifact_hash: str, dataset_identity: dict[str, Any]
) -> AuditRecord | None:
    """The newest passing audit of this exact artifact against this dataset."""

    for record in store.list_audits(candidate_id=candidate_id):
        if (
            record.status == AUDIT_OK
            and record.artifact_hash == artifact_hash
            and record.dataset_identity == dict(dataset_identity)
        ):
            return record
    return None


def evaluate_gate(
    store: ResidentStore,
    candidate_id: str,
    anchors_dir: str | Path | None = None,
    runner: Any = None,
    limits: RunnerLimits | None = None,
    extra_vetoes: tuple[VetoResult, ...] = (),
) -> GateVerdict:
    """Evaluate every veto and archive an immutable verdict.

    ``extra_vetoes`` carries conditions owned by other modules (budget, freeze)
    so this module does not have to import them.
    """

    archive = CandidateArchive(store)
    candidate = archive.get(candidate_id)
    if candidate is None:
        raise GateError(f"No candidate {candidate_id!r} in the archive.")

    champion = store.read_champion()
    champion_candidate = (
        archive.get(champion.candidate_id) if champion is not None else None
    )

    dataset_identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY) or "{}")
    recorded_thresholds = store.get_config(CONFIG_THRESHOLD_IDENTITY)

    resolved_anchors = resolve_anchors_dir(anchors_dir)
    thresholds: GateThresholds | None = None
    threshold_identity: ThresholdIdentity | None = None
    threshold_error = ""
    try:
        threshold_identity, thresholds, _budget = load_thresholds(resolved_anchors)
    except ThresholdError as exc:
        threshold_error = str(exc)

    from .reflect import bound_environment, get_environment_spec

    try:
        has_holdout = get_environment_spec(bound_environment(store)).has_holdout
    except ResidentError:
        has_holdout = True  # fail toward requiring the checks, not skipping them

    vetoes: list[VetoResult] = []
    vetoes.append(_veto_tier(candidate))
    vetoes.append(
        _veto_thresholds(threshold_identity, threshold_error, recorded_thresholds)
    )
    artifact_veto, policy_source = _veto_artifact(store, candidate)
    vetoes.append(artifact_veto)
    vetoes.append(_veto_isolation(candidate))

    candidate_audit = (
        current_audit(store, candidate.candidate_id, candidate.artifact_hash or "", dataset_identity)
        if candidate.artifact_hash
        else None
    )
    champion_audit = (
        current_audit(
            store,
            champion_candidate.candidate_id,
            champion_candidate.artifact_hash or "",
            dataset_identity,
        )
        if champion_candidate is not None and champion_candidate.artifact_hash
        else None
    )
    vetoes.append(
        _veto_audit_currency(
            candidate, champion_candidate, candidate_audit, champion_audit, has_holdout
        )
    )
    vetoes.append(_veto_public_improvement(candidate, champion_candidate, thresholds))
    vetoes.append(
        _veto_replay(store, candidate, policy_source, thresholds, runner, limits)
    )
    vetoes.append(_veto_safety_floor(candidate_audit, thresholds, has_holdout))
    vetoes.append(_veto_holdout(candidate_audit, champion_audit, thresholds, has_holdout))
    vetoes.extend(extra_vetoes)

    verdict = GateVerdict(
        gate_verdict_id=new_id(),
        created_at=utcnow(),
        gate_schema_version=GATE_SCHEMA_VERSION,
        candidate_id=candidate.candidate_id,
        artifact_hash=candidate.artifact_hash or "",
        champion_candidate_id=champion.candidate_id if champion else None,
        champion_artifact_hash=champion.artifact_hash if champion else None,
        dataset_identity=dataset_identity,
        threshold_identity=(
            threshold_identity.to_dict() if threshold_identity is not None else {}
        ),
        vetoes=tuple(vetoes),
        passed=all(veto.passed for veto in vetoes),
    )
    store.insert_gate_verdict(verdict)
    store.append_event(
        "gate_evaluated",
        candidate_id=candidate.candidate_id,
        payload={
            "gate_verdict_id": verdict.gate_verdict_id,
            "passed": verdict.passed,
            "failed": [veto.name for veto in verdict.failures()],
        },
    )
    return verdict


# --- individual vetoes ------------------------------------------------------


def _veto_tier(candidate: Candidate) -> VetoResult:
    ok = candidate.tier in ALLOWED_TIERS
    return VetoResult(
        name=VETO_TIER,
        passed=ok,
        detail="" if ok else f"tier {candidate.tier!r} is not gated in this phase",
        observed={"tier": candidate.tier},
    )


def _veto_thresholds(
    identity: ThresholdIdentity | None, error: str, recorded: str | None
) -> VetoResult:
    if identity is None:
        return _not_evaluable(VETO_THRESHOLDS, error or "thresholds could not be loaded")
    if not recorded:
        return _not_evaluable(
            VETO_THRESHOLDS,
            "no threshold identity was recorded at init; re-run init against the anchor source",
        )
    try:
        expected = ThresholdIdentity.from_dict(json.loads(recorded))
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        return _not_evaluable(VETO_THRESHOLDS, f"recorded threshold identity is unreadable: {exc}")
    field_name = expected.mismatch_field(identity)
    if field_name is not None:
        return VetoResult(
            name=VETO_THRESHOLDS,
            passed=False,
            detail=(
                f"gate thresholds changed since init ({field_name}); "
                "re-init against the anchor source to adopt them deliberately"
            ),
            observed={"mismatch_field": field_name},
        )
    return VetoResult(name=VETO_THRESHOLDS, passed=True, observed={"gate_hash": identity.gate_hash})


def _veto_artifact(store: ResidentStore, candidate: Candidate) -> tuple[VetoResult, str]:
    if candidate.artifact_hash is None:
        return _not_evaluable(VETO_ARTIFACT, "candidate has no artifact"), ""
    try:
        source = store.read_artifact(candidate.artifact_hash)
    except (ArtifactMissingError, ArtifactIntegrityError) as exc:
        return _not_evaluable(VETO_ARTIFACT, str(exc)), ""
    try:
        SafePolicyLoader().load(source)
    except PolicyValidationError as exc:
        return (
            VetoResult(
                name=VETO_ARTIFACT,
                passed=False,
                detail=f"artifact no longer passes the sandbox gate: {exc}",
            ),
            source,
        )
    return VetoResult(name=VETO_ARTIFACT, passed=True), source


def _veto_isolation(candidate: Candidate) -> VetoResult:
    profile = candidate.verdict.isolation or {}
    if not profile:
        return _not_evaluable(VETO_ISOLATION, "candidate verdict records no isolation profile")
    executed = profile.get("executed")
    isolated = profile.get("process_isolated")
    if executed is not True:
        return VetoResult(
            name=VETO_ISOLATION,
            passed=False,
            detail="candidate was never executed; its score is not evidence of anything",
            observed={"executed": executed},
        )
    if isolated is not True:
        return VetoResult(
            name=VETO_ISOLATION,
            passed=False,
            detail="candidate was scored without process isolation",
            observed={"process_isolated": isolated},
        )
    return VetoResult(name=VETO_ISOLATION, passed=True, observed={"mechanism": profile.get("mechanism")})


def _veto_audit_currency(
    candidate: Candidate,
    champion: Candidate | None,
    candidate_audit: AuditRecord | None,
    champion_audit: AuditRecord | None,
    has_holdout: bool,
) -> VetoResult:
    """Both sides of the holdout comparison need a current passing audit.

    The message names exactly what to audit: an operator should not have to
    guess which artifact is missing evidence.
    """

    if not has_holdout:
        return _not_applicable(VETO_AUDIT_CURRENCY, "this environment has no holdout")
    missing: list[str] = []
    if candidate_audit is None:
        missing.append(f"candidate {candidate.candidate_id}")
    if champion is None:
        return _not_evaluable(VETO_AUDIT_CURRENCY, "there is no champion to compare against")
    if champion_audit is None:
        missing.append(f"champion {champion.candidate_id}")
    if missing:
        targets = " and ".join(missing)
        commands = " ".join(
            f"`resident audit {part.split()[-1]}`" for part in missing
        )
        return _not_evaluable(
            VETO_AUDIT_CURRENCY,
            f"no current passing holdout audit for {targets}; run {commands}",
            missing=[part.split()[-1] for part in missing],
        )
    return VetoResult(
        name=VETO_AUDIT_CURRENCY,
        passed=True,
        observed={
            "candidate_audit": candidate_audit.audit_run_id,
            "champion_audit": champion_audit.audit_run_id,
        },
    )


def _veto_public_improvement(
    candidate: Candidate, champion: Candidate | None, thresholds: GateThresholds | None
) -> VetoResult:
    if thresholds is None:
        return _not_evaluable(VETO_PUBLIC_IMPROVEMENT, "thresholds unavailable")
    if candidate.verdict.status not in SCORED_STATUSES or candidate.public_score is None:
        return _not_evaluable(
            VETO_PUBLIC_IMPROVEMENT,
            f"candidate has no public score (status {candidate.verdict.status})",
        )
    if champion is None or champion.public_score is None:
        return _not_evaluable(VETO_PUBLIC_IMPROVEMENT, "champion has no public score to beat")
    delta = candidate.public_score - champion.public_score
    ok = delta >= thresholds.min_public_delta
    return VetoResult(
        name=VETO_PUBLIC_IMPROVEMENT,
        passed=ok,
        detail=(
            ""
            if ok
            else f"public delta {delta:+.6f} is below the required {thresholds.min_public_delta:+.6f}"
        ),
        observed={
            "candidate_public": candidate.public_score,
            "champion_public": champion.public_score,
            "delta": delta,
        },
    )


def _veto_replay(
    store: ResidentStore,
    candidate: Candidate,
    policy_source: str,
    thresholds: GateThresholds | None,
    runner: Any,
    limits: RunnerLimits | None,
) -> VetoResult:
    """Re-run the candidate's public evaluation and require the score to reproduce.

    This occupies the slot the original design gave to judge agreement. There
    are no judges at T0/T1 — the rubric is deterministic Python — so rather than
    fake one, this checks the property that mattered: that the archived score
    is reproducible. Nondeterministic candidates and archive/score drift both
    fail here. Judge agreement returns at T4, where rubric extensions exist.

    A replay that times out, crashes, or violates the worker protocol is a veto
    failure, not an exception.
    """

    if thresholds is None:
        return _not_evaluable(VETO_REPLAY, "thresholds unavailable")
    if not policy_source:
        return _not_evaluable(VETO_REPLAY, "candidate artifact could not be read")
    if candidate.public_score is None:
        return _not_evaluable(VETO_REPLAY, "candidate has no archived score to reproduce")

    from .reflect import bound_environment, get_environment_spec

    limits = limits or RunnerLimits()
    runner = runner if runner is not None else SubprocessCandidateRunner(limits=limits)
    try:
        spec = get_environment_spec(bound_environment(store))
        snapshot = spec.read_records(store)
    except ResidentError as exc:
        return _not_evaluable(VETO_REPLAY, f"environment unavailable: {exc}")

    outcome = runner.evaluate(
        policy_source=policy_source,
        environment_name=spec.name,
        public_snapshot=snapshot,
        limits=limits,
    )
    if outcome.scores is None:
        return VetoResult(
            name=VETO_REPLAY,
            passed=False,
            evaluable=False,
            detail=f"replay did not produce a score ({outcome.status}): {outcome.error}"[:400],
            observed={"replay_status": outcome.status},
        )
    replayed = outcome.scores.combined
    delta = abs(replayed - candidate.public_score)
    ok = delta <= thresholds.replay_epsilon
    return VetoResult(
        name=VETO_REPLAY,
        passed=ok,
        detail=(
            ""
            if ok
            else (
                f"replayed public score {replayed:.9f} differs from the archived "
                f"{candidate.public_score:.9f} by {delta:.9f}"
            )
        ),
        observed={
            "archived_public": candidate.public_score,
            "replayed_public": replayed,
            "delta": delta,
        },
    )


def _veto_safety_floor(
    candidate_audit: AuditRecord | None,
    thresholds: GateThresholds | None,
    has_holdout: bool,
) -> VetoResult:
    if not has_holdout:
        return _not_applicable(VETO_SAFETY_FLOOR, "this environment has no holdout")
    if thresholds is None:
        return _not_evaluable(VETO_SAFETY_FLOOR, "thresholds unavailable")
    if candidate_audit is None:
        return _not_evaluable(VETO_SAFETY_FLOOR, "no current passing holdout audit for the candidate")
    failures = candidate_audit.safety_failure_count
    ok = failures <= thresholds.max_safety_failures
    return VetoResult(
        name=VETO_SAFETY_FLOOR,
        passed=ok,
        detail=(
            ""
            if ok
            else f"{failures} holdout case(s) fell below the safety floor; {thresholds.max_safety_failures} permitted"
        ),
        observed={"safety_failure_count": failures},
    )


def _veto_holdout(
    candidate_audit: AuditRecord | None,
    champion_audit: AuditRecord | None,
    thresholds: GateThresholds | None,
    has_holdout: bool,
) -> VetoResult:
    if not has_holdout:
        return _not_applicable(VETO_HOLDOUT, "this environment has no holdout")
    if thresholds is None:
        return _not_evaluable(VETO_HOLDOUT, "thresholds unavailable")
    if candidate_audit is None or champion_audit is None:
        return _not_evaluable(VETO_HOLDOUT, "both candidate and champion need a current passing audit")
    if candidate_audit.holdout_score is None or champion_audit.holdout_score is None:
        return _not_evaluable(VETO_HOLDOUT, "an audit reported no holdout score")
    delta = candidate_audit.holdout_score - champion_audit.holdout_score
    ok = delta >= -thresholds.holdout_epsilon
    return VetoResult(
        name=VETO_HOLDOUT,
        passed=ok,
        detail=(
            ""
            if ok
            else f"holdout regressed by {-delta:.6f}, beyond the permitted {thresholds.holdout_epsilon:.6f}"
        ),
        observed={
            "candidate_holdout": candidate_audit.holdout_score,
            "champion_holdout": champion_audit.holdout_score,
            "delta": delta,
        },
    )

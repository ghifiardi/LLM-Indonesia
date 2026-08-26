"""Parent side of the holdout audit. Informational only.

Spawns the auditor controller, records what comes back, and stops. It does not
import ``promote``: an audit in Phase 2 tells a human something, it does not
gate anything. Using a holdout result as a promotion veto is Phase 3.

Nothing else in the resident reads audit rows. Parent selection, mutation,
experience feedback, and public improvement labels all remain functions of
public scores alone, so a holdout number cannot leak into the loop by way of a
decision it influenced.

This process never loads holdout data. It passes the *recorded* dataset
identity to the controller, which recomputes it independently and refuses on a
mismatch — so the parent verifies the anchor source without ever opening it.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from .anchors import (
    DatasetIdentity,
    is_development_anchor_location,
    resolve_anchors_dir,
)
from .archive import CandidateArchive
from .audit_protocol import (
    AuditProtocolError,
    MAX_AUDIT_RESPONSE_BYTES,
    REASON_AUDITOR_INTERNAL_FAILURE,
    REASON_PROTOCOL_FAILURE,
    build_audit_request,
    message_for,
    parse_audit_response,
)
from .models import AUDIT_FAILED, AuditRecord
from .reflect import bound_environment, get_environment_spec
from .runner.limits import RunnerLimits
from .runner.protocol import MAX_STDERR_BYTES, encode
from .runner.subprocess_runner import (
    _build_preexec,
    _minimal_environment,
    _read_capped,
    _terminate_group,
)
from .store import (
    CONFIG_DATASET_IDENTITY,
    ResidentError,
    ResidentStore,
    new_id,
    utcnow,
)

AUDITOR_MODULE = "godel_agent_prototype.resident.auditor_worker"

#: Environments that have a holdout to audit. A code task whose cases are
#: defined in source has none, and asking for one should say so plainly rather
#: than return an empty result that reads like a pass.
AUDITABLE_ENVIRONMENTS = frozenset({"id_support"})

AUDIT_EVENT = "holdout_audit"


class AuditError(ResidentError):
    """Raised when an audit cannot be attempted at all."""


@dataclass(frozen=True)
class AuditOutcome:
    record: AuditRecord
    anchors_dir: Path
    development_anchors: bool


def run_audit(
    store: ResidentStore,
    candidate_id: str,
    anchors_dir: str | Path | None = None,
    limits: RunnerLimits | None = None,
    timeout_seconds: float = 300.0,
) -> AuditOutcome:
    """Audit one archived candidate against the holdout. Human-invoked only."""

    environment_name = bound_environment(store)
    if environment_name not in AUDITABLE_ENVIRONMENTS:
        raise AuditError(
            f"Environment {environment_name!r} has no holdout to audit "
            f"(auditable: {', '.join(sorted(AUDITABLE_ENVIRONMENTS))})."
        )
    get_environment_spec(environment_name)

    archive = CandidateArchive(store)
    candidate = archive.get(candidate_id)
    if candidate is None:
        raise AuditError(f"No candidate {candidate_id!r} in the archive.")
    if candidate.artifact_hash is None:
        raise AuditError(
            f"Candidate {candidate_id!r} has no artifact (status "
            f"{candidate.verdict.status}); there is nothing to audit."
        )
    if not candidate.is_selectable:
        # Auditing a rejected candidate would produce a holdout number for code
        # that never earned a public score, which is not a comparison anyone can
        # use.
        raise AuditError(
            f"Candidate {candidate_id!r} is not auditable "
            f"(status {candidate.verdict.status})."
        )

    recorded_identity = store.get_config(CONFIG_DATASET_IDENTITY)
    if not recorded_identity:
        raise AuditError(
            "This state directory records no dataset identity, so an audit could "
            "not be checked against the dataset that produced the public "
            "snapshot. Re-run `init` with the anchor source."
        )
    expected = DatasetIdentity.from_dict(__import__("json").loads(recorded_identity))

    resolved_anchors = resolve_anchors_dir(anchors_dir)
    limits = limits or RunnerLimits()
    audit_run_id = new_id()

    # Verified artifact bytes, read through the store's integrity check.
    policy_source = store.read_artifact(candidate.artifact_hash)

    request = build_audit_request(
        audit_run_id=audit_run_id,
        candidate_id=candidate.candidate_id,
        artifact_hash=candidate.artifact_hash,
        policy_source=policy_source,
        environment_name=environment_name,
        anchors_dir=str(resolved_anchors),
        expected_identity=expected.to_dict(),
        limits=limits.to_dict(),
    )

    # Categories the parent already knows, from its own public snapshot. Used to
    # validate aggregate keys without ever consulting the anchor source.
    allowed_categories = {
        str(record.get("category", "general")) for record in store.read_public_snapshot()
    }

    raw_response, spawn_failed = _spawn_auditor(request, timeout_seconds, limits)

    if spawn_failed or raw_response is None:
        record = _failed_record(
            audit_run_id, candidate, REASON_AUDITOR_INTERNAL_FAILURE
        )
    else:
        try:
            validated = parse_audit_response(
                raw_response,
                expected_audit_run_id=audit_run_id,
                expected_candidate_id=candidate.candidate_id,
                expected_artifact_hash=candidate.artifact_hash,
                expected_identity=expected.to_dict(),
                allowed_categories=allowed_categories,
            )
        except AuditProtocolError:
            # Fails closed: a response that does not validate is discarded
            # entirely rather than partially believed.
            record = _failed_record(audit_run_id, candidate, REASON_PROTOCOL_FAILURE)
        else:
            reason_code = validated["reason_code"]
            record = AuditRecord(
                # Identifiers are the parent's own, never the wire's; the parser
                # has already refused any response that named different ones.
                audit_run_id=audit_run_id,
                candidate_id=candidate.candidate_id,
                artifact_hash=candidate.artifact_hash,
                created_at=utcnow(),
                status=validated["status"],
                holdout_score=validated["holdout_score"],
                num_cases=validated["num_cases"],
                safety_failure_count=validated["safety_failure_count"],
                category_means=validated["category_means"],
                dimension_means=validated["dimension_means"],
                dataset_identity=validated["dataset_identity"],
                isolation=validated["isolation"],
                reason_code=reason_code,
                detail=message_for(reason_code, validated["mismatch_field"]),
            )

    store.insert_audit(record)
    store.append_event(
        AUDIT_EVENT,
        candidate_id=candidate.candidate_id,
        payload={
            "audit_run_id": record.audit_run_id,
            "status": record.status,
            "holdout_score": record.holdout_score,
            "num_cases": record.num_cases,
        },
    )
    return AuditOutcome(
        record=record,
        anchors_dir=resolved_anchors,
        development_anchors=is_development_anchor_location(resolved_anchors),
    )


def _failed_record(audit_run_id: str, candidate: Any, reason_code: str) -> AuditRecord:
    """A failure record authored entirely on this side of the boundary."""

    return AuditRecord(
        audit_run_id=audit_run_id,
        candidate_id=candidate.candidate_id,
        artifact_hash=candidate.artifact_hash,
        created_at=utcnow(),
        status=AUDIT_FAILED,
        reason_code=reason_code,
        detail=message_for(reason_code),
    )


def _spawn_auditor(
    request: dict[str, Any], timeout_seconds: float, limits: RunnerLimits
) -> tuple[bytes | None, bool]:
    """Run the auditor controller. Returns (raw response bytes, spawn failed).

    Returns bytes rather than a parsed object: validation belongs to
    ``audit_protocol``, and nothing here should be in a position to interpret an
    auditor response leniently.
    """

    body = encode(request)
    with tempfile.TemporaryDirectory(prefix="resident-audit-") as capture_dir, \
            tempfile.TemporaryDirectory(prefix="resident-audit-work-") as work_dir:
        stdout_path = Path(capture_dir) / "stdout.bin"
        stderr_path = Path(capture_dir) / "stderr.bin"
        timed_out = False
        try:
            with open(stdout_path, "wb") as out_handle, open(stderr_path, "wb") as err_handle:
                try:
                    process = subprocess.Popen(
                        [sys.executable, "-s", "-B", "-m", AUDITOR_MODULE],
                        stdin=subprocess.PIPE,
                        stdout=out_handle,
                        stderr=err_handle,
                        cwd=str(work_dir),
                        env=_minimal_environment(),
                        close_fds=True,
                        start_new_session=True,
                        # The controller writes its own stdout/stderr files; a
                        # file-size limit stops a faulty one filling the
                        # temporary filesystem before the bounded read-back.
                        preexec_fn=_build_preexec(
                            replace(limits, cpu_seconds=0, address_space_bytes=None)
                        ),
                    )
                except (OSError, ValueError, subprocess.SubprocessError):
                    return None, True
                try:
                    process.communicate(body, timeout=timeout_seconds)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    _terminate_group(process, 2.0)
                except (BrokenPipeError, OSError):
                    _terminate_group(process, 2.0)
        except OSError:
            return None, True

        if timed_out:
            return None, True

        returncode = process.poll()
        stdout_bytes, overflow = _read_capped(stdout_path, MAX_AUDIT_RESPONSE_BYTES)
        # Read and discarded. Auditor stderr is inside the holdout boundary: it
        # is never parsed, never persisted, and never surfaced.
        _read_capped(stderr_path, MAX_STDERR_BYTES)
        if overflow or returncode != 0:
            return None, True
        return stdout_bytes, False

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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .anchors import (
    DatasetIdentity,
    is_development_anchor_location,
    resolve_anchors_dir,
)
from .archive import CandidateArchive
from .auditor_worker import build_audit_request, parse_audit_response
from .models import AUDIT_FAILED, AUDIT_REFUSED, AuditRecord
from .reflect import bound_environment, get_environment_spec
from .runner.limits import RunnerLimits
from .runner.protocol import (
    MAX_RESPONSE_BYTES,
    MAX_STDERR_BYTES,
    ProtocolError,
    encode,
)
from .runner.subprocess_runner import (
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

    response, failure_detail = _spawn_auditor(request, timeout_seconds)

    if response is None:
        record = AuditRecord(
            audit_run_id=audit_run_id,
            candidate_id=candidate.candidate_id,
            artifact_hash=candidate.artifact_hash,
            created_at=utcnow(),
            status=AUDIT_FAILED,
            detail=failure_detail,
        )
    else:
        record = AuditRecord(
            audit_run_id=response.get("audit_run_id") or audit_run_id,
            candidate_id=candidate.candidate_id,
            artifact_hash=candidate.artifact_hash,
            created_at=utcnow(),
            status=response.get("status") or AUDIT_REFUSED,
            holdout_score=response.get("holdout_score"),
            num_cases=int(response.get("num_cases") or 0),
            safety_failure_count=int(response.get("safety_failure_count") or 0),
            category_means=dict(response.get("category_means") or {}),
            dimension_means=dict(response.get("dimension_means") or {}),
            dataset_identity=dict(response.get("dataset_identity") or {}),
            isolation=dict(response.get("isolation") or {}),
            detail=str(response.get("detail") or "")[:600],
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


def _spawn_auditor(
    request: dict[str, Any], timeout_seconds: float
) -> tuple[dict[str, Any] | None, str]:
    """Run the auditor controller. Returns (response, failure detail)."""

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
                    )
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    return None, f"could not start auditor: {type(exc).__name__}: {exc}"
                try:
                    process.communicate(body, timeout=timeout_seconds)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    _terminate_group(process, 2.0)
                except (BrokenPipeError, OSError):
                    _terminate_group(process, 2.0)
        except OSError as exc:
            return None, f"could not open auditor capture files: {exc}"

        if timed_out:
            return None, f"auditor exceeded the {timeout_seconds}s timeout"

        returncode = process.poll()
        stdout_bytes, overflow = _read_capped(stdout_path, MAX_RESPONSE_BYTES)
        stderr_bytes, _ = _read_capped(stderr_path, MAX_STDERR_BYTES)
        if overflow:
            return None, "auditor response exceeded the size cap"
        if returncode != 0:
            # Deliberately does not include auditor stderr: that stream is
            # inside the holdout boundary and must not be copied into a record
            # the parent stores.
            return None, f"auditor exited with code {returncode}"
        try:
            return parse_audit_response(stdout_bytes), ""
        except ProtocolError as exc:
            return None, f"auditor protocol failure: {exc}"

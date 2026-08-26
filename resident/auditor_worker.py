"""Holdout auditor controller. Runs as its own process.

    python3 -m godel_agent_prototype.resident.auditor_worker

This is the *only* process that holds holdout labels, and it never executes
candidate code. Candidate code runs one level further down, in a child this
process spawns, which receives unlabeled inputs and nothing else:

    resident parent
        |  audit request (candidate id, artifact hash, policy source, anchors)
        v
    auditor controller          <- this module; owns queries, answers, rubric
        |  policy + unlabeled inputs only
        v
    candidate execution child   <- no answers, no required terms, no rubric
        |  bounded outputs
        v
    auditor controller          <- scores internally
        |  aggregate allowlist only
        v
    resident parent

Two boundaries, because one is not enough: a single process holding both the
answers and the untrusted code has nothing but good intentions between them.

The response schema lives in ``audit_protocol``, deliberately not here: the
code that decides what may cross a boundary should not be the code running
inside it.

Nothing this process composes as text reaches the parent. Outcomes are reported
as reason codes from a fixed enum, and the parent authors the human-readable
message itself. An allowlist of field names alone would not be enough — a
free-text field on the allowlist is an open channel, and holdout content placed
in it would cross and be persisted like any other string.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from ..dataset_env import DEFAULT_KB, score_answer
from .anchors import DatasetIdentity, load_anchor_split
from .audit_protocol import (
    AuditProtocolError,
    KIND_AUDIT,
    MAX_AUDIT_REQUEST_BYTES,
    REASON_ANCHOR_UNUSABLE,
    REASON_ARTIFACT_MISMATCH,
    REASON_AUDITOR_INTERNAL_FAILURE,
    REASON_CANDIDATE_PROTOCOL_FAILURE,
    REASON_CANDIDATE_RESOURCE_LIMIT,
    REASON_CANDIDATE_RUNNER_CRASH,
    REASON_CANDIDATE_TIMEOUT,
    REASON_IDENTITY_MISMATCH,
    REASON_OK,
    build_audit_response,
    parse_audit_request,
)
from .models import (
    AUDIT_FAILED,
    AUDIT_OK,
    AUDIT_REFUSED,
    STATUS_RESOURCE_LIMIT,
    STATUS_RUNNER_CRASH,
    STATUS_RUNNER_PROTOCOL,
    STATUS_TIMEOUT,
)
from .runner.limits import RunnerLimits
from .runner.protocol import encode
from .runner.subprocess_runner import SubprocessCandidateRunner
from .store import policy_digest


EXIT_OK = 0
EXIT_UNREADABLE_REQUEST = 4

#: Candidate-runner statuses mapped to audit reason codes. Anything unmapped
#: becomes a protocol failure rather than being described in prose.
_RUNNER_REASONS = {
    STATUS_TIMEOUT: REASON_CANDIDATE_TIMEOUT,
    STATUS_RESOURCE_LIMIT: REASON_CANDIDATE_RESOURCE_LIMIT,
    STATUS_RUNNER_CRASH: REASON_CANDIDATE_RUNNER_CRASH,
    STATUS_RUNNER_PROTOCOL: REASON_CANDIDATE_PROTOCOL_FAILURE,
}


def run_audit_in_controller(request: dict[str, Any]) -> dict[str, Any]:
    """Own the holdout, delegate execution, score internally, return aggregates."""

    audit_run_id = request["audit_run_id"]
    candidate_id = request["candidate_id"]
    artifact_hash = request["artifact_hash"]
    policy_source = request["policy_source"]
    limits = RunnerLimits.from_dict(request.get("limits") or {})

    def refuse(reason_code: str, mismatch_field: str | None = None) -> dict[str, Any]:
        return build_audit_response(
            status=AUDIT_REFUSED,
            reason_code=reason_code,
            audit_run_id=audit_run_id,
            candidate_id=candidate_id,
            artifact_hash=artifact_hash,
            mismatch_field=mismatch_field,
        )

    # The policy must be what the parent claims it is, independently of what the
    # parent checked. The offending hash is not reported: the reason code says
    # what happened, and an attacker-chosen digest is 64 characters of channel.
    if policy_digest(policy_source) != artifact_hash:
        return refuse(REASON_ARTIFACT_MISMATCH)

    expected = DatasetIdentity.from_dict(request["expected_identity"])
    try:
        identity, _public_cases, holdout_cases = load_anchor_split(
            request["anchors_dir"],
            holdout_fraction=expected.holdout_fraction,
            split_seed=expected.split_seed,
        )
    except (ValueError, OSError):
        # The exception text could quote dataset content, so it stays here.
        return refuse(REASON_ANCHOR_UNUSABLE)

    # Recomputed here, independently. A drifted anchor directory would make the
    # holdout number meaningless while still looking like a valid audit.
    mismatch_field = expected.mismatch_field(identity)
    if mismatch_field is not None:
        return refuse(REASON_IDENTITY_MISMATCH, mismatch_field)

    # Unlabeled inputs only. The answers, required terms, and rubric stay here.
    inputs = [case.query for case in holdout_cases]
    runner = SubprocessCandidateRunner(limits=limits)
    outcome = runner.execute_batch(
        policy_source=policy_source,
        artifact_hash=artifact_hash,
        inputs=inputs,
        kb=DEFAULT_KB,
        limits=limits,
    )
    isolation = outcome.isolation.to_dict()

    if not outcome.ok:
        return build_audit_response(
            status=AUDIT_FAILED,
            reason_code=_RUNNER_REASONS.get(outcome.status, REASON_CANDIDATE_PROTOCOL_FAILURE),
            audit_run_id=audit_run_id,
            candidate_id=candidate_id,
            artifact_hash=artifact_hash,
            isolation=isolation,
        )

    # Scoring happens here, where the labels are. Candidate outputs go no
    # further than this function's locals.
    total_weight = 0.0
    weighted = 0.0
    safety_failures = 0
    per_category: dict[str, list[float]] = {}
    per_dimension: dict[str, list[float]] = {}

    for case, answer in zip(holdout_cases, outcome.outputs or []):
        scored = score_answer(case, answer if isinstance(answer, str) else str(answer))
        weighted += scored["score"] * case.weight
        total_weight += case.weight
        per_category.setdefault(case.category, []).append(scored["score"])
        for name, value in scored["dimensions"].items():
            per_dimension.setdefault(name, []).append(value)
        if scored["dimensions"].get("safety", 1.0) < 1.0:
            safety_failures += 1

    combined = weighted / total_weight if total_weight else 0.0
    return build_audit_response(
        status=AUDIT_OK,
        reason_code=REASON_OK,
        audit_run_id=audit_run_id,
        candidate_id=candidate_id,
        artifact_hash=artifact_hash,
        holdout_score=combined,
        num_cases=len(holdout_cases),
        safety_failure_count=safety_failures,
        category_means={
            key: round(sum(v) / len(v), 4) for key, v in sorted(per_category.items())
        },
        dimension_means={
            key: round(sum(v) / len(v), 4) for key, v in sorted(per_dimension.items())
        },
        dataset_identity=identity.to_dict(),
        isolation=isolation,
    )


def main(argv: list[str] | None = None) -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_AUDIT_REQUEST_BYTES + 1)
    except OSError:
        return EXIT_UNREADABLE_REQUEST
    if len(raw) > MAX_AUDIT_REQUEST_BYTES:
        return EXIT_UNREADABLE_REQUEST
    try:
        request = parse_audit_request(raw)
    except AuditProtocolError as exc:
        sys.stderr.write(f"auditor protocol error: {exc}\n")
        return EXIT_UNREADABLE_REQUEST

    try:
        response = run_audit_in_controller(request)
    except Exception:
        # An internal failure is reported as a code, never as a traceback: a
        # traceback can quote dataset content.
        response = build_audit_response(
            status=AUDIT_FAILED,
            reason_code=REASON_AUDITOR_INTERNAL_FAILURE,
            audit_run_id=str(request.get("audit_run_id", "")),
            candidate_id=str(request.get("candidate_id", "")),
            artifact_hash=str(request.get("artifact_hash", "")),
        )
    sys.stdout.buffer.write(encode(response))
    sys.stdout.buffer.flush()
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())

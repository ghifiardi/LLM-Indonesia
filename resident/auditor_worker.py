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

The response is built field by field from a fixed allowlist rather than by
redacting a fuller object. Redaction fails open — anything a future edit adds
and forgets to strip escapes. An allowlist fails closed.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from ..dataset_env import DEFAULT_KB, score_answer
from .anchors import DatasetIdentity, load_anchor_split
from .models import AUDIT_FAILED, AUDIT_OK, AUDIT_REFUSED
from .runner.limits import RunnerLimits
from .runner.protocol import (
    MAX_REQUEST_BYTES,
    PROTOCOL_VERSION,
    ProtocolError,
    encode,
)
from .runner.subprocess_runner import SubprocessCandidateRunner
from .store import policy_digest


KIND_AUDIT = "audit"

EXIT_OK = 0
EXIT_UNREADABLE_REQUEST = 4

#: Exactly what may cross back to the resident parent. Anything not on this
#: list does not leave this process.
RESPONSE_ALLOWLIST = (
    "protocol_version",
    "kind",
    "ok",
    "audit_run_id",
    "candidate_id",
    "artifact_hash",
    "status",
    "holdout_score",
    "num_cases",
    "safety_failure_count",
    "category_means",
    "dimension_means",
    "dataset_identity",
    "isolation",
    "detail",
)


def build_audit_request(
    audit_run_id: str,
    candidate_id: str,
    artifact_hash: str,
    policy_source: str,
    environment_name: str,
    anchors_dir: str,
    expected_identity: dict[str, Any],
    limits: dict[str, Any],
) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_AUDIT,
        "audit_run_id": audit_run_id,
        "candidate_id": candidate_id,
        "artifact_hash": artifact_hash,
        "policy_source": policy_source,
        "environment_name": environment_name,
        "anchors_dir": anchors_dir,
        "expected_identity": expected_identity,
        "limits": limits,
    }


def _response(
    ok: bool,
    audit_run_id: str,
    candidate_id: str,
    artifact_hash: str,
    status: str,
    detail: str = "",
    holdout_score: float | None = None,
    num_cases: int = 0,
    safety_failure_count: int = 0,
    category_means: dict[str, float] | None = None,
    dimension_means: dict[str, float] | None = None,
    dataset_identity: dict[str, Any] | None = None,
    isolation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the response from the allowlist. Nothing else is reachable."""

    message = {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_AUDIT,
        "ok": ok,
        "audit_run_id": audit_run_id,
        "candidate_id": candidate_id,
        "artifact_hash": artifact_hash,
        "status": status,
        "holdout_score": holdout_score,
        "num_cases": num_cases,
        "safety_failure_count": safety_failure_count,
        "category_means": dict(category_means or {}),
        "dimension_means": dict(dimension_means or {}),
        "dataset_identity": dict(dataset_identity or {}),
        "isolation": dict(isolation or {}),
        # Free text, so it is truncated and must never be built from case
        # content. Callers here only ever pass runner statuses and identity
        # mismatch reasons.
        "detail": detail[:600],
    }
    return {key: message[key] for key in RESPONSE_ALLOWLIST}


def parse_audit_response(raw: bytes) -> dict[str, Any]:
    """Parent side: decode, validate, and drop anything off the allowlist."""

    if not raw.strip():
        raise ProtocolError("auditor produced no response")
    try:
        message = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"auditor response is not valid JSON: {exc}") from exc
    if not isinstance(message, dict):
        raise ProtocolError("auditor response is not a JSON object")
    if message.get("protocol_version") != PROTOCOL_VERSION:
        raise ProtocolError("auditor response protocol_version mismatch")
    if message.get("kind") != KIND_AUDIT:
        raise ProtocolError(f"unexpected auditor response kind {message.get('kind')!r}")
    # Second allowlist pass on the receiving side: a compromised or simply
    # buggy auditor cannot widen the channel by adding fields.
    return {key: message.get(key) for key in RESPONSE_ALLOWLIST if key in message}


def run_audit_in_controller(request: dict[str, Any]) -> dict[str, Any]:
    """Own the holdout, delegate execution, score internally, return aggregates."""

    audit_run_id = request["audit_run_id"]
    candidate_id = request["candidate_id"]
    artifact_hash = request["artifact_hash"]
    policy_source = request["policy_source"]
    limits = RunnerLimits.from_dict(request.get("limits") or {})

    def refuse(detail: str, identity: dict[str, Any] | None = None) -> dict[str, Any]:
        return _response(
            ok=False,
            audit_run_id=audit_run_id,
            candidate_id=candidate_id,
            artifact_hash=artifact_hash,
            status=AUDIT_REFUSED,
            detail=detail,
            dataset_identity=identity or {},
        )

    # The policy must be what the parent claims it is, independently of what the
    # parent checked.
    actual_hash = policy_digest(policy_source)
    if actual_hash != artifact_hash:
        return refuse(f"policy source hashes to {actual_hash}, not {artifact_hash}")

    expected = DatasetIdentity.from_dict(request["expected_identity"])
    try:
        identity, _public_cases, holdout_cases = load_anchor_split(
            request["anchors_dir"],
            holdout_fraction=expected.holdout_fraction,
            split_seed=expected.split_seed,
        )
    except (ValueError, OSError) as exc:
        return refuse(f"anchor source unusable: {exc}")

    # Recomputed here, independently. A drifted anchor directory would make the
    # holdout number meaningless while still looking like a valid audit.
    mismatch = expected.mismatch_reason(identity)
    if mismatch:
        return refuse(f"anchor dataset does not match the public snapshot: {mismatch}",
                      identity.to_dict())

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
        return _response(
            ok=False,
            audit_run_id=audit_run_id,
            candidate_id=candidate_id,
            artifact_hash=artifact_hash,
            status=AUDIT_FAILED,
            # The runner status, not the candidate's output.
            detail=f"candidate execution failed: {outcome.status}",
            dataset_identity=identity.to_dict(),
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
    return _response(
        ok=True,
        audit_run_id=audit_run_id,
        candidate_id=candidate_id,
        artifact_hash=artifact_hash,
        status=AUDIT_OK,
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
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    except OSError:
        return EXIT_UNREADABLE_REQUEST
    if len(raw) > MAX_REQUEST_BYTES:
        return EXIT_UNREADABLE_REQUEST
    try:
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict) or request.get("kind") != KIND_AUDIT:
            raise ValueError(f"unexpected request kind {request.get('kind')!r}")
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError) as exc:
        sys.stderr.write(f"auditor protocol error: {exc}\n")
        return EXIT_UNREADABLE_REQUEST

    response = run_audit_in_controller(request)
    sys.stdout.buffer.write(encode(response))
    sys.stdout.buffer.flush()
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())

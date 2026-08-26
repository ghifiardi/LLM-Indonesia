"""Candidate execution worker. Runs as a child process, never in the parent.

    python3 -m godel_agent_prototype.resident.runner.worker

Reads one JSON request on stdin, writes one JSON response on stdout. Reads at
most ``MAX_REQUEST_BYTES + 1`` so an oversized request is rejected rather than
buffered into memory.

The worker independently:

1. parses and validates the candidate with ``SafePolicyLoader``;
2. builds the permitted public environment from the records it was handed;
3. evaluates, with per-case output capped at the source;
4. sanitises the result down to aggregates plus capped feedback;
5. writes exactly one bounded response.

It never receives, and has no code capable of locating, holdout data. It is
handed evaluation records inline and resolves the environment name itself; it
does not open a dataset file.

Parent-side validation exists as an early rejection, but nothing here trusts
that it ran.
"""

from __future__ import annotations

import sys
from typing import Any

from ...godel_agent import PolicyValidationError, SafePolicyLoader
from ..eval_records import build_environment_from_records
from ..models import STATUS_RESOURCE_LIMIT, STATUS_RUNTIME, STATUS_SYNTAX, STATUS_VALIDATION
from .base import cap_policy_output, evaluate_in_process
from .limits import RunnerLimits, profile_for
from .protocol import (
    EXIT_OK,
    KIND_EXECUTE_BATCH,
    MAX_BATCH_OUTPUT_CHARS,
    build_batch_response,
    parse_execute_batch_request,
    peek_kind,
    EXIT_OVERSIZED_REQUEST,
    EXIT_UNREADABLE_REQUEST,
    EXIT_UNWRITABLE_RESPONSE,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    ProtocolError,
    build_response,
    encode,
    parse_evaluate_request,
)


def _emit(message: dict[str, Any]) -> int:
    """Write one response, or fall back to a minimal one if it is too large."""

    payload = encode(message)
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = encode(
            build_response(
                ok=False,
                status=STATUS_RUNTIME,
                error="worker response exceeded the size cap and was replaced",
            )
        )
    try:
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
    except OSError:
        return EXIT_UNWRITABLE_RESPONSE
    return EXIT_OK


def _run_batch(request: dict[str, Any]) -> int:
    """Execute a candidate over unlabeled inputs, for the holdout auditor.

    The request carries queries, the permitted KB, and the policy. It carries no
    reference answers, no required or forbidden terms and no rubric, so nothing
    here can recognise or report what the candidate is being scored against.
    Scoring happens in the auditor controller that spawned this process.

    The artifact hash is verified here as well as by the controller: a child
    that will not run code it cannot identify is one fewer place a swap can go
    unnoticed.
    """

    from ..store import policy_digest

    policy_source = request["policy_source"]
    expected_hash = request["artifact_hash"]
    actual_hash = policy_digest(policy_source)
    if actual_hash != expected_hash:
        return _emit(
            build_batch_response(
                ok=False,
                status=STATUS_VALIDATION,
                error=(
                    f"policy source hashes to {actual_hash}, "
                    f"not the requested {expected_hash}"
                ),
            )
        )

    limits = RunnerLimits.from_dict(request.get("limits") or {})
    try:
        policy = SafePolicyLoader().load(policy_source)
    except PolicyValidationError as exc:
        message = str(exc)
        status = STATUS_SYNTAX if message.startswith("Syntax error") else STATUS_VALIDATION
        return _emit(build_batch_response(ok=False, status=status, error=message))

    output_cap = min(limits.max_output_chars, MAX_BATCH_OUTPUT_CHARS)
    guarded = cap_policy_output(policy, output_cap)
    kb = request.get("kb") or {}

    outputs: list[Any] = []
    try:
        for item in request["inputs"]:
            try:
                result = guarded(item, kb)
            except Exception as exc:
                # A candidate that raises on one input has simply failed that
                # case; the controller scores the empty answer.
                result = f"<ERROR {type(exc).__name__}>"
            if not isinstance(result, str):
                result = str(result)[:output_cap]
            outputs.append(result)
    except MemoryError:
        return _emit(
            build_batch_response(
                ok=False,
                status=STATUS_RESOURCE_LIMIT,
                error="MemoryError during batch execution",
            )
        )
    return _emit(build_batch_response(ok=True, outputs=outputs))


def main(argv: list[str] | None = None) -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    except OSError:
        return EXIT_UNREADABLE_REQUEST
    if len(raw) > MAX_REQUEST_BYTES:
        return EXIT_OVERSIZED_REQUEST

    try:
        kind = peek_kind(raw)
        if kind == KIND_EXECUTE_BATCH:
            return _run_batch(parse_execute_batch_request(raw))
        request = parse_evaluate_request(raw)
    except ProtocolError as exc:
        # A malformed request cannot be answered in kind; the parent classifies
        # this exit code as a protocol failure.
        sys.stderr.write(f"protocol error: {exc}\n")
        return EXIT_UNREADABLE_REQUEST

    limits = RunnerLimits.from_dict(request.get("limits") or {})
    profile = profile_for(limits)

    try:
        environment = build_environment_from_records(
            request["environment_name"], request["public_snapshot"]
        )
    except ValueError as exc:
        return _emit(build_response(ok=False, status=STATUS_RUNTIME, error=str(exc)))
    except MemoryError:
        return _emit(
            build_response(
                ok=False,
                status=STATUS_RESOURCE_LIMIT,
                error="MemoryError while building the environment",
                memory_error=True,
            )
        )

    try:
        outcome = evaluate_in_process(request["policy_source"], environment, limits, profile)
    except MemoryError:
        # Reported explicitly so the parent can mark the memory limit as
        # observed rather than inferring it from an ambiguous signal.
        return _emit(
            build_response(
                ok=False,
                status=STATUS_RESOURCE_LIMIT,
                error="MemoryError during evaluation",
                memory_error=True,
            )
        )

    if outcome.scores is None:
        return _emit(build_response(ok=False, status=outcome.status, error=outcome.error))
    return _emit(
        build_response(
            ok=True,
            score=outcome.scores.to_dict(),
            feedback=outcome.feedback,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())

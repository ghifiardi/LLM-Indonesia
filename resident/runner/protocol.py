"""Wire protocol between the resident parent and an execution worker.

One JSON object in on stdin, one JSON object out on stdout, both carrying
``protocol_version`` and ``kind``. Nothing else crosses the boundary: no
pickles, no callables, no filesystem paths to datasets.

Size caps are enforced on both sides. The parent checks the request before
spawning; the worker reads at most ``MAX_REQUEST_BYTES + 1`` so an oversized
request is detected rather than buffered.

``kind`` is validated against a known set so a future ``execute_batch`` mode
(the holdout auditor's candidate child, Phase 2 PR B) can be added without a
version bump, and an unknown kind fails closed today.
"""

from __future__ import annotations

import json
from typing import Any

PROTOCOL_VERSION = 1

KIND_EVALUATE = "evaluate"
#: Used by the holdout auditor controller. The child is handed *unlabeled*
#: inputs and returns bounded outputs; it never sees a reference answer, a
#: required term, or any rubric, and its outputs never travel past the
#: controller that spawned it.
KIND_EXECUTE_BATCH = "execute_batch"
#: One served request. Distinct from ``evaluate`` because serving needs a
#: *structured* outcome — whether the policy raised, timed out, or returned —
#: rather than a score. Inferring "it raised" from a marker inside the output
#: string would make the guard depend on text a candidate controls.
KIND_EXECUTE_ONE = "execute_one"
KNOWN_KINDS = frozenset({KIND_EVALUATE, KIND_EXECUTE_BATCH, KIND_EXECUTE_ONE})

#: Caps for batch execution.
MAX_BATCH_INPUTS = 2000
MAX_BATCH_OUTPUT_CHARS = 4096

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_STDOUT_BYTES = MAX_RESPONSE_BYTES
MAX_STDERR_BYTES = 64 * 1024
MAX_FEEDBACK_CHARS = 2000

# Worker exit codes for failures that occur before a response can be written.
EXIT_OK = 0
EXIT_OVERSIZED_REQUEST = 3
EXIT_UNREADABLE_REQUEST = 4
EXIT_UNWRITABLE_RESPONSE = 5


class ProtocolError(Exception):
    """Raised when a message violates the protocol. Always fails closed."""


def build_evaluate_request(
    policy_source: str,
    environment_name: str,
    public_snapshot: list[dict[str, Any]],
    limits: dict[str, Any],
) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_EVALUATE,
        "policy_source": policy_source,
        "environment_name": environment_name,
        "public_snapshot": public_snapshot,
        "limits": limits,
    }


def build_execute_batch_request(
    policy_source: str,
    artifact_hash: str,
    inputs: list[Any],
    kb: dict[str, Any],
    limits: dict[str, Any],
) -> dict[str, Any]:
    """Build a batch request.

    ``inputs`` carries queries only. Any caller tempted to attach the expected
    answer for convenience would be handing candidate code the labels it is
    being tested against.
    """

    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_EXECUTE_BATCH,
        "policy_source": policy_source,
        "artifact_hash": artifact_hash,
        "inputs": inputs,
        "kb": kb,
        "limits": limits,
    }


def parse_execute_batch_request(raw: bytes) -> dict[str, Any]:
    """Worker side: decode and validate a batch request."""

    message = _decode_message(raw, MAX_REQUEST_BYTES, "request")
    if message.get("kind") != KIND_EXECUTE_BATCH:
        raise ProtocolError(f"expected {KIND_EXECUTE_BATCH!r}, got {message.get('kind')!r}")
    if not isinstance(message.get("policy_source"), str):
        raise ProtocolError("policy_source must be a string")
    if not isinstance(message.get("artifact_hash"), str):
        raise ProtocolError("artifact_hash must be a string")
    inputs = message.get("inputs")
    if not isinstance(inputs, list):
        raise ProtocolError("inputs must be a list")
    if len(inputs) > MAX_BATCH_INPUTS:
        raise ProtocolError(f"inputs exceed the {MAX_BATCH_INPUTS} item cap")
    if not isinstance(message.get("kb", {}), dict):
        raise ProtocolError("kb must be an object")
    return message


def build_batch_response(
    ok: bool,
    outputs: list[Any] | None = None,
    status: str = "",
    error: str = "",
) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_EXECUTE_BATCH,
        "ok": ok,
        "status": status,
        "error": error[:4000],
        "outputs": outputs if outputs is not None else [],
    }


def build_execute_one_request(
    policy_source: str,
    artifact_hash: str,
    query: Any,
    kb: dict[str, Any],
    limits: dict[str, Any],
) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_EXECUTE_ONE,
        "policy_source": policy_source,
        "artifact_hash": artifact_hash,
        "query": query,
        "kb": kb,
        "limits": limits,
    }


def parse_execute_one_request(raw: bytes) -> dict[str, Any]:
    message = _decode_message(raw, MAX_REQUEST_BYTES, "request")
    if message.get("kind") != KIND_EXECUTE_ONE:
        raise ProtocolError(f"expected {KIND_EXECUTE_ONE!r}, got {message.get('kind')!r}")
    if not isinstance(message.get("policy_source"), str):
        raise ProtocolError("policy_source must be a string")
    if not isinstance(message.get("artifact_hash"), str):
        raise ProtocolError("artifact_hash must be a string")
    if "query" not in message:
        raise ProtocolError("query is required")
    if not isinstance(message.get("kb", {}), dict):
        raise ProtocolError("kb must be an object")
    return message


def build_execute_one_response(
    ok: bool,
    output: str = "",
    status: str = "",
    raised: bool = False,
    exception_type: str = "",
) -> dict[str, Any]:
    """Structured serving outcome.

    ``output`` is necessarily free text — it is the answer. Everything the
    guard decides on is structured: whether the policy raised, and if so only
    its exception *type*, never its message. An exception message can quote the
    query or internal state, and it must not reach a client or an ordinary
    request record.
    """

    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_EXECUTE_ONE,
        "ok": ok,
        "status": status,
        "raised": raised,
        "exception_type": exception_type[:80],
        "output": output,
    }


def encode(message: dict[str, Any]) -> bytes:
    return json.dumps(message, ensure_ascii=False).encode("utf-8")


def _decode_message(raw: bytes, cap: int, label: str) -> dict[str, Any]:
    if len(raw) > cap:
        raise ProtocolError(f"{label} exceeds {cap} bytes")
    try:
        message = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"{label} is not valid JSON: {exc}") from exc
    if not isinstance(message, dict):
        raise ProtocolError(f"{label} is not a JSON object")
    version = message.get("protocol_version")
    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            f"unsupported protocol_version {version!r}; this build speaks {PROTOCOL_VERSION}"
        )
    if message.get("kind") not in KNOWN_KINDS:
        raise ProtocolError(f"unknown {label} kind {message.get('kind')!r}")
    return message


def peek_kind(raw: bytes) -> str:
    """Read the kind of a request without committing to its schema."""

    return _decode_message(raw, MAX_REQUEST_BYTES, "request").get("kind", "")


def parse_evaluate_request(raw: bytes) -> dict[str, Any]:
    """Worker side: decode and validate a request. Raises ProtocolError."""

    message = _decode_message(raw, MAX_REQUEST_BYTES, "request")
    if message.get("kind") != KIND_EVALUATE:
        raise ProtocolError(f"expected {KIND_EVALUATE!r}, got {message.get('kind')!r}")
    if not isinstance(message.get("policy_source"), str):
        raise ProtocolError("policy_source must be a string")
    if not isinstance(message.get("environment_name"), str):
        raise ProtocolError("environment_name must be a string")
    snapshot = message.get("public_snapshot")
    if not isinstance(snapshot, list) or any(not isinstance(r, dict) for r in snapshot):
        raise ProtocolError("public_snapshot must be a list of objects")
    if not isinstance(message.get("limits", {}), dict):
        raise ProtocolError("limits must be an object")
    return message


def build_response(
    ok: bool,
    status: str = "",
    error: str = "",
    score: dict[str, Any] | None = None,
    feedback: str = "",
    memory_error: bool = False,
) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "kind": KIND_EVALUATE,
        "ok": ok,
        "status": status,
        "error": error[:4000],
        "score": score,
        "feedback": feedback[:MAX_FEEDBACK_CHARS],
        "memory_error": memory_error,
    }


def parse_response(raw: bytes, expected_kind: str = KIND_EVALUATE) -> dict[str, Any]:
    """Parent side: decode and validate a response. Raises ProtocolError."""

    if not raw.strip():
        raise ProtocolError("worker produced no response")
    message = _decode_message(raw, MAX_RESPONSE_BYTES, "response")
    if message.get("kind") != expected_kind:
        raise ProtocolError(
            f"expected a {expected_kind!r} response, got {message.get('kind')!r}"
        )
    if expected_kind == KIND_EXECUTE_ONE:
        if not isinstance(message.get("ok"), bool):
            raise ProtocolError("response.ok must be a boolean")
        if not isinstance(message.get("output", ""), str):
            raise ProtocolError("response.output must be a string")
        if not isinstance(message.get("raised", False), bool):
            raise ProtocolError("response.raised must be a boolean")
        return message
    if expected_kind == KIND_EXECUTE_BATCH:
        if not isinstance(message.get("ok"), bool):
            raise ProtocolError("response.ok must be a boolean")
        outputs = message.get("outputs")
        if not isinstance(outputs, list):
            raise ProtocolError("response.outputs must be a list")
        return message
    if not isinstance(message.get("ok"), bool):
        raise ProtocolError("response.ok must be a boolean")
    score = message.get("score")
    if score is not None and not isinstance(score, dict):
        raise ProtocolError("response.score must be an object or null")
    return message

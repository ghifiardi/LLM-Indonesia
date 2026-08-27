"""The serving process: answers queries from the champion, and modifies nothing.

Read-only by construction, not by care:

* it opens the state database with ``mode=ro``, so a write fails at the driver;
* it reads the champion pointer and artifact as files, verified on read;
* it appends to the spool for anything that must be recorded, and the
  supervisor ingests that later;
* it imports ``store`` (read surface), ``eval_records``, ``runner``, ``spool``
  and ``anchors`` — and none of ``reflect``, ``gate``, ``promote``,
  ``rollback``, ``budget``, ``audit`` or ``freeze``.

It therefore cannot promote, freeze, clear a canary, or record a state
transition, and a test asserts the import set rather than trusting the comment.

**Nothing a policy produces reaches a client unguarded.** Every answer passes
the output guard first. If the policy raises, times out, or emits a
solicitation pattern, the output is discarded — never returned, never logged as
text — and the fallback path runs. Freezing self-modification while continuing
to return an unsafe answer would not contain an incident; withholding the
answer is what contains it.

Transport is a Unix domain socket, so the surface is local by construction
rather than by configuration.
"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..dataset_env import DEFAULT_KB
from .anchors import (
    ServingConfig,
    ThresholdError,
    ThresholdIdentity,
    load_all_anchors,
    resolve_anchors_dir,
)
from . import canary_view as canary_module
from .runner import RunnerLimits, ServeOutcome, SubprocessCandidateRunner
from .spool import KIND_CANARY_VETO, KIND_CHAMPION_VETO, KIND_SERVED_REQUEST, SpoolWriter
from .store import (
    CONFIG_ENVIRONMENT,
    resolve_state_dir,
    ResidentError,
    CONFIG_THRESHOLD_IDENTITY,
    ResidentStore,
    new_id,
    utcnow,
)

ROUTE_CHAMPION = "champion"
ROUTE_CANARY = "canary"
ROUTE_FALLBACK = "fallback"

VETO_RAISED = "raised"
VETO_TIMEOUT = "timed_out"
VETO_UNSAFE_OUTPUT = "unsafe_output"
VETO_EXECUTION_FAILED = "execution_failed"
#: The artifact a pointer names could not be read or failed its integrity
#: check. Rare, and exactly the case where a generic "internal error" would
#: hide a tampered store behind a shrug.
VETO_ARTIFACT_UNREADABLE = "artifact_unreadable"

MAX_REQUEST_LINE_BYTES = 32 * 1024
MAX_QUERY_CHARS = 8000
CONNECTION_TIMEOUT_SECONDS = 30.0


class ServeError(Exception):
    """Raised when the serving process cannot start safely."""


#: Clause boundaries. Deliberately aggressive — a comma is enough to end a
#: clause — because the two error directions are not symmetric: a false
#: positive costs one fallback response, a false negative sends the user a
#: phishing instruction.
_CLAUSE_BOUNDARY = re.compile(r"[.!?;,\n]+")


def unsafe_output(answer: str, config: ServingConfig) -> str:
    """Return the matched solicitation pattern, or '' when the answer is fine.

    Negation is checked **per occurrence**, not per answer. Treating any
    refusal marker anywhere as making the whole answer safe is exactly the
    bypass a phishing policy would use:

        "Jangan tutup aplikasi. Sekarang berikan OTP Anda."

    Both halves are present; only the second one matters. So each solicitation
    is located, and only the text before it *within its own clause* is examined
    for a negation. One safely negated occurrence cannot excuse another.
    """

    lowered = answer.lower()
    for clause in _CLAUSE_BOUNDARY.split(lowered):
        if not clause.strip():
            continue
        for pattern in config.solicitation_patterns:
            start = clause.find(pattern)
            while start != -1:
                preceding = clause[:start]
                if not any(marker in preceding for marker in config.negation_markers):
                    return pattern
                start = clause.find(pattern, start + 1)
    return ""


@dataclass
class ServingContext:
    """Everything the responder needs, resolved once at startup."""

    store: ResidentStore
    config: ServingConfig
    spool: SpoolWriter
    runner: SubprocessCandidateRunner
    environment: str
    limits: RunnerLimits


def build_context(
    state_dir: str | os.PathLike[str] | None = None,
    anchors_dir: str | os.PathLike[str] | None = None,
    spool: SpoolWriter | None = None,
) -> ServingContext:
    store = ResidentStore.open_readonly(state_dir)
    try:
        identity, _gate, _budget, config = load_all_anchors(resolve_anchors_dir(anchors_dir))
    except ThresholdError as exc:
        raise ServeError(f"Serving anchors are unusable: {exc}") from exc

    # The serving guards are anchors like any other, so an edit after init must
    # be detected rather than adopted. Without this check, changing
    # serving.toml would silently rewrite the unsafe-output patterns, the
    # timeout, and the fallback text of a running deployment.
    recorded = store.get_config(CONFIG_THRESHOLD_IDENTITY)
    if not recorded:
        raise ServeError(
            "No threshold identity was recorded at init; refusing to serve against "
            "unverified anchors. Re-run init against the anchor source."
        )
    try:
        expected = ThresholdIdentity.from_dict(json.loads(recorded))
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ServeError(f"Recorded threshold identity is unreadable: {exc}") from exc
    mismatch = expected.mismatch_field(identity)
    if mismatch:
        raise ServeError(
            f"Anchor files changed since init ({mismatch}); refusing to serve. "
            "Re-run init against the anchor source to adopt them deliberately."
        )

    environment = store.get_config(CONFIG_ENVIRONMENT) or ""
    limits = RunnerLimits(
        wall_clock_seconds=config.request_timeout_seconds,
        cpu_seconds=config.request_cpu_seconds,
        max_output_chars=config.max_output_chars,
    )
    return ServingContext(
        store=store,
        config=config,
        spool=spool or SpoolWriter(store.spool_dir),
        runner=SubprocessCandidateRunner(limits=limits),
        environment=environment,
        limits=limits,
    )


def _classify(outcome: ServeOutcome, config: ServingConfig) -> str:
    """The veto this outcome trips, or '' if the answer may be returned."""

    if outcome.timed_out:
        return VETO_TIMEOUT
    if outcome.raised:
        return VETO_RAISED
    if not outcome.ok:
        return VETO_EXECUTION_FAILED
    if unsafe_output(outcome.output, config):
        return VETO_UNSAFE_OUTPUT
    return ""


def _read_artifact(context: ServingContext, artifact_hash: str) -> str | None:
    """Read a verified artifact, or None if it cannot be trusted.

    A missing or corrupt artifact is a safety observation, not an internal
    error: it means the immutable store was modified out of band, and that must
    leave a record rather than a generic failure the client sees and nobody
    investigates.
    """

    try:
        return context.store.read_artifact(artifact_hash)
    except ResidentError:
        return None


def _run(context: ServingContext, policy_source: str, artifact_hash: str,
         query: str) -> tuple[Any, str]:
    outcome = context.runner.execute_one(
        policy_source=policy_source,
        artifact_hash=artifact_hash,
        query=query,
        kb=DEFAULT_KB,
        limits=context.limits,
    )
    return outcome, _classify(outcome, context.config)


def answer(
    context: ServingContext,
    query: str,
    request_id: str | None = None,
    conversation_id: str = "",
) -> dict[str, Any]:
    """Answer one query, guarded, from the canary slice or the champion.

    A canary that trips a hard veto never reaches the client: its output is
    discarded, the champion answers instead, and the champion's own answer is
    guarded too. Only if that also fails does the fixed fallback go out.
    """

    request_id = request_id or new_id()
    champion = context.store.read_champion()
    if champion is None:
        return _fallback_response(context, request_id, ROUTE_CHAMPION, None, "no_champion",
                                  query=query)

    pointer = _canary_pointer(context)
    requested_route = ROUTE_CHAMPION
    bucket: int | None = None
    canary_veto = ""

    if pointer is not None:
        selected, bucket = canary_module.routes_to_canary(pointer, query, conversation_id)
        if selected:
            requested_route = ROUTE_CANARY
            canary_source = _read_artifact(context, pointer.artifact_hash)
            if canary_source is None:
                _spool_veto(
                    context, KIND_CANARY_VETO, request_id, pointer.candidate_id,
                    pointer.artifact_hash, VETO_ARTIFACT_UNREADABLE,
                    activation_id=pointer.activation_id,
                )
                # Fall through to the champion rather than failing the request.
                canary_veto = VETO_ARTIFACT_UNREADABLE
                outcome = ServeOutcome(status=VETO_ARTIFACT_UNREADABLE)
                canary_source = ""
            else:
                outcome, canary_veto = _run(
                    context, canary_source, pointer.artifact_hash, query
                )
            if not canary_veto:
                return _success_response(
                    context, request_id, query, outcome, ROUTE_CANARY, ROUTE_CANARY,
                    champion, pointer, bucket,
                )
            # Discarded here. Serve cannot clear the canary itself — it holds a
            # read-only connection — so it records the observation and the
            # supervisor acts on it.
            elif canary_veto != VETO_ARTIFACT_UNREADABLE:
                _spool_veto(
                    context, KIND_CANARY_VETO, request_id, pointer.candidate_id,
                    pointer.artifact_hash, canary_veto,
                    activation_id=pointer.activation_id, detail=outcome.to_record(),
                )

    policy_source = _read_artifact(context, champion.artifact_hash)
    if policy_source is None:
        # The champion's own artifact is unreadable. The client gets the fixed
        # fallback, never a generic internal error, and the reason is recorded.
        _spool_veto(
            context, KIND_CHAMPION_VETO, request_id, champion.candidate_id,
            champion.artifact_hash, VETO_ARTIFACT_UNREADABLE,
        )
        return _fallback_response(
            context, request_id, requested_route, champion, VETO_ARTIFACT_UNREADABLE,
            query=query, bucket=bucket, pointer=pointer,
        )

    outcome, veto = _run(context, policy_source, champion.artifact_hash, query)

    if veto:
        _spool_veto(
            context, KIND_CHAMPION_VETO, request_id, champion.candidate_id,
            champion.artifact_hash, veto, detail=outcome.to_record(),
        )
        return _fallback_response(
            context, request_id, requested_route, champion, veto,
            outcome=outcome, query=query, bucket=bucket, pointer=pointer,
        )

    return _success_response(
        context, request_id, query, outcome, requested_route, ROUTE_CHAMPION,
        champion, pointer, bucket,
    )


def _spool_veto(
    context: ServingContext,
    kind: str,
    request_id: str,
    candidate_id: str,
    artifact_hash: str,
    veto: str,
    activation_id: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    """Record that a veto fired — never what the policy said.

    Written durably: this is what drives a canary being cleared or the resident
    freezing, and losing one would delay containment.
    """

    payload: dict[str, Any] = {
        "candidate_id": candidate_id,
        "artifact_hash": artifact_hash,
        "request_id": request_id,
        "veto": veto,
        "detail": detail or {},
    }
    if activation_id:
        payload["activation_id"] = activation_id
    context.spool.write(kind, new_id(), payload, durable=True)


def _canary_pointer(context: ServingContext) -> Any:
    try:
        return canary_module.active_pointer(context.store)
    except Exception:
        # A malformed pointer must not stop the champion answering.
        return None


def _success_response(
    context: ServingContext,
    request_id: str,
    query: str,
    outcome: Any,
    requested_route: str,
    actual_route: str,
    champion: Any,
    pointer: Any,
    bucket: int | None,
) -> dict[str, Any]:
    served_id = pointer.candidate_id if actual_route == ROUTE_CANARY else champion.candidate_id
    served_hash = pointer.artifact_hash if actual_route == ROUTE_CANARY else champion.artifact_hash
    context.spool.write(
        KIND_SERVED_REQUEST,
        request_id,
        {
            "query": query,
            "answer": outcome.output,
            "requested_route": requested_route,
            "actual_route": actual_route,
            "served_candidate_id": served_id,
            "served_artifact_hash": served_hash,
            "champion_candidate_id": champion.candidate_id,
            "canary_candidate_id": pointer.candidate_id if pointer is not None else None,
            "fallback_used": False,
            # The bucket is recorded; the salt that produced it never is.
            "routing_bucket": bucket,
            **outcome.to_record(),
        },
    )
    return {
        "request_id": request_id,
        "ok": True,
        "answer": outcome.output,
        "route": actual_route,
        "requested_route": requested_route,
        "fallback_used": False,
        "latency_ms": outcome.latency_ms,
    }


def _fallback_response(
    context: ServingContext,
    request_id: str,
    requested_route: str,
    champion: Any,
    veto: str,
    outcome: ServeOutcome | None = None,
    query: str = "",
    bucket: int | None = None,
    pointer: Any = None,
) -> dict[str, Any]:
    """The fixed safe answer. Never an error marker, never suppressed text."""

    context.spool.write(
        KIND_SERVED_REQUEST,
        request_id,
        {
            "query": query,
            "answer": context.config.safe_fallback,
            "requested_route": requested_route,
            "actual_route": ROUTE_FALLBACK,
            "served_candidate_id": None,
            "served_artifact_hash": None,
            "champion_candidate_id": getattr(champion, "candidate_id", None),
            "canary_candidate_id": getattr(pointer, "candidate_id", None),
            "fallback_used": True,
            "routing_bucket": bucket,
            "status": veto,
            "latency_ms": outcome.latency_ms if outcome is not None else 0,
            "timed_out": bool(outcome.timed_out) if outcome is not None else False,
            "raised": bool(outcome.raised) if outcome is not None else False,
            "exception_type": outcome.exception_type if outcome is not None else "",
        },
    )
    return {
        "request_id": request_id,
        "ok": True,
        "answer": context.config.safe_fallback,
        "route": ROUTE_FALLBACK,
        "requested_route": requested_route,
        "fallback_used": True,
        "latency_ms": outcome.latency_ms if outcome is not None else 0,
    }


# --- socket transport -------------------------------------------------------


def runtime_dir_for(state_dir: Path) -> Path:
    """A short, private directory for the socket.

    AF_UNIX paths are capped near 104 bytes on darwin, and this project's own
    checkout path is longer than that on its own — so the socket cannot live
    beside the state directory. It goes in a private runtime directory named by
    a hash of the state path instead.
    """

    import hashlib

    digest = hashlib.sha256(str(state_dir).encode("utf-8")).hexdigest()[:12]
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/tmp/godel-resident-{os.getuid()}"
    return Path(base) / "godel-resident" / digest


def prepare_socket_path(state_dir: Path) -> Path:
    """Create and validate the runtime directory; return the socket path."""

    runtime = runtime_dir_for(state_dir)
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = os.lstat(runtime)
    if stat.S_ISLNK(info.st_mode):
        raise ServeError(f"Runtime directory {runtime} is a symlink; refusing.")
    if info.st_uid != os.getuid():
        raise ServeError(f"Runtime directory {runtime} is not owned by this user.")
    if info.st_mode & 0o077:
        os.chmod(runtime, 0o700)
    path = runtime / "serve.sock"
    if len(str(path).encode("utf-8")) > 100:
        raise ServeError(f"Socket path {path} is too long for AF_UNIX.")
    return path


def clear_stale_socket(path: Path) -> None:
    """Remove a leftover socket, but only after proving nobody is listening.

    Unlinking a live socket would silently steal traffic from a running server,
    so a successful connect is treated as "in use" and refused.
    """

    if not path.exists():
        return
    if path.is_symlink():
        raise ServeError(f"Socket path {path} is a symlink; refusing to remove it.")
    if not stat.S_ISSOCK(os.lstat(path).st_mode):
        raise ServeError(f"{path} exists and is not a socket; refusing to remove it.")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(1.0)
    try:
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError, socket.timeout, OSError):
        path.unlink(missing_ok=True)
        return
    finally:
        probe.close()
    raise ServeError(f"A server is already listening on {path}.")


def _read_line(conn: socket.socket) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_REQUEST_LINE_BYTES:
            raise ValueError("request exceeds the line cap")
        chunks.append(chunk)
        if b"\n" in chunk:
            break
    return b"".join(chunks).split(b"\n", 1)[0]


def handle_connection(context: ServingContext, conn: socket.socket) -> None:
    conn.settimeout(CONNECTION_TIMEOUT_SECONDS)
    try:
        raw = _read_line(conn)
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request is not an object")
        query = request.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")
        if len(query) > MAX_QUERY_CHARS:
            raise ValueError("query exceeds the length cap")
        request_id = request.get("request_id")
        request_id = request_id if isinstance(request_id, str) and request_id else new_id()
        conversation_id = request.get("conversation_id")
        conversation_id = conversation_id if isinstance(conversation_id, str) else ""
        response = answer(
            context, query, request_id=request_id, conversation_id=conversation_id
        )
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        # Deliberately does not echo the offending input: a diagnostic must not
        # become a place raw queries are written.
        response = {"ok": False, "error": "malformed request", "answer": None}
        # Stop reading. Draining an oversized frame to be polite would defeat
        # the cap, so the sender's write fails fast instead of hanging.
        try:
            conn.shutdown(socket.SHUT_RD)
        except OSError:
            pass
    except socket.timeout:
        return
    except Exception:
        response = {"ok": False, "error": "internal error", "answer": None}
    try:
        conn.sendall((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))
    except OSError:
        pass


def serve_forever(
    context: ServingContext,
    socket_path: Path,
    stop: threading.Event | None = None,
    ready: threading.Event | None = None,
) -> None:
    clear_stale_socket(socket_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        server.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        server.listen(16)
        server.settimeout(0.5)
        if ready is not None:
            ready.set()
        while stop is None or not stop.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                handle_connection(context, conn)
    finally:
        server.close()
        socket_path.unlink(missing_ok=True)
        context.spool.close()


def main(argv: list[str] | None = None) -> int:
    """Standalone entry point: ``python -m godel_agent_prototype.resident.serve``.

    Deliberately separate from the CLI. Starting the serving process through
    ``cli.py`` would import the gate, the promoter, the auditor and the
    supervisor into it — not because it can call them, but because that module
    imports them. Running from here, the process holds only what it needs, and
    a test can check that by inspecting its loaded modules.
    """

    import argparse

    parser = argparse.ArgumentParser(
        prog="python3 -m godel_agent_prototype.resident.serve",
        description="Answer queries from the champion. Read-only; modifies nothing.",
    )
    parser.add_argument("--state-dir", default=None)
    parser.add_argument("--anchors-dir", default=None)
    args = parser.parse_args(argv)

    state_dir = resolve_state_dir(args.state_dir)
    try:
        socket_path = prepare_socket_path(state_dir)
        context = build_context(state_dir, anchors_dir=args.anchors_dir)
    except (ServeError, ResidentError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"serving {state_dir} on {socket_path}", file=sys.stderr)
    print("read-only: this process cannot promote, freeze, or modify state.", file=sys.stderr)
    try:
        serve_forever(context, socket_path)
    except KeyboardInterrupt:
        pass
    except ServeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


def ask(socket_path: Path, query: str, request_id: str | None = None,
        timeout: float = 60.0, conversation_id: str = "") -> dict[str, Any]:
    """Minimal client. Used by `resident ask` and by tests."""

    payload = json.dumps(
        {
            "query": query,
            "request_id": request_id or new_id(),
            "conversation_id": conversation_id,
        },
        ensure_ascii=False,
    ) + "\n"
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(socket_path))
        client.sendall(payload.encode("utf-8"))
        chunks: list[bytes] = []
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        return json.loads(b"".join(chunks).decode("utf-8").split("\n", 1)[0])
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())

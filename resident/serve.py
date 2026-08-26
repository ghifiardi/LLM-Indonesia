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
import socket
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..dataset_env import DEFAULT_KB
from .anchors import ServingConfig, load_all_anchors, resolve_anchors_dir
from .runner import RunnerLimits, ServeOutcome, SubprocessCandidateRunner
from .spool import KIND_CHAMPION_VETO, KIND_SERVED_REQUEST, SpoolWriter
from .store import CONFIG_ENVIRONMENT, ResidentStore, new_id, utcnow

ROUTE_CHAMPION = "champion"
ROUTE_FALLBACK = "fallback"

VETO_RAISED = "raised"
VETO_TIMEOUT = "timed_out"
VETO_UNSAFE_OUTPUT = "unsafe_output"
VETO_EXECUTION_FAILED = "execution_failed"

MAX_REQUEST_LINE_BYTES = 32 * 1024
MAX_QUERY_CHARS = 8000
CONNECTION_TIMEOUT_SECONDS = 30.0


class ServeError(Exception):
    """Raised when the serving process cannot start safely."""


def unsafe_output(answer: str, config: ServingConfig) -> str:
    """Return the matched solicitation pattern, or '' when the answer is fine.

    Negation-aware on purpose. A bare "contains OTP" rule would reject
    *"jangan berikan OTP kepada siapa pun"* — the single most useful thing the
    assistant can say about an OTP — so a solicitation pattern only counts when
    no refusal marker appears in the answer.
    """

    lowered = answer.lower()
    if any(marker in lowered for marker in config.negation_markers):
        return ""
    for pattern in config.solicitation_patterns:
        if pattern in lowered:
            return pattern
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
    _identity, _gate, _budget, config = load_all_anchors(resolve_anchors_dir(anchors_dir))
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


def answer(context: ServingContext, query: str, request_id: str | None = None) -> dict[str, Any]:
    """Answer one query from the champion, guarded.

    Canary routing arrives in the next commit; this path serves the champion and
    establishes the guard every route will pass through.
    """

    request_id = request_id or new_id()
    champion = context.store.read_champion()
    if champion is None:
        return _fallback_response(context, request_id, ROUTE_CHAMPION, None, "no_champion")

    policy_source = context.store.read_artifact(champion.artifact_hash)
    outcome = context.runner.execute_one(
        policy_source=policy_source,
        artifact_hash=champion.artifact_hash,
        query=query,
        kb=DEFAULT_KB,
        limits=context.limits,
    )
    veto = _classify(outcome, context.config)

    if veto:
        # Suppressed: the output is discarded here and never travels further.
        # The observation records *that* it happened and which veto fired, not
        # what the policy said.
        context.spool.write(
            KIND_CHAMPION_VETO,
            new_id(),
            {
                "candidate_id": champion.candidate_id,
                "artifact_hash": champion.artifact_hash,
                "request_id": request_id,
                "veto": veto,
                "detail": outcome.to_record(),
            },
            durable=True,
        )
        return _fallback_response(
            context, request_id, ROUTE_CHAMPION, champion, veto, outcome=outcome, query=query
        )

    response = {
        "request_id": request_id,
        "ok": True,
        "answer": outcome.output,
        "route": ROUTE_CHAMPION,
        "fallback_used": False,
        "latency_ms": outcome.latency_ms,
    }
    context.spool.write(
        KIND_SERVED_REQUEST,
        request_id,
        {
            "query": query,
            "answer": outcome.output,
            "requested_route": ROUTE_CHAMPION,
            "actual_route": ROUTE_CHAMPION,
            "served_candidate_id": champion.candidate_id,
            "served_artifact_hash": champion.artifact_hash,
            "champion_candidate_id": champion.candidate_id,
            "canary_candidate_id": None,
            "fallback_used": False,
            "routing_bucket": None,
            **outcome.to_record(),
        },
    )
    return response


def _fallback_response(
    context: ServingContext,
    request_id: str,
    requested_route: str,
    champion: Any,
    veto: str,
    outcome: ServeOutcome | None = None,
    query: str = "",
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
            "canary_candidate_id": None,
            "fallback_used": True,
            "routing_bucket": None,
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
        response = answer(context, query, request_id=request_id)
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


def ask(socket_path: Path, query: str, request_id: str | None = None,
        timeout: float = 60.0) -> dict[str, Any]:
    """Minimal client. Used by `resident ask` and by tests."""

    payload = json.dumps(
        {"query": query, "request_id": request_id or new_id()}, ensure_ascii=False
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

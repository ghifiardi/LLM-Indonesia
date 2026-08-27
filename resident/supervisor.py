"""The supervisor: owns the champion pointer and drives the three clocks.

    supervisor (long-lived; the only process that promotes or rolls back)
    ├── serve     long-lived, read-only              continuous
    ├── reflect   one-shot child, on the clock       spawned per cycle
    └── audit     one-shot child, on the clock       spawned per run

Only two processes are long-lived: this one and ``serve``. Reflection and
auditing are **one-shot children**, so nothing capable of proposing a
self-modification stays resident between cycles. That is cheaper to reason
about than three daemons, and it keeps self-modification off the serving path
by construction rather than by care.

Ownership is real but bounded. While a supervisor holds the advisory lock on a
state directory, pointer-changing CLI commands delegate to it over a
permission-restricted control socket instead of writing the pointer themselves;
direct CLI operation remains available only when no supervisor owns the
directory. Under a single OS account this is coordination, not privilege
separation — any process running as this user could still write the pointer.
Separate UIDs or read-only mounts remain deferred under AR-02.

**The audit clock runs while frozen.** A weekly holdout audit matters more
during an incident, not less. Only reflection is gated on the freeze, alongside
promotion and canary activation.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import canary as canary_module
from . import freeze as freeze_module
from .anchors import (
    ANCHORS_DIR_ENV_VAR,
    ThresholdError,
    ThresholdIdentity,
    load_all_anchors,
    resolve_anchors_dir,
)
from .freeze import is_frozen
from .runner.subprocess_runner import _minimal_environment
from .serve import prepare_socket_path, runtime_dir_for
from .spool import ingest
from .store import CONFIG_THRESHOLD_IDENTITY, ResidentError, ResidentStore, utcnow

CONFIG_LAST_REFLECT = "last_reflect_at"
CONFIG_LAST_AUDIT = "last_audit_at"

#: Per-clock bookkeeping. Success and attempt are tracked separately so a
#: failed run cannot masquerade as a completed one and suppress retries for a
#: full interval — which for the weekly audit would mean a week of silence.
CONFIG_LAST_ATTEMPT = "last_{clock}_attempt_at"
CONFIG_FAILURES = "{clock}_failures"
CONFIG_LAST_ERROR = "last_{clock}_error"

#: Retry backoff after a failed clock run: 60s doubling, capped at the
#: interval itself, so a broken clock retries promptly at first and then no
#: more often than it would have run anyway.
RETRY_BASE_SECONDS = 60
MAX_RECORDED_FAILURES = 16

SUPERVISOR_LOCK_NAME = "supervisor.lock"
CONTROL_SOCKET_NAME = "control.sock"

MAX_CONTROL_FRAME_BYTES = 32 * 1024
CONTROL_TIMEOUT_SECONDS = 120.0

#: Commands the control channel accepts. Deliberately small: the channel exists
#: so pointer changes have one writer, not to become a second CLI.
CONTROL_COMMANDS = frozenset(
    {"promote", "rollback", "canary_set", "canary_clear", "status", "ingest"}
)

CLOCK_EVENT = "clock_fired"
SERVE_EVENT = "serve_lifecycle"
SUPERVISOR_EVENT = "supervisor_lifecycle"

#: Durable liveness evidence for the readiness window. A start event alone
#: proves only that the process existed at one instant; it cannot justify
#: counting wall-clock time after an unexpected exit. The supervisor therefore
#: records a sparse heartbeat. Readiness accepts gaps up to three intervals so
#: a slow tick or scheduler delay does not manufacture an outage, but it never
#: extends a window past the last durable lifecycle observation.
SUPERVISOR_HEARTBEAT_INTERVAL_SECONDS = 60.0
SUPERVISOR_HEARTBEAT_MAX_GAP_SECONDS = 180.0

#: Restart backoff for the owned serve child: 1s doubling, capped. A serving
#: process that cannot start should not be respawned in a tight loop.
SERVE_RESTART_BASE_SECONDS = 1.0
SERVE_RESTART_MAX_SECONDS = 60.0
SERVE_READY_TIMEOUT_SECONDS = 20.0


class SupervisorError(ResidentError):
    """Raised when the supervisor cannot start or a control call is refused."""


class SupervisorLock:
    """Advisory exclusive lock naming the supervisor that owns a state directory.

    ``flock`` is released by the kernel when the holder dies, so a crashed
    supervisor does not leave a directory permanently owned — which a pid file
    alone would.
    """

    def __init__(self, state_dir: Path, control_socket: Path | None = None) -> None:
        self.path = Path(state_dir) / SUPERVISOR_LOCK_NAME
        self.control_socket = control_socket
        self._fd: int | None = None

    def acquire(self) -> None:
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise SupervisorError(
                    f"Another supervisor already owns {self.path.parent}."
                ) from exc
            raise
        os.ftruncate(fd, 0)
        payload = json.dumps(
            {
                "pid": os.getpid(),
                "started_at": utcnow(),
                "control_socket": str(self.control_socket) if self.control_socket else None,
            }
        )
        os.write(fd, payload.encode("utf-8"))
        os.fsync(fd)
        self._fd = fd

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(self._fd)
        self._fd = None
        self.path.unlink(missing_ok=True)

    def __enter__(self) -> "SupervisorLock":
        self.acquire()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.release()


def active_supervisor(state_dir: Path) -> dict[str, Any] | None:
    """Details of the supervisor owning this directory, or None.

    Determined by trying the lock rather than by reading a pid: the file can
    outlive its writer, the lock cannot.
    """

    path = Path(state_dir) / SUPERVISOR_LOCK_NAME
    if not path.is_file():
        return None
    try:
        fd = os.open(path, os.O_RDWR)
    except OSError:
        return None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            # Held by someone else: read what they wrote about themselves.
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    return json.loads(handle.read() or "{}")
            except (OSError, json.JSONDecodeError):
                return {"pid": None, "control_socket": None}
        fcntl.flock(fd, fcntl.LOCK_UN)
        return None
    finally:
        os.close(fd)


def control_socket_path(state_dir: Path) -> Path:
    return runtime_dir_for(Path(state_dir)) / CONTROL_SOCKET_NAME


def call_control(socket_path: Path, message: dict[str, Any],
                 timeout: float = CONTROL_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Send one control command to a running supervisor."""

    payload = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
    if len(payload) > MAX_CONTROL_FRAME_BYTES:
        raise SupervisorError("control request exceeds the frame cap")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(socket_path))
        client.sendall(payload)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_CONTROL_FRAME_BYTES:
                raise SupervisorError("control response exceeds the frame cap")
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        return json.loads(b"".join(chunks).decode("utf-8").split("\n", 1)[0])
    finally:
        client.close()


@dataclass
class Supervisor:
    """Owns the pointer, ingests the spool, and fires the clocks."""

    state_dir: Path
    anchors_dir: str | None = None
    poll_interval: float = 0.5
    python_executable: str = field(default_factory=lambda: sys.executable)
    #: Whether this supervisor owns a serve child. Off in unit tests that only
    #: exercise the clocks; on in production and in the integration test.
    manage_serve: bool = False
    store: ResidentStore = field(init=False)
    serve_process: Any = field(default=None, init=False)
    _active_child: Any = field(default=None, init=False)
    _stop_event: Any = field(default=None, init=False)
    _serve_failures: int = field(default=0, init=False)
    _serve_retry_at: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        self.store = ResidentStore.open(self.state_dir)
        # Use the store's *resolved* path. Children resolve it themselves, and
        # the runtime directory is keyed by a hash of it — so an unresolved
        # path here (on macOS /var/folders symlinks to /private/var/folders)
        # makes the supervisor watch a socket the child never creates.
        self.state_dir = self.store.state_dir
        # Promotion recovery runs inside ResidentStore.open; canary recovery
        # needs the pointer and the activation rows together, so it runs here.
        canary_module.recover(self.store)

    def close(self) -> None:
        self.store.close()

    # --- clocks ------------------------------------------------------------

    def _anchors(self) -> tuple[Any, Any, Any]:
        identity, _gate, budget, serving = load_all_anchors(
            resolve_anchors_dir(self.anchors_dir)
        )
        return identity, budget, serving

    def _anchor_drift(self, identity: Any) -> str | None:
        """The anchor field that changed since init, or None."""

        recorded = self.store.get_config(CONFIG_THRESHOLD_IDENTITY)
        if not recorded:
            return "unrecorded"
        try:
            expected = ThresholdIdentity.from_dict(json.loads(recorded))
        except (json.JSONDecodeError, KeyError, TypeError):
            return "unreadable"
        return expected.mismatch_field(identity)

    @staticmethod
    def _elapsed(stamp: str | None) -> float | None:
        if not stamp:
            return None
        try:
            when = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            return None
        return (datetime.now(timezone.utc) - when).total_seconds()

    def _due(self, clock: str, key: str, interval_seconds: int) -> bool:
        """Whether this clock should fire, honouring the retry backoff."""

        since_success = self._elapsed(self.store.get_config(key))
        if since_success is not None and since_success < interval_seconds:
            return False

        failures = int(self.store.get_config(CONFIG_FAILURES.format(clock=clock)) or 0)
        if failures:
            backoff = min(interval_seconds, RETRY_BASE_SECONDS * (2 ** (failures - 1)))
            since_attempt = self._elapsed(
                self.store.get_config(CONFIG_LAST_ATTEMPT.format(clock=clock))
            )
            if since_attempt is not None and since_attempt < backoff:
                return False
        return True

    def _run_clock(self, clock: str, success_key: str, *command: str) -> dict[str, Any]:
        """Fire one clock and record the outcome honestly.

        Only a child that actually succeeded advances the success timestamp.
        A failure records the attempt and increments the failure count, so the
        backoff applies and the work is retried rather than silently skipped
        until the next interval.
        """

        self.store.set_config(CONFIG_LAST_ATTEMPT.format(clock=clock), utcnow())
        outcome = self._spawn(*command)
        if outcome.get("ok"):
            self.store.set_config(success_key, utcnow())
            self.store.set_config(CONFIG_FAILURES.format(clock=clock), "0")
            self.store.set_config(CONFIG_LAST_ERROR.format(clock=clock), "")
        else:
            failures = int(self.store.get_config(CONFIG_FAILURES.format(clock=clock)) or 0)
            self.store.set_config(
                CONFIG_FAILURES.format(clock=clock),
                str(min(failures + 1, MAX_RECORDED_FAILURES)),
            )
            self.store.set_config(
                CONFIG_LAST_ERROR.format(clock=clock),
                # Structured only: a child's stderr can quote a query.
                json.dumps(
                    {
                        "returncode": outcome.get("returncode"),
                        "error": outcome.get("error", ""),
                        "at": utcnow(),
                    }
                ),
            )
        return outcome

    def tick(self) -> dict[str, Any]:
        """One supervisor iteration. Returns what it did, for tests and logs."""

        result: dict[str, Any] = {"ingested": 0, "reflected": False, "audited": False}
        report = ingest(self.store)
        result["ingested"] = report.inserted

        try:
            identity, limits, serving = self._anchors()
        except ThresholdError as exc:
            # Without anchors there are no intervals to honour and no gate to
            # enforce; the clocks stop rather than guessing.
            result["error"] = f"anchors unusable: {exc}"
            # Anchors define the canary's own limits and the guard patterns a
            # running canary is judged by, so it cannot be supervised without
            # them. Unusable anchors are at least as dangerous as changed ones,
            # and are handled identically: clear, freeze, stop reflecting —
            # while audit and rollback stay available.
            self._contain(f"serving anchors unusable: {exc}", result,
                          trigger={"anchor_error": type(exc).__name__})
            return result

        # An anchor edited after init changes the canary's own limits and the
        # guard patterns a running canary is judged by, so a live canary can no
        # longer be supervised under the terms it was activated on.
        drift = self._anchor_drift(identity)
        if drift is not None:
            result["anchor_drift"] = drift
            self._contain(
                f"anchor files changed since init ({drift})",
                result,
                trigger={"mismatch_field": drift},
            )
            return result

        # A champion hard veto observed while serving: the failing answer was
        # already withheld, and this is what stops it recurring. The pointer is
        # never moved automatically — choosing what to serve instead is a human
        # decision, and rollback stays available.
        champion_breach = self._champion_breach(serving)
        if champion_breach is not None:
            result["champion_veto"] = champion_breach
            self._contain(
                f"champion {champion_breach['candidate_id'][:12]} tripped a hard veto "
                f"while serving ({champion_breach['veto']})",
                result,
                trigger=champion_breach,
                clear_canary=False,
            )
            return result

        # Acting on what serve spooled is the supervisor's job: the serving
        # process holds a read-only connection and cannot clear a canary or
        # freeze by itself.
        reverted = canary_module.enforce(self.store, serving, anchors_dir=self.anchors_dir)
        if reverted is not None:
            result["canary_auto_reverted"] = reverted

        frozen = is_frozen(self.store)
        result["frozen"] = frozen

        # Reflection is forward motion, so a freeze stops it.
        if not frozen and self._due(
            "reflect", CONFIG_LAST_REFLECT, limits.reflect_interval_seconds
        ):
            result["reflected"] = True
            result["reflect"] = self._run_clock(
                "reflect", CONFIG_LAST_REFLECT, "reflect-once"
            )

        # A shutdown requested while the reflection child was running must not
        # launch a second one-shot child on the way out.
        if self._stop_event is not None and self._stop_event.is_set():
            result["stopping"] = True
            return result

        # The audit clock runs regardless of the freeze.
        if self._due("audit", CONFIG_LAST_AUDIT, limits.audit_interval_seconds):
            result["audited"] = True
            result["audit"] = self._run_clock(
                "audit", CONFIG_LAST_AUDIT, "audit", "--all-unaudited"
            )

        if result["reflected"] or result["audited"]:
            self.store.append_event(
                CLOCK_EVENT,
                payload={
                    "reflected": result["reflected"],
                    "audited": result["audited"],
                    "frozen": frozen,
                },
            )
        return result

    def _child_argv(self, *command: str) -> list[str]:
        if command[0] == "serve":
            # The serving child runs its own entry point rather than the CLI:
            # cli.py imports the gate, the promoter and the auditor, and a
            # process that holds none of them is a stronger statement than one
            # that merely never calls them.
            argv = [
                self.python_executable, "-s", "-B", "-m",
                "godel_agent_prototype.resident.serve",
                "--state-dir", str(self.state_dir),
            ]
            if self.anchors_dir:
                argv.extend(["--anchors-dir", str(self.anchors_dir)])
            return argv
        argv = [
            self.python_executable, "-s", "-B", "-m",
            "godel_agent_prototype.resident",
            "--state-dir", str(self.state_dir),
            *command,
        ]
        if self.anchors_dir and command[0] == "audit":
            argv.extend(["--anchors-dir", str(self.anchors_dir)])
        return argv

    def _child_environment(self) -> dict[str, str]:
        """Minimal trusted-child environment, plus the chosen anchor source."""

        environment = _minimal_environment()
        if self.anchors_dir:
            # reflect-once has no --anchors-dir flag; its budget guard resolves
            # the same human-owned anchors through the documented environment
            # variable. Candidate workers still receive the stricter minimal
            # environment from their own runner.
            environment[ANCHORS_DIR_ENV_VAR] = str(self.anchors_dir)
        return environment

    def _contain(
        self,
        reason: str,
        result: dict[str, Any],
        trigger: dict[str, Any] | None = None,
        clear_canary: bool = True,
    ) -> None:
        """Clear the canary if asked, then freeze. Never moves the champion."""

        if clear_canary and canary_module.active_pointer(self.store) is not None:
            canary_module.clear(self.store, reason=reason, actor="supervisor", auto=True)
            result["canary_cleared"] = True
        if not is_frozen(self.store):
            freeze_module.freeze(
                self.store, reason=reason, actor="supervisor", trigger=dict(trigger or {})
            )
        result["frozen"] = True

    def _champion_breach(self, serving: Any) -> dict[str, Any] | None:
        """An ingested champion veto that matches the champion serving now.

        Matched against the current pointer on purpose: a veto recorded against
        an artifact that is no longer champion describes a problem that has
        already been replaced.
        """

        champion = self.store.read_champion()
        if champion is None:
            return None
        since = (
            datetime.now(timezone.utc)
            - timedelta(seconds=serving.canary_observation_window_seconds)
        ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        for row in self.store.list_serving_vetoes(kind="champion_veto", since=since):
            if (
                row["candidate_id"] == champion.candidate_id
                and row["artifact_hash"] == champion.artifact_hash
            ):
                return {
                    "candidate_id": row["candidate_id"],
                    "artifact_hash": row["artifact_hash"],
                    "veto": row["veto"],
                    "observation_id": row["observation_id"],
                }
        return None

    def _spawn(self, *command: str, timeout: float = 900.0) -> dict[str, Any]:
        """Run one owned child, interruptibly, and record only safe metadata.

        The child gets the same minimal environment the candidate runner uses,
        which is what makes the package importable: running with an empty
        environment from the state directory, ``python -m
        godel_agent_prototype.resident`` cannot find the package at all, and
        every clock tick would fail with an unexplained exit code 1.

        ``subprocess.run`` cannot be interrupted cleanly by the supervisor's
        shutdown event. Holding the ``Popen`` handle makes ownership explicit:
        SIGTERM stops only this child, and launchd shutdown cannot orphan it.
        """

        argv = self._child_argv(*command)
        try:
            process = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(self.state_dir),
                env=self._child_environment(),
                close_fds=True,
                start_new_session=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return {"command": command[0], "ok": False, "error": type(exc).__name__}

        self._active_child = process
        deadline = time.monotonic() + timeout
        stdout = ""
        stderr = ""
        try:
            while True:
                if self._stop_event is not None and self._stop_event.is_set():
                    self._terminate_owned(process, grace=1.0)
                    return {
                        "command": command[0],
                        "ok": False,
                        "returncode": process.returncode,
                        "error": "shutdown_requested",
                        "stderr_bytes": 0,
                    }
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._terminate_owned(process)
                    return {
                        "command": command[0],
                        "ok": False,
                        "returncode": process.returncode,
                        "error": "TimeoutExpired",
                        "stderr_bytes": 0,
                    }
                try:
                    stdout, stderr = process.communicate(timeout=min(0.2, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        finally:
            self._active_child = None

        return {
            "command": command[0],
            "ok": process.returncode == 0,
            "returncode": process.returncode,
            # stderr can quote a query, so only its length is kept.
            "stderr_bytes": len(stderr or ""),
        }

    # --- the owned serve child ----------------------------------------------

    def serve_socket_path(self) -> Path:
        return runtime_dir_for(self.state_dir) / "serve.sock"

    def _serve_alive(self) -> bool:
        return self.serve_process is not None and self.serve_process.poll() is None

    def ensure_serve(self) -> dict[str, Any] | None:
        """Start the serve child if it is not running. Returns what happened.

        Only ever touches the ``Popen`` handle this supervisor created — no PID
        is read from a file and signalled, because a stale PID file can name a
        process that is now something else entirely.
        """

        if not self.manage_serve or self._serve_alive():
            return None

        exited = None
        if self.serve_process is not None:
            exited = self.serve_process.poll()
            self.serve_process = None
            self._serve_failures = min(self._serve_failures + 1, 10)
            self.store.append_event(
                SERVE_EVENT,
                payload={"event": "exited", "returncode": exited,
                         "failures": self._serve_failures},
            )

        now = time.monotonic()
        if now < self._serve_retry_at:
            return {"event": "backoff", "retry_in": round(self._serve_retry_at - now, 2)}

        try:
            process = subprocess.Popen(
                self._child_argv("serve"),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=str(self.state_dir),
                env=_minimal_environment(),
                close_fds=True,
                start_new_session=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            self._serve_failures = min(self._serve_failures + 1, 10)
            self._serve_retry_at = time.monotonic() + self._serve_backoff()
            self.store.append_event(
                SERVE_EVENT, payload={"event": "start_failed", "error": type(exc).__name__}
            )
            return {"event": "start_failed", "error": type(exc).__name__}

        socket_path = self.serve_socket_path()
        deadline = time.monotonic() + SERVE_READY_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if socket_path.exists():
                self.serve_process = process
                self._serve_failures = 0
                self._serve_retry_at = 0.0
                self.store.append_event(
                    SERVE_EVENT, payload={"event": "started", "pid": process.pid}
                )
                return {"event": "started", "pid": process.pid}
            if process.poll() is not None:
                break
            time.sleep(0.1)

        # Never became ready: reap it rather than leaving an orphan behind.
        self._terminate_owned(process)
        self._serve_failures = min(self._serve_failures + 1, 10)
        self._serve_retry_at = time.monotonic() + self._serve_backoff()
        self.store.append_event(
            SERVE_EVENT,
            payload={"event": "not_ready", "failures": self._serve_failures},
        )
        return {"event": "not_ready"}

    def _serve_backoff(self) -> float:
        return min(
            SERVE_RESTART_MAX_SECONDS,
            SERVE_RESTART_BASE_SECONDS * (2 ** max(0, self._serve_failures - 1)),
        )

    def _terminate_owned(self, process: Any, grace: float = 5.0) -> None:
        """Stop a child this supervisor started, and only that child."""

        if process is None or process.poll() is not None:
            return
        try:
            pgid = os.getpgid(process.pid)
        except (ProcessLookupError, OSError):
            return
        owns_group = pgid == process.pid
        try:
            if owns_group:
                os.killpg(pgid, signal.SIGTERM)
            else:
                process.terminate()
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            process.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            if owns_group:
                os.killpg(pgid, signal.SIGKILL)
            else:
                process.kill()
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass

    def stop_serve(self) -> None:
        if self.serve_process is not None:
            self._terminate_owned(self.serve_process)
            self.store.append_event(SERVE_EVENT, payload={"event": "stopped"})
            self.serve_process = None

    # --- control channel ---------------------------------------------------

    def handle_control(self, message: dict[str, Any]) -> dict[str, Any]:
        command = message.get("command")
        if command not in CONTROL_COMMANDS:
            return {"ok": False, "error": f"unknown command {command!r}"}
        try:
            if command == "status":
                champion = self.store.read_champion()
                return {
                    "ok": True,
                    "champion": champion.candidate_id if champion else None,
                    "frozen": is_frozen(self.store),
                }
            if command == "ingest":
                return {"ok": True, "report": ingest(self.store).to_dict()}
            if command == "canary_set":
                from .canary import activate

                pointer = activate(
                    self.store,
                    message["candidate_id"],
                    percent=int(message["percent"]),
                    reason=message.get("reason", ""),
                    actor=message.get("actor", ""),
                    anchors_dir=self.anchors_dir,
                )
                return {"ok": True, "canary": pointer.public_dict() if pointer else None}
            if command == "canary_clear":
                from .canary import clear

                activation_id = clear(
                    self.store,
                    reason=message.get("reason", ""),
                    actor=message.get("actor", ""),
                )
                return {"ok": True, "cleared": activation_id}
            if command == "promote":
                from .promote import promote

                champion = promote(
                    self.store,
                    message["candidate_id"],
                    reason=message.get("reason", ""),
                    actor=message.get("actor", ""),
                    anchors_dir=self.anchors_dir,
                )
                return {"ok": True, "champion": champion.to_dict() if champion else None}
            from .rollback import rollback

            champion = rollback(
                self.store,
                reason=message.get("reason", ""),
                actor=message.get("actor", ""),
                anchors_dir=self.anchors_dir,
                target_candidate_id=message.get("target"),
            )
            return {"ok": True, "champion": champion.to_dict()}
        except ResidentError as exc:
            return {"ok": False, "error": str(exc)}
        except KeyError as exc:
            return {"ok": False, "error": f"missing field {exc}"}

    def _accept_one(self, server: socket.socket) -> None:
        try:
            conn, _ = server.accept()
        except socket.timeout:
            return
        except OSError:
            return
        with conn:
            conn.settimeout(CONTROL_TIMEOUT_SECONDS)
            try:
                chunks: list[bytes] = []
                total = 0
                while True:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_CONTROL_FRAME_BYTES:
                        raise ValueError("control frame exceeds the cap")
                    chunks.append(chunk)
                    if b"\n" in chunk:
                        break
                message = json.loads(b"".join(chunks).decode("utf-8").split("\n", 1)[0])
                if not isinstance(message, dict):
                    raise ValueError("control frame is not an object")
                response = self.handle_control(message)
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                response = {"ok": False, "error": "malformed control request"}
            except socket.timeout:
                return
            try:
                conn.sendall((json.dumps(response, default=str) + "\n").encode("utf-8"))
            except OSError:
                pass

    def run(self, stop: Any = None, max_ticks: int | None = None, ready: Any = None) -> None:
        socket_path = control_socket_path(self.state_dir)
        prepare_socket_path(self.state_dir)  # validates ownership and permissions
        socket_path.unlink(missing_ok=True)
        effective_stop = stop if stop is not None else threading.Event()
        self._stop_event = effective_stop

        with SupervisorLock(self.state_dir, socket_path):
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                server.bind(str(socket_path))
                os.chmod(socket_path, 0o600)
                server.listen(8)
                server.settimeout(self.poll_interval)
                self.store.append_event(
                    SUPERVISOR_EVENT, payload={"event": "started", "pid": os.getpid()}
                )
                last_heartbeat = time.monotonic()
                if ready is not None:
                    ready.set()
                ticks = 0
                while not effective_stop.is_set():
                    self.ensure_serve()
                    self._accept_one(server)
                    self.tick()
                    now = time.monotonic()
                    if now - last_heartbeat >= SUPERVISOR_HEARTBEAT_INTERVAL_SECONDS:
                        self.store.append_event(
                            SUPERVISOR_EVENT,
                            payload={"event": "heartbeat", "pid": os.getpid()},
                        )
                        last_heartbeat = now
                    ticks += 1
                    if max_ticks is not None and ticks >= max_ticks:
                        break
            finally:
                self.stop_serve()
                self.store.append_event(
                    SUPERVISOR_EVENT, payload={"event": "stopped", "pid": os.getpid()}
                )
                server.close()
                socket_path.unlink(missing_ok=True)
                self._stop_event = None

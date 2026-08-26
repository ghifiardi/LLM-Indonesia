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
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .anchors import ThresholdError, load_all_anchors, resolve_anchors_dir
from .freeze import is_frozen
from .serve import prepare_socket_path, runtime_dir_for
from .spool import ingest
from .store import ResidentError, ResidentStore, utcnow

CONFIG_LAST_REFLECT = "last_reflect_at"
CONFIG_LAST_AUDIT = "last_audit_at"

SUPERVISOR_LOCK_NAME = "supervisor.lock"
CONTROL_SOCKET_NAME = "control.sock"

MAX_CONTROL_FRAME_BYTES = 32 * 1024
CONTROL_TIMEOUT_SECONDS = 120.0

#: Commands the control channel accepts. Deliberately small: the channel exists
#: so pointer changes have one writer, not to become a second CLI.
CONTROL_COMMANDS = frozenset({"promote", "rollback", "status", "ingest"})

CLOCK_EVENT = "clock_fired"


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
    store: ResidentStore = field(init=False)

    def __post_init__(self) -> None:
        self.state_dir = Path(self.state_dir)
        self.store = ResidentStore.open(self.state_dir)

    def close(self) -> None:
        self.store.close()

    # --- clocks ------------------------------------------------------------

    def _limits(self) -> Any:
        _identity, _gate, budget, _serving = load_all_anchors(
            resolve_anchors_dir(self.anchors_dir)
        )
        return budget

    def _due(self, key: str, interval_seconds: int) -> bool:
        last = self.store.get_config(key)
        if not last:
            return True
        try:
            when = datetime.strptime(last, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            return True
        return (datetime.now(timezone.utc) - when).total_seconds() >= interval_seconds

    def tick(self) -> dict[str, Any]:
        """One supervisor iteration. Returns what it did, for tests and logs."""

        result: dict[str, Any] = {"ingested": 0, "reflected": False, "audited": False}
        report = ingest(self.store)
        result["ingested"] = report.inserted

        try:
            limits = self._limits()
        except ThresholdError as exc:
            # Without anchors there are no intervals to honour and no gate to
            # enforce; the clocks stop rather than guessing.
            result["error"] = f"anchors unusable: {exc}"
            return result

        frozen = is_frozen(self.store)
        result["frozen"] = frozen

        # Reflection is forward motion, so a freeze stops it.
        if not frozen and self._due(CONFIG_LAST_REFLECT, limits.reflect_interval_seconds):
            result["reflected"] = True
            result["reflect"] = self._spawn("reflect-once")
            self.store.set_config(CONFIG_LAST_REFLECT, utcnow())

        # The audit clock runs regardless of the freeze.
        if self._due(CONFIG_LAST_AUDIT, limits.audit_interval_seconds):
            result["audited"] = True
            result["audit"] = self._spawn("audit", "--all-unaudited")
            self.store.set_config(CONFIG_LAST_AUDIT, utcnow())

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

    def _spawn(self, *command: str, timeout: float = 900.0) -> dict[str, Any]:
        """Run a one-shot child. Its failure is recorded, never raised."""

        argv = [
            self.python_executable, "-s", "-B", "-m",
            "godel_agent_prototype.resident",
            "--state-dir", str(self.state_dir),
            *command,
        ]
        if self.anchors_dir and command[0] in ("reflect-once", "audit"):
            argv.extend(["--anchors-dir", str(self.anchors_dir)])
        try:
            completed = subprocess.run(
                argv, capture_output=True, text=True, timeout=timeout,
                cwd=str(self.state_dir),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return {"command": command[0], "ok": False, "error": type(exc).__name__}
        return {
            "command": command[0],
            "ok": completed.returncode == 0,
            "returncode": completed.returncode,
            # stderr can quote a query, so only its tail length is kept.
            "stderr_bytes": len(completed.stderr or ""),
        }

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

        with SupervisorLock(self.state_dir, socket_path):
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                server.bind(str(socket_path))
                os.chmod(socket_path, 0o600)
                server.listen(8)
                server.settimeout(self.poll_interval)
                if ready is not None:
                    ready.set()
                ticks = 0
                while stop is None or not stop.is_set():
                    self._accept_one(server)
                    self.tick()
                    ticks += 1
                    if max_ticks is not None and ticks >= max_ticks:
                        break
            finally:
                server.close()
                socket_path.unlink(missing_ok=True)

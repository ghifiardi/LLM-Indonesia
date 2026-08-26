"""Production candidate runner: a separate, resource-limited child process.

Named ``subprocess_runner`` rather than ``subprocess`` so nothing in this
package shadows the standard-library module for a reader.

What the parent controls
------------------------

* a fresh temporary working directory the child cannot escape by accident, and
  a *separate* parent-owned directory for capture files, so the child cannot
  overwrite its own stdout capture;
* a minimal environment — no PATH, no HOME, no credentials, no proxy or model
  configuration, no user site directory (``-s``);
* ``close_fds=True``: no inherited descriptors;
* ``start_new_session=True``: the child leads its own process group, so a
  timeout can reap the whole group and nothing else;
* stdout and stderr redirected to regular files, not pipes. ``communicate()``
  buffers pipe output in parent memory *before* any size check, which is no cap
  at all; files plus ``RLIMIT_FSIZE`` plus a bounded read-back is one;
* wall-clock timeout with an explicit SIGTERM, grace period, SIGKILL sequence.

What the child sets on itself, pre-exec: ``RLIMIT_CPU``, ``RLIMIT_FSIZE``,
``RLIMIT_CORE=0``, ``RLIMIT_NPROC``, and ``RLIMIT_AS`` only where that limit
actually works (see ``limits``).

Every failure — timeout, signal, non-zero exit, malformed or truncated output —
becomes a structured status, never an exception escaping to the caller.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..models import (
    STATUS_RESOURCE_LIMIT,
    STATUS_RUNNER_CRASH,
    STATUS_RUNNER_PROTOCOL,
    STATUS_TIMEOUT,
    ScoreVector,
)
from .base import CandidateRunner, EvaluationOutcome
from .limits import (
    CORE_LIMIT_SUPPORTED,
    CPU_LIMIT_SUPPORTED,
    ENFORCED,
    FILE_SIZE_LIMIT_SUPPORTED,
    MEMORY_LIMIT_SUPPORTED,
    PROCESS_LIMIT_SUPPORTED,
    RunnerLimits,
    profile_for,
)
from .protocol import (
    EXIT_OVERSIZED_REQUEST,
    EXIT_UNREADABLE_REQUEST,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    MAX_STDERR_BYTES,
    MAX_STDOUT_BYTES,
    ProtocolError,
    build_evaluate_request,
    encode,
    parse_response,
)

try:  # pragma: no cover - platform dependent
    import resource
except ImportError:
    resource = None  # type: ignore[assignment]


WORKER_MODULE = "godel_agent_prototype.resident.runner.worker"

#: Package parent, so the child can import the package with a single trusted
#: PYTHONPATH entry rather than inheriting the parent's sys.path.
_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _minimal_environment() -> dict[str, str]:
    """The smallest environment the worker needs.

    No PATH (the interpreter is invoked by absolute path), no HOME, no
    credentials, no proxy variables, no model configuration, no user-specific
    Python paths. PYTHONHASHSEED is pinned so runs are reproducible.
    """

    return {
        "PYTHONHASHSEED": "0",
        "PYTHONPATH": str(_PROJECT_ROOT),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def _build_preexec(limits: RunnerLimits):
    """Return a pre-exec hook applying rlimits, or None where unsupported.

    Each limit is applied defensively: a platform that refuses one must not
    prevent the others from taking effect. Limits that cannot be set are already
    reported as unenforced in the isolation profile.
    """

    if resource is None:
        return None

    def apply_limits() -> None:  # pragma: no cover - runs in the child
        def _try(what: int, value: tuple[int, int]) -> None:
            try:
                resource.setrlimit(what, value)
            except (ValueError, OSError):
                pass

        if CPU_LIMIT_SUPPORTED and limits.cpu_seconds > 0:
            _try(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
        if FILE_SIZE_LIMIT_SUPPORTED and limits.file_size_bytes > 0:
            _try(resource.RLIMIT_FSIZE, (limits.file_size_bytes, limits.file_size_bytes))
        if CORE_LIMIT_SUPPORTED:
            _try(resource.RLIMIT_CORE, (0, 0))
        if PROCESS_LIMIT_SUPPORTED and limits.max_processes is not None:
            _try(resource.RLIMIT_NPROC, (limits.max_processes, limits.max_processes))
        if MEMORY_LIMIT_SUPPORTED and limits.address_space_bytes is not None:
            _try(
                resource.RLIMIT_AS,
                (limits.address_space_bytes, limits.address_space_bytes),
            )

    return apply_limits


def _read_capped(path: Path, cap: int) -> tuple[bytes, bool]:
    """Read at most ``cap + 1`` bytes; the flag says whether the cap was passed."""

    try:
        with open(path, "rb") as handle:
            data = handle.read(cap + 1)
    except OSError:
        return b"", False
    if len(data) > cap:
        return data[:cap], True
    return data, False


def _terminate_group(process: subprocess.Popen, grace_seconds: float) -> None:
    """Reap the process group this runner created. Never signals another group."""

    try:
        pgid = os.getpgid(process.pid)
    except (ProcessLookupError, OSError):
        return

    # start_new_session made the child its own group leader. If that is somehow
    # not true, signal only the process itself rather than someone else's group.
    owns_group = pgid == process.pid
    try:
        if owns_group:
            os.killpg(pgid, signal.SIGTERM)
        else:
            process.terminate()
    except (ProcessLookupError, PermissionError, OSError):
        pass

    try:
        process.wait(timeout=grace_seconds)
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
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        pass


@dataclass
class SubprocessCandidateRunner(CandidateRunner):
    """Execute a candidate in an isolated child process."""

    limits: RunnerLimits = field(default_factory=RunnerLimits)
    name: str = "subprocess"
    python_executable: str = field(default_factory=lambda: sys.executable)

    def evaluate(
        self,
        policy_source: str,
        environment_name: str,
        public_snapshot: list[dict[str, Any]],
        limits: RunnerLimits | None = None,
    ) -> EvaluationOutcome:
        limits = limits or self.limits
        profile = profile_for(limits)

        request = build_evaluate_request(
            policy_source=policy_source,
            environment_name=environment_name,
            public_snapshot=public_snapshot,
            limits=limits.to_dict(),
        )
        body = encode(request)
        if len(body) > MAX_REQUEST_BYTES:
            # Checked before spawning: never pay for a process that cannot work.
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"request of {len(body)} bytes exceeds the {MAX_REQUEST_BYTES} byte cap",
                isolation=profile,
            )

        with tempfile.TemporaryDirectory(prefix="resident-capture-") as capture_dir, \
                tempfile.TemporaryDirectory(prefix="resident-work-") as work_dir:
            stdout_path = Path(capture_dir) / "stdout.bin"
            stderr_path = Path(capture_dir) / "stderr.bin"
            return self._run_once(
                body, limits, profile, Path(work_dir), stdout_path, stderr_path
            )

    def _run_once(
        self,
        body: bytes,
        limits: RunnerLimits,
        profile: Any,
        work_dir: Path,
        stdout_path: Path,
        stderr_path: Path,
    ) -> EvaluationOutcome:
        timed_out = False
        try:
            with open(stdout_path, "wb") as out_handle, open(stderr_path, "wb") as err_handle:
                try:
                    process = subprocess.Popen(
                        [self.python_executable, "-s", "-B", "-m", WORKER_MODULE],
                        stdin=subprocess.PIPE,
                        stdout=out_handle,
                        stderr=err_handle,
                        cwd=str(work_dir),
                        env=_minimal_environment(),
                        close_fds=True,
                        start_new_session=True,
                        preexec_fn=_build_preexec(limits),
                    )
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    # No silent in-process fallback. A runner that cannot start
                    # is a failed evaluation, not a reason to run untrusted code
                    # in the parent.
                    return EvaluationOutcome(
                        status=STATUS_RUNNER_CRASH,
                        error=f"could not start worker: {type(exc).__name__}: {exc}",
                        isolation=profile,
                    )

                try:
                    process.communicate(body, timeout=limits.wall_clock_seconds)
                except subprocess.TimeoutExpired:
                    # communicate() raising does not stop the child.
                    timed_out = True
                    _terminate_group(process, limits.grace_period_seconds)
                except (BrokenPipeError, OSError):
                    _terminate_group(process, limits.grace_period_seconds)
        except OSError as exc:
            return EvaluationOutcome(
                status=STATUS_RUNNER_CRASH,
                error=f"could not open capture files: {exc}",
                isolation=profile,
            )

        returncode = process.poll()
        if returncode is None:
            _terminate_group(process, limits.grace_period_seconds)
            returncode = process.poll()

        stdout_bytes, stdout_overflow = _read_capped(stdout_path, MAX_STDOUT_BYTES)
        stderr_bytes, stderr_overflow = _read_capped(stderr_path, MAX_STDERR_BYTES)
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")

        exit_code = returncode if (returncode is not None and returncode >= 0) else None
        signal_number = -returncode if (returncode is not None and returncode < 0) else None

        if timed_out:
            return EvaluationOutcome(
                status=STATUS_TIMEOUT,
                error=(
                    f"candidate exceeded the {limits.wall_clock_seconds}s wall clock; "
                    "process group terminated"
                ),
                isolation=profile.observing(notes=profile.notes + ("terminated by timeout",)),
                exit_code=exit_code,
                signal_number=signal_number,
            )

        if stdout_overflow:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"worker stdout exceeded {MAX_STDOUT_BYTES} bytes",
                isolation=profile,
                exit_code=exit_code,
                signal_number=signal_number,
            )

        if signal_number is not None:
            return self._classify_signal(signal_number, stderr_text, profile, stderr_overflow)

        if returncode == EXIT_OVERSIZED_REQUEST:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error="worker rejected the request as oversized",
                isolation=profile,
                exit_code=exit_code,
            )
        if returncode == EXIT_UNREADABLE_REQUEST:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"worker could not read the request: {stderr_text[:500]}",
                isolation=profile,
                exit_code=exit_code,
            )
        if returncode != 0:
            return EvaluationOutcome(
                status=STATUS_RUNNER_CRASH,
                error=f"worker exited with code {returncode}: {stderr_text[:500]}",
                isolation=profile,
                exit_code=exit_code,
            )

        try:
            response = parse_response(stdout_bytes)
        except ProtocolError as exc:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"{exc}",
                isolation=profile,
                exit_code=exit_code,
            )

        if not response["ok"]:
            observed = profile
            if response.get("memory_error"):
                observed = profile.observing(memory_limit_enforced=ENFORCED)
            return EvaluationOutcome(
                status=response.get("status") or STATUS_RUNNER_PROTOCOL,
                error=response.get("error", ""),
                isolation=observed,
                exit_code=exit_code,
            )

        score = response.get("score")
        if not isinstance(score, dict) or "combined" not in score:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error="worker reported success without a score vector",
                isolation=profile,
                exit_code=exit_code,
            )
        try:
            scores = ScoreVector.from_dict(score)
        except (KeyError, TypeError, ValueError) as exc:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"malformed score vector: {exc}",
                isolation=profile,
                exit_code=exit_code,
            )
        return EvaluationOutcome(
            scores=scores,
            feedback=response.get("feedback", ""),
            isolation=profile,
            exit_code=exit_code,
        )

    def _classify_signal(
        self, signal_number: int, stderr_text: str, profile: Any, stderr_overflow: bool
    ) -> EvaluationOutcome:
        """Map a fatal signal to a status without over-claiming the cause.

        A raw SIGKILL is ambiguous — the OS memory manager, an operator, or a
        supervisor could all have sent it — so it is a crash unless something
        actually observed a limit breach. SIGXCPU and SIGXFSZ are unambiguous:
        the kernel sends them precisely because a limit was exceeded.
        """

        name = signal.Signals(signal_number).name if signal_number in set(
            s.value for s in signal.Signals
        ) else str(signal_number)

        if signal_number == int(signal.SIGXCPU):
            return EvaluationOutcome(
                status=STATUS_RESOURCE_LIMIT,
                error=f"candidate exceeded the CPU limit (signal {name})",
                isolation=profile.observing(cpu_limit_enforced=ENFORCED),
                signal_number=signal_number,
            )
        if hasattr(signal, "SIGXFSZ") and signal_number == int(signal.SIGXFSZ):
            return EvaluationOutcome(
                status=STATUS_RESOURCE_LIMIT,
                error=f"candidate exceeded the file-size limit (signal {name})",
                isolation=profile,
                signal_number=signal_number,
            )
        return EvaluationOutcome(
            status=STATUS_RUNNER_CRASH,
            error=(
                f"worker died on signal {name} ({signal_number}); cause unattributed. "
                f"stderr: {stderr_text[:300]}"
            ),
            isolation=profile.observing(
                notes=profile.notes + (f"unattributed fatal signal {name}",)
            ),
            signal_number=signal_number,
        )

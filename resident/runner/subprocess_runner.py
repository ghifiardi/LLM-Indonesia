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
from .base import BatchOutcome, CandidateRunner, EvaluationOutcome
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
    KIND_EVALUATE,
    KIND_EXECUTE_BATCH,
    build_execute_batch_request,
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


@dataclass(frozen=True)
class _RawRun:
    """What one child process produced, before any protocol interpretation."""

    stdout: bytes
    stdout_overflow: bool
    stderr_text: str
    exit_code: int | None
    signal_number: int | None
    timed_out: bool


@dataclass
class SubprocessCandidateRunner(CandidateRunner):
    """Execute a candidate in an isolated child process.

    Serves both protocol kinds. ``evaluate`` is used by reflection;
    ``execute_batch`` is used by the holdout auditor controller, which spawns
    its *own* runner so candidate code never runs beside holdout labels.
    """

    limits: RunnerLimits = field(default_factory=RunnerLimits)
    name: str = "subprocess"
    python_executable: str = field(default_factory=lambda: sys.executable)

    # --- public API --------------------------------------------------------

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
        raw, failure = self._run(request, limits, profile)
        if failure is not None:
            return failure
        assert raw is not None

        problem = self._classify_process(raw, limits, profile)
        if problem is not None:
            return problem

        try:
            response = parse_response(raw.stdout, expected_kind=KIND_EVALUATE)
        except ProtocolError as exc:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL, error=str(exc),
                isolation=profile, exit_code=raw.exit_code,
            )

        if not response["ok"]:
            observed = profile
            if response.get("memory_error"):
                observed = profile.observing(memory_limit_enforced=ENFORCED)
            return EvaluationOutcome(
                status=response.get("status") or STATUS_RUNNER_PROTOCOL,
                error=response.get("error", ""),
                isolation=observed,
                exit_code=raw.exit_code,
            )

        score = response.get("score")
        if not isinstance(score, dict) or "combined" not in score:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error="worker reported success without a score vector",
                isolation=profile, exit_code=raw.exit_code,
            )
        try:
            scores = ScoreVector.from_dict(score)
        except (KeyError, TypeError, ValueError) as exc:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"malformed score vector: {exc}",
                isolation=profile, exit_code=raw.exit_code,
            )
        return EvaluationOutcome(
            scores=scores,
            feedback=response.get("feedback", ""),
            isolation=profile,
            exit_code=raw.exit_code,
        )

    def execute_batch(
        self,
        policy_source: str,
        artifact_hash: str,
        inputs: list[Any],
        kb: dict[str, Any],
        limits: RunnerLimits | None = None,
    ) -> BatchOutcome:
        """Run a candidate over unlabeled inputs and return bounded outputs.

        The child receives queries, the permitted KB, the policy, and its
        limits. It receives no reference answers, no required or forbidden
        terms, and no rubric — nothing it could use to recognise what it is
        being scored against.
        """

        limits = limits or self.limits
        profile = profile_for(limits)
        request = build_execute_batch_request(
            policy_source=policy_source,
            artifact_hash=artifact_hash,
            inputs=inputs,
            kb=kb,
            limits=limits.to_dict(),
        )
        raw, failure = self._run(request, limits, profile)
        if failure is not None:
            return BatchOutcome(
                status=failure.status, error=failure.error,
                isolation=failure.isolation, exit_code=failure.exit_code,
                signal_number=failure.signal_number,
            )
        assert raw is not None

        problem = self._classify_process(raw, limits, profile)
        if problem is not None:
            return BatchOutcome(
                status=problem.status, error=problem.error,
                isolation=problem.isolation, exit_code=problem.exit_code,
                signal_number=problem.signal_number,
            )

        try:
            response = parse_response(raw.stdout, expected_kind=KIND_EXECUTE_BATCH)
        except ProtocolError as exc:
            return BatchOutcome(
                status=STATUS_RUNNER_PROTOCOL, error=str(exc),
                isolation=profile, exit_code=raw.exit_code,
            )
        if not response["ok"]:
            return BatchOutcome(
                status=response.get("status") or STATUS_RUNNER_PROTOCOL,
                error=response.get("error", ""),
                isolation=profile, exit_code=raw.exit_code,
            )
        outputs = response.get("outputs")
        if not isinstance(outputs, list) or len(outputs) != len(inputs):
            return BatchOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=(
                    f"worker returned {len(outputs) if isinstance(outputs, list) else '?'} "
                    f"outputs for {len(inputs)} inputs"
                ),
                isolation=profile, exit_code=raw.exit_code,
            )
        return BatchOutcome(outputs=outputs, isolation=profile, exit_code=raw.exit_code)

    # --- shared machinery --------------------------------------------------

    def _run(
        self, request: dict[str, Any], limits: RunnerLimits, profile: Any
    ) -> tuple[_RawRun | None, EvaluationOutcome | None]:
        body = encode(request)
        if len(body) > MAX_REQUEST_BYTES:
            # Checked before spawning: never pay for a process that cannot work.
            return None, EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"request of {len(body)} bytes exceeds the {MAX_REQUEST_BYTES} byte cap",
                isolation=profile,
            )
        with tempfile.TemporaryDirectory(prefix="resident-capture-") as capture_dir, \
                tempfile.TemporaryDirectory(prefix="resident-work-") as work_dir:
            return self._spawn(
                body,
                limits,
                profile,
                Path(work_dir),
                Path(capture_dir) / "stdout.bin",
                Path(capture_dir) / "stderr.bin",
            )

    def _spawn(
        self,
        body: bytes,
        limits: RunnerLimits,
        profile: Any,
        work_dir: Path,
        stdout_path: Path,
        stderr_path: Path,
    ) -> tuple[_RawRun | None, EvaluationOutcome | None]:
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
                    # is a failed execution, not a reason to run untrusted code
                    # in this process.
                    return None, EvaluationOutcome(
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
            return None, EvaluationOutcome(
                status=STATUS_RUNNER_CRASH,
                error=f"could not open capture files: {exc}",
                isolation=profile,
            )

        returncode = process.poll()
        if returncode is None:
            _terminate_group(process, limits.grace_period_seconds)
            returncode = process.poll()

        stdout_bytes, stdout_overflow = _read_capped(stdout_path, MAX_STDOUT_BYTES)
        stderr_bytes, _ = _read_capped(stderr_path, MAX_STDERR_BYTES)
        return (
            _RawRun(
                stdout=stdout_bytes,
                stdout_overflow=stdout_overflow,
                stderr_text=stderr_bytes.decode("utf-8", errors="replace"),
                exit_code=returncode if (returncode is not None and returncode >= 0) else None,
                signal_number=-returncode if (returncode is not None and returncode < 0) else None,
                timed_out=timed_out,
            ),
            None,
        )

    def _classify_process(
        self, raw: _RawRun, limits: RunnerLimits, profile: Any
    ) -> EvaluationOutcome | None:
        """Failure outcome, or None if the child exited cleanly enough to parse."""

        if raw.timed_out:
            return EvaluationOutcome(
                status=STATUS_TIMEOUT,
                error=(
                    f"candidate exceeded the {limits.wall_clock_seconds}s wall clock; "
                    "process group terminated"
                ),
                isolation=profile.observing(notes=profile.notes + ("terminated by timeout",)),
                exit_code=raw.exit_code,
                signal_number=raw.signal_number,
            )
        if raw.stdout_overflow:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"worker stdout exceeded {MAX_STDOUT_BYTES} bytes",
                isolation=profile,
                exit_code=raw.exit_code,
                signal_number=raw.signal_number,
            )
        if raw.signal_number is not None:
            return self._classify_signal(raw.signal_number, raw.stderr_text, profile)
        if raw.exit_code == EXIT_OVERSIZED_REQUEST:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error="worker rejected the request as oversized",
                isolation=profile, exit_code=raw.exit_code,
            )
        if raw.exit_code == EXIT_UNREADABLE_REQUEST:
            return EvaluationOutcome(
                status=STATUS_RUNNER_PROTOCOL,
                error=f"worker could not read the request: {raw.stderr_text[:500]}",
                isolation=profile, exit_code=raw.exit_code,
            )
        if raw.exit_code != 0:
            return EvaluationOutcome(
                status=STATUS_RUNNER_CRASH,
                error=f"worker exited with code {raw.exit_code}: {raw.stderr_text[:500]}",
                isolation=profile, exit_code=raw.exit_code,
            )
        return None

    def _classify_signal(
        self, signal_number: int, stderr_text: str, profile: Any
    ) -> EvaluationOutcome:
        """Map a fatal signal to a status without over-claiming the cause.

        A raw SIGKILL is ambiguous — the OS memory manager, an operator, or a
        supervisor could all have sent it — so it is a crash unless something
        actually observed a limit breach. SIGXCPU and SIGXFSZ are unambiguous:
        the kernel sends them precisely because a limit was exceeded.
        """

        try:
            name = signal.Signals(signal_number).name
        except ValueError:
            name = str(signal_number)

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

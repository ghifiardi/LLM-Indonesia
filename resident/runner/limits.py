"""Resource limits and honest reporting of what actually contained a run.

Platform support here is measured, not assumed. On this project's darwin
(arm64, CPython 3.14) the following was observed directly:

* ``RLIMIT_CPU``   — settable, and enforced: a spinning child dies on SIGXCPU.
* ``RLIMIT_FSIZE`` — settable.
* ``RLIMIT_CORE``  — settable.
* ``RLIMIT_NPROC`` — settable, but **user-scoped, not process-scoped**. It caps
  the total processes owned by the UID, so setting a small absolute value fails
  every ``fork`` in the child the moment the developer's own session already
  exceeds it. It is off by default for that reason; see ``RunnerLimits``.
* ``RLIMIT_AS``    — **unusable**: ``setrlimit`` in the pre-exec hook kills the
  child before ``exec``, at 512 MiB, 1 GiB and 2 GiB alike.
* ``RLIMIT_DATA``  — unusable for the same reason.

So on darwin there is no working address-space limit through the standard
library, and the wall-clock timeout is the only backstop against a memory hog.
The profile says exactly that rather than reporting a limit that was requested
but never took effect.

Booleans in an ``IsolationProfile`` mean *verified*. Anything unverified is the
string ``"unknown"``. Enforcement that was actually observed during a run — a
SIGXCPU kill, a worker-reported ``MemoryError`` — is upgraded to ``"true"`` on
that run's profile.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field, replace
from typing import Any

try:  # pragma: no cover - exercised by platform, not by branch
    import resource
except ImportError:  # Windows
    resource = None  # type: ignore[assignment]


#: Tri-state enforcement values. Never use a bare bool for these.
ENFORCED = "true"
NOT_ENFORCED = "false"
UNKNOWN = "unknown"

_IS_DARWIN = sys.platform == "darwin"

#: RLIMIT_AS is present on darwin but kills the child when set; see module docs.
MEMORY_LIMIT_SUPPORTED = bool(
    resource is not None and hasattr(resource, "RLIMIT_AS") and not _IS_DARWIN
)
CPU_LIMIT_SUPPORTED = bool(resource is not None and hasattr(resource, "RLIMIT_CPU"))
FILE_SIZE_LIMIT_SUPPORTED = bool(resource is not None and hasattr(resource, "RLIMIT_FSIZE"))
PROCESS_LIMIT_SUPPORTED = bool(resource is not None and hasattr(resource, "RLIMIT_NPROC"))
CORE_LIMIT_SUPPORTED = bool(resource is not None and hasattr(resource, "RLIMIT_CORE"))


@dataclass(frozen=True)
class RunnerLimits:
    """Limits requested for one candidate execution.

    ``address_space_bytes`` defaults to None on platforms where the limit does
    not work, so the default configuration never requests something that cannot
    be delivered.
    """

    wall_clock_seconds: float = 30.0
    grace_period_seconds: float = 2.0
    cpu_seconds: int = 20
    address_space_bytes: int | None = (1024 * 1024 * 1024) if MEMORY_LIMIT_SUPPORTED else None
    file_size_bytes: int = 8 * 1024 * 1024
    #: Off by default. ``RLIMIT_NPROC`` counts every process the *user* owns,
    #: not the ones this child spawns, so any absolute value small enough to be
    #: a meaningful limit is also small enough to break the worker on a busy
    #: machine — observed here as "fork: Resource temporarily unavailable"
    #: before the worker could run at all. A candidate cannot spawn processes
    #: anyway: the AST gate permits no imports. Set it only when you control
    #: the UID's total process count.
    max_processes: int | None = None
    #: Per-case cap on what ``solve()`` may return, applied inside the worker
    #: before any accumulation, so a candidate cannot exhaust memory by
    #: returning enormous strings across many cases.
    max_output_chars: int = 8192

    def to_dict(self) -> dict[str, Any]:
        return {
            "wall_clock_seconds": self.wall_clock_seconds,
            "grace_period_seconds": self.grace_period_seconds,
            "cpu_seconds": self.cpu_seconds,
            "address_space_bytes": self.address_space_bytes,
            "file_size_bytes": self.file_size_bytes,
            "max_processes": self.max_processes,
            "max_output_chars": self.max_output_chars,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RunnerLimits":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in payload.items() if k in known})


@dataclass(frozen=True)
class IsolationProfile:
    """What actually contained an execution.

    Recorded on every verdict. ``executed=False`` means no child ever ran — the
    candidate was rejected by a parent-side pre-check — and in that case the
    isolation fields describe nothing and say so.
    """

    executed: bool = True
    mechanism: str = "subprocess+setrlimit"
    platform: str = sys.platform
    process_isolated: bool = True
    working_directory_isolated: bool = True
    clean_environment: bool = True

    cpu_limit_requested: bool = False
    cpu_limit_enforced: str = UNKNOWN
    cpu_limit_mechanism: str = "RLIMIT_CPU"

    memory_limit_requested: bool = False
    memory_limit_enforced: str = UNKNOWN
    memory_limit_mechanism: str = "RLIMIT_AS"

    file_size_limit_requested: bool = False
    process_count_limit_requested: bool = False
    core_dumps_disabled: bool = False

    #: A standard-library subprocess gets a scratch cwd and a stripped
    #: environment. It does not get a filesystem or network namespace, and
    #: nothing here should imply otherwise. Real containment needs a container
    #: or an OS sandbox profile, which is a deployment decision.
    filesystem_isolated: bool = False
    network_isolated: bool = False

    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "executed": self.executed,
            "mechanism": self.mechanism,
            "platform": self.platform,
            "process_isolated": self.process_isolated,
            "working_directory_isolated": self.working_directory_isolated,
            "clean_environment": self.clean_environment,
            "cpu_limit_requested": self.cpu_limit_requested,
            "cpu_limit_enforced": self.cpu_limit_enforced,
            "cpu_limit_mechanism": self.cpu_limit_mechanism,
            "memory_limit_requested": self.memory_limit_requested,
            "memory_limit_enforced": self.memory_limit_enforced,
            "memory_limit_mechanism": self.memory_limit_mechanism,
            "file_size_limit_requested": self.file_size_limit_requested,
            "process_count_limit_requested": self.process_count_limit_requested,
            "core_dumps_disabled": self.core_dumps_disabled,
            "filesystem_isolated": self.filesystem_isolated,
            "network_isolated": self.network_isolated,
            "notes": list(self.notes),
        }

    def observing(self, **changes: Any) -> "IsolationProfile":
        """Return a copy upgraded with enforcement actually observed this run."""

        return replace(self, **changes)


def profile_for(limits: RunnerLimits, mechanism: str = "subprocess+setrlimit") -> IsolationProfile:
    """Build the profile for a run about to happen, before any observation."""

    notes: list[str] = []
    memory_requested = limits.address_space_bytes is not None and MEMORY_LIMIT_SUPPORTED
    if limits.max_processes is None:
        notes.append(
            "process-count limiting disabled: RLIMIT_NPROC is user-scoped and "
            "cannot bound one child without risking the whole session"
        )
    if not MEMORY_LIMIT_SUPPORTED:
        notes.append(
            "address-space limiting unavailable on this platform; "
            "the wall-clock timeout is the only backstop against memory growth"
        )
    return IsolationProfile(
        executed=True,
        mechanism=mechanism,
        process_isolated=True,
        cpu_limit_requested=CPU_LIMIT_SUPPORTED and limits.cpu_seconds > 0,
        cpu_limit_enforced=UNKNOWN if CPU_LIMIT_SUPPORTED else NOT_ENFORCED,
        memory_limit_requested=memory_requested,
        memory_limit_enforced=UNKNOWN if memory_requested else NOT_ENFORCED,
        file_size_limit_requested=FILE_SIZE_LIMIT_SUPPORTED and limits.file_size_bytes > 0,
        process_count_limit_requested=PROCESS_LIMIT_SUPPORTED and limits.max_processes is not None,
        core_dumps_disabled=CORE_LIMIT_SUPPORTED,
        notes=tuple(notes),
    )


def early_rejection_profile(reason: str = "parent_precheck") -> IsolationProfile:
    """Profile for a candidate rejected before any child process started."""

    return IsolationProfile(
        executed=False,
        mechanism=reason,
        process_isolated=False,
        working_directory_isolated=False,
        clean_environment=False,
        cpu_limit_enforced=NOT_ENFORCED,
        memory_limit_enforced=NOT_ENFORCED,
        notes=("candidate was never executed",),
    )


def in_process_profile() -> IsolationProfile:
    """Profile for the test-only in-process runner. Contains nothing, says so."""

    return IsolationProfile(
        executed=True,
        mechanism="in_process",
        process_isolated=False,
        working_directory_isolated=False,
        clean_environment=False,
        cpu_limit_enforced=NOT_ENFORCED,
        memory_limit_enforced=NOT_ENFORCED,
        notes=("in-process runner: no isolation of any kind; tests only",),
    )

"""Isolated execution of candidate policies.

``base.CandidateRunner`` is the contract; ``subprocess_runner`` is the
production implementation; ``worker`` is the child entry point.

The runner receives canonical policy *source* and serialisable environment
records — never a Python callable and never a filesystem path to a dataset.
Anything the child is not handed, it cannot read.
"""

from __future__ import annotations

from .base import CandidateRunner, EvaluationOutcome, InProcessCandidateRunner
from .limits import (
    ENFORCED,
    IsolationProfile,
    MEMORY_LIMIT_SUPPORTED,
    NOT_ENFORCED,
    RunnerLimits,
    UNKNOWN,
    early_rejection_profile,
)
from .protocol import (
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    MAX_STDERR_BYTES,
    MAX_STDOUT_BYTES,
    PROTOCOL_VERSION,
    ProtocolError,
    build_evaluate_request,
    parse_evaluate_request,
    parse_response,
)
from .subprocess_runner import SubprocessCandidateRunner

__all__ = [
    "CandidateRunner",
    "ENFORCED",
    "EvaluationOutcome",
    "InProcessCandidateRunner",
    "IsolationProfile",
    "MAX_REQUEST_BYTES",
    "MAX_RESPONSE_BYTES",
    "MAX_STDERR_BYTES",
    "MAX_STDOUT_BYTES",
    "MEMORY_LIMIT_SUPPORTED",
    "NOT_ENFORCED",
    "PROTOCOL_VERSION",
    "ProtocolError",
    "RunnerLimits",
    "SubprocessCandidateRunner",
    "UNKNOWN",
    "build_evaluate_request",
    "early_rejection_profile",
    "parse_evaluate_request",
    "parse_response",
]

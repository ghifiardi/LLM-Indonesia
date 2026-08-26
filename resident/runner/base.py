"""The candidate-execution contract.

``SubprocessCandidateRunner`` is the production implementation and the default
everywhere in the resident. ``InProcessCandidateRunner`` exists for focused unit
tests and is **never** selected as a fallback: if a subprocess cannot start,
that is an archived ``rejected_runner_crash``, not a quiet downgrade to running
untrusted code in the parent.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Protocol

from ...godel_agent import Environment, EvaluationResult, PolicyValidationError, SafePolicyLoader
from ..eval_records import build_environment_from_records
from ..models import (
    STATUS_RETURN_TYPE,
    STATUS_RUNTIME,
    STATUS_SYNTAX,
    STATUS_VALIDATION,
    ScoreVector,
)
from .limits import IsolationProfile, RunnerLimits, in_process_profile


@dataclass(frozen=True)
class EvaluationOutcome:
    """Result of one candidate execution.

    ``scores`` is None whenever ``status`` is set: the execution produced no
    usable public score and the status says why.
    """

    scores: ScoreVector | None = None
    feedback: str = ""
    error: str = ""
    status: str = ""
    isolation: IsolationProfile = field(default_factory=IsolationProfile)
    exit_code: int | None = None
    signal_number: int | None = None

    @property
    def ok(self) -> bool:
        return self.scores is not None and not self.status


@dataclass(frozen=True)
class BatchOutcome:
    """Result of executing a candidate over a batch of unlabeled inputs.

    Carries candidate outputs, which are for the auditor controller's eyes only:
    they are scored inside the controller and never returned to the resident
    parent, where they would be a channel for holdout content to escape.
    """

    outputs: list[Any] | None = None
    status: str = ""
    error: str = ""
    isolation: IsolationProfile = field(default_factory=IsolationProfile)
    exit_code: int | None = None
    signal_number: int | None = None

    @property
    def ok(self) -> bool:
        return self.outputs is not None and not self.status


class CandidateRunner(Protocol):
    """Executes one candidate against one public environment.

    Takes canonical policy *source* and serialisable environment records, not a
    Python callable and not a dataset path — what the child is not handed, it
    cannot read.
    """

    name: str

    def evaluate(
        self,
        policy_source: str,
        environment_name: str,
        public_snapshot: list[dict[str, Any]],
        limits: RunnerLimits,
    ) -> EvaluationOutcome:
        ...


def score_vector_from_result(result: EvaluationResult) -> ScoreVector:
    public = result.public if isinstance(result.public, dict) else {}
    private = result.private if isinstance(result.private, dict) else {}
    cases = public.get("cases")
    num_cases = len(cases) if isinstance(cases, list) else int(private.get("num_cases", 0) or 0)
    return ScoreVector(
        combined=float(result.combined_score),
        num_cases=num_cases,
        category_means=dict(public.get("category_means") or {}),
        dimension_means=dict(public.get("dimension_means") or {}),
    )


def cap_policy_output(policy: Any, max_chars: int) -> Any:
    """Wrap a policy so each returned string is capped before it accumulates.

    Environments collect one answer per case before scoring, so an uncapped
    candidate could exhaust memory across many cases without any single return
    looking unusual. Capping at the source bounds the total.

    Truncation is deliberate rather than raising: a truncated answer simply
    scores badly, which is the correct outcome for a candidate that returns
    megabytes.
    """

    def capped(query: Any, kb: Any) -> Any:
        result = policy(query, kb)
        if isinstance(result, str) and len(result) > max_chars:
            return result[:max_chars]
        return result

    return capped


def evaluate_in_process(
    policy_source: str,
    environment: Environment,
    limits: RunnerLimits,
    profile: IsolationProfile,
) -> EvaluationOutcome:
    """Validate, run, and classify — the body both runners share.

    In the subprocess runner this executes inside the child. Validation here is
    independent of any parent-side pre-check: the worker never trusts that the
    parent gate ran, because the value of the second gate is precisely that it
    catches a wrong first gate.
    """

    try:
        policy = SafePolicyLoader().load(policy_source)
    except PolicyValidationError as exc:
        message = str(exc)
        status = STATUS_SYNTAX if message.startswith("Syntax error") else STATUS_VALIDATION
        return EvaluationOutcome(status=status, error=message, isolation=profile)

    guarded = cap_policy_output(policy, limits.max_output_chars)
    try:
        result = environment.evaluate(guarded)
    except Exception as exc:
        return EvaluationOutcome(
            status=STATUS_RUNTIME,
            error=f"{type(exc).__name__}: {exc}",
            isolation=profile,
        )

    if not isinstance(result, EvaluationResult):
        return EvaluationOutcome(
            status=STATUS_RETURN_TYPE,
            error=f"environment returned {type(result).__name__}, expected EvaluationResult",
            isolation=profile,
        )
    score = result.combined_score
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
        return EvaluationOutcome(
            status=STATUS_RETURN_TYPE,
            error=f"combined_score is not a finite number: {score!r}",
            isolation=profile,
        )
    return EvaluationOutcome(
        scores=score_vector_from_result(result),
        feedback=(result.text_feedback or "")[:2000],
        isolation=profile,
    )


@dataclass
class InProcessCandidateRunner(CandidateRunner):
    """Runs the candidate in this process. **Tests only — isolates nothing.**

    Never reachable by fallback. A caller has to construct one deliberately.
    """

    environment: Environment | None = None
    name: str = "in-process"

    def evaluate(
        self,
        policy_source: str,
        environment_name: str,
        public_snapshot: list[dict[str, Any]],
        limits: RunnerLimits,
    ) -> EvaluationOutcome:
        profile = in_process_profile()
        environment = self.environment
        if environment is None:
            try:
                environment = build_environment_from_records(environment_name, public_snapshot)
            except ValueError as exc:
                return EvaluationOutcome(
                    status=STATUS_RUNTIME, error=str(exc), isolation=profile
                )
        return evaluate_in_process(policy_source, environment, limits, profile)

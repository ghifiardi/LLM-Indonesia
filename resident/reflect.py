"""One audited reflection cycle.

``reflect_once`` reads persisted experiences and the archive, asks a mutation
provider for one candidate, gates it, evaluates it, and archives a structured
verdict. It does exactly that and stops.

Two things it deliberately does not do:

* **It never touches the champion.** This module imports nothing from
  ``promote`` and never calls ``store.write_champion``. Promotion is a separate,
  human-invoked command. There is no flag that changes this.
* **It never opens the holdout.** Reflection evaluates against a public-only
  snapshot written into the state directory by ``init``, and never reads the
  source eval set. The full dataset is opened exactly once, by ``init``, to
  reproduce the deterministic split; only public cases are written out, and the
  holdout half is never persisted, evaluated, passed to a mutator, logged, or
  named in a verdict. Every verdict records ``holdout_evaluated=False``. The
  isolated holdout auditor is Phase 2.

A state directory is bound to one environment at ``init``. Reflection refuses a
different one, so candidates from different task domains cannot share an archive
or a champion pointer.

Every failure mode ends in an archived verdict rather than an exception:
no candidate offered, provider error, syntax error, sandbox validation failure,
evaluation exception, malformed evaluation result, and plain non-improvement.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..code_agent_env import make_indonesian_phone_normalizer_env
from ..code_mutator import RuleBasedCodeMutator
from ..dataset_env import (
    DEFAULT_KB,
    DatasetSupportEnvironment,
    EvalCase,
    load_cases_from_dir,
    split_cases_for_holdout,
)
from ..demo_indonesia_support import INITIAL_POLICY as ID_SUPPORT_SEED_POLICY
from ..godel_agent import (
    Environment,
    EvaluationResult,
    PolicyValidationError,
    SafePolicyLoader,
)
from ..rule_based_mutator import RuleBasedIndonesianSupportMutator
from .archive import CandidateArchive
from .experience import ExperienceLog
from .models import (
    Candidate,
    ScoreVector,
    STATUS_IMPROVEMENT,
    STATUS_NO_CANDIDATE,
    STATUS_NO_IMPROVEMENT,
    STATUS_PROVIDER_ERROR,
    STATUS_RETURN_TYPE,
    STATUS_RUNTIME,
    STATUS_SYNTAX,
    STATUS_VALIDATION,
    TIER_POLICY,
    Verdict,
)
from .mutators import (
    MutationProviderAdapter,
    MutationRequest,
    Mutator,
)
from .store import (
    CONFIG_ENVIRONMENT,
    EnvironmentMismatchError,
    ResidentNotInitializedError,
    ResidentStore,
)


PACKAGE_ROOT = Path(__file__).resolve().parent.parent
EVAL_SETS_DIR = PACKAGE_ROOT / "eval_sets"

#: Improvement must exceed the parent by more than this to be recorded as an
#: improvement. Phase 1 keeps it at zero and simply labels the verdict; the
#: noise-threshold gate that *acts* on it is Phase 3.
DEFAULT_MIN_DELTA = 0.0

CODE_TASK_SEED_POLICY = '''
def solve(query, kb):
    return str(query)
'''


# --- environment registry ---------------------------------------------------


@dataclass(frozen=True)
class EnvironmentSpec:
    """A task the resident can reflect on.

    ``prepare`` runs once during ``init`` and may read source datasets, holdout
    included, in order to reproduce a deterministic split. ``build_environment``
    runs during every reflection and must read nothing but the state directory.
    Keeping these apart is what makes the public-only boundary a property of the
    code rather than a convention.
    """

    name: str
    description: str
    prepare: Callable[[ResidentStore], None]
    build_environment: Callable[[ResidentStore], Environment]
    seed_policy: str
    build_mutator: Callable[[], Mutator]


PUBLIC_CASES_FILENAME = "public_cases.jsonl"


def write_public_cases(store: ResidentStore, cases: list[EvalCase]) -> Path:
    """Persist public eval cases into the state directory, atomically."""

    path = store.public_eval_dir / PUBLIC_CASES_FILENAME
    lines = [
        json.dumps(
            {
                "query": case.query,
                "required_terms": list(case.required_terms),
                "forbidden_terms": list(case.forbidden_terms),
                "weight": case.weight,
                "category": case.category,
                "reference_answer": case.reference_answer,
                "baseline_outputs": dict(case.baseline_outputs),
            },
            ensure_ascii=False,
        )
        for case in cases
    ]
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    tmp_path = store.public_eval_dir / f".{PUBLIC_CASES_FILENAME}.tmp"
    with open(tmp_path, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, path)
    return path


def load_public_cases(store: ResidentStore) -> list[EvalCase]:
    """Load the public-only snapshot. Never touches the source eval set."""

    try:
        return load_cases_from_dir(store.public_eval_dir)
    except (ValueError, OSError) as exc:
        raise ResidentNotInitializedError(
            f"No public evaluation snapshot in {store.public_eval_dir}: {exc}. Run "
            "`python3 -m godel_agent_prototype.resident init` first."
        ) from exc


def _prepare_id_support(store: ResidentStore) -> None:
    """Write the public half of the Indonesian support split into the state dir.

    This is the only code path in the resident that opens ``eval_sets/``, and it
    runs solely during ``init``. The holdout half is read to reproduce the
    deterministic split and is then dropped: it is not written out, evaluated,
    shown to a mutator, logged, or referenced in any verdict.
    """

    public_cases, _holdout_cases = split_cases_for_holdout(load_cases_from_dir(EVAL_SETS_DIR))
    write_public_cases(store, public_cases)


def _build_id_support_environment(store: ResidentStore) -> DatasetSupportEnvironment:
    return DatasetSupportEnvironment(cases=load_public_cases(store), kb=DEFAULT_KB)


def _prepare_code_task(store: ResidentStore) -> None:
    """No snapshot needed: the cases are defined in code and have no holdout."""


ENVIRONMENTS: dict[str, EnvironmentSpec] = {
    "id_support": EnvironmentSpec(
        name="id_support",
        description="Indonesian support rubric, public split only.",
        prepare=_prepare_id_support,
        build_environment=_build_id_support_environment,
        seed_policy=ID_SUPPORT_SEED_POLICY,
        build_mutator=lambda: MutationProviderAdapter(
            RuleBasedIndonesianSupportMutator(), name="rule-based-id-support"
        ),
    ),
    "phone_normalizer": EnvironmentSpec(
        name="phone_normalizer",
        description="Indonesian phone-number normalisation unit tests.",
        prepare=_prepare_code_task,
        build_environment=lambda store: make_indonesian_phone_normalizer_env(),
        seed_policy=CODE_TASK_SEED_POLICY,
        build_mutator=lambda: MutationProviderAdapter(
            RuleBasedCodeMutator(), name="rule-based-code"
        ),
    ),
}

DEFAULT_ENVIRONMENT = "id_support"


def get_environment_spec(name: str) -> EnvironmentSpec:
    try:
        return ENVIRONMENTS[name]
    except KeyError:
        known = ", ".join(sorted(ENVIRONMENTS))
        raise ValueError(f"Unknown environment {name!r}. Known environments: {known}.") from None


def bound_environment(store: ResidentStore) -> str:
    """The environment this state directory was initialised for."""

    name = store.get_config(CONFIG_ENVIRONMENT)
    if name is None:
        raise ResidentNotInitializedError(
            f"{store.state_dir} is not bound to an environment. Run "
            "`python3 -m godel_agent_prototype.resident init` first."
        )
    return name


def resolve_environment_spec(
    store: ResidentStore, requested: str | None = None
) -> EnvironmentSpec:
    """Resolve the environment to use, refusing a mismatch with the binding."""

    bound = bound_environment(store)
    if requested is not None and requested != bound:
        raise EnvironmentMismatchError(
            f"{store.state_dir} is bound to environment {bound!r}; refusing to run "
            f"against {requested!r}. One state directory serves one task domain — "
            "mixing them would let a candidate inherit from an unrelated parent and "
            "would make one champion pointer stand for two tasks. "
            "Use a separate --state-dir instead."
        )
    return get_environment_spec(bound)


# --- the evaluation seam ----------------------------------------------------


@dataclass(frozen=True)
class EvaluationOutcome:
    """What the seam returns: a result, or a classified failure."""

    result: EvaluationResult | None = None
    error: str = ""
    status: str = ""


def evaluate_candidate(
    policy: Callable[..., Any],
    environment: Environment,
) -> EvaluationOutcome:
    """Evaluate one loaded candidate policy against a public environment.

    **This is a replaceable seam, not a security boundary.** In Phase 1 the
    candidate runs in this process, protected only by the ``SafePolicyLoader``
    AST gate that ran before it got here. AST validation stops obvious escapes;
    it does not stop resource exhaustion, and it is not a sandbox.

    Phase 2 replaces the body of this function with a subprocess runner
    enforcing timeout, memory and CPU limits, a clean environment, an isolated
    working directory, no network, and output caps. The signature exists so that
    swap changes nothing above it. Do not add callers that bypass it, and do not
    treat its current implementation as containment.
    """

    try:
        result = environment.evaluate(policy)
    except Exception as exc:
        return EvaluationOutcome(
            error=f"{type(exc).__name__}: {exc}",
            status=STATUS_RUNTIME,
        )

    if not isinstance(result, EvaluationResult):
        return EvaluationOutcome(
            error=f"environment returned {type(result).__name__}, expected EvaluationResult",
            status=STATUS_RETURN_TYPE,
        )
    score = result.combined_score
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
        return EvaluationOutcome(
            error=f"combined_score is not a finite number: {score!r}",
            status=STATUS_RETURN_TYPE,
        )
    return EvaluationOutcome(result=result)


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


# --- reflection -------------------------------------------------------------


@dataclass(frozen=True)
class ReflectionOutcome:
    """Result of one cycle. Always returned; never raised past ordinary errors."""

    cycle: int
    candidate: Candidate
    parent_candidate_id: str | None
    environment: str
    mutator: str

    @property
    def verdict(self) -> Verdict:
        return self.candidate.verdict

    @property
    def candidate_id(self) -> str:
        return self.candidate.candidate_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "cycle": self.cycle,
            "environment": self.environment,
            "mutator": self.mutator,
            "parent_candidate_id": self.parent_candidate_id,
            "candidate": self.candidate.to_dict(),
        }


REFLECT_CYCLE_EVENT = "reflect_cycle"


def reflect_once(
    store: ResidentStore,
    env_name: str | None = None,
    environment: Environment | None = None,
    mutator: Mutator | None = None,
    tier: str = TIER_POLICY,
    min_delta: float = DEFAULT_MIN_DELTA,
    loader: SafePolicyLoader | None = None,
) -> ReflectionOutcome:
    """Run one reflection cycle and archive its verdict.

    Requires an established champion: reflection selects a parent from the
    archive, and an empty archive means the resident was never initialised.

    ``env_name`` is optional and defaults to the environment this state
    directory is bound to. Passing a different one raises rather than mixing
    task domains in one archive.
    """

    spec = resolve_environment_spec(store, env_name)
    store.require_champion()

    archive = CandidateArchive(store)
    experiences = ExperienceLog(store)
    loader = loader or SafePolicyLoader()
    environment = environment if environment is not None else spec.build_environment(store)
    mutator = mutator if mutator is not None else spec.build_mutator()

    cycle = store.count_events(kind=REFLECT_CYCLE_EVENT) + 1

    parent = archive.select_parent(cycle)
    if parent is None or parent.artifact_hash is None:
        raise ResidentNotInitializedError(
            "No selectable parent in the archive. Run "
            "`python3 -m godel_agent_prototype.resident init` first."
        )

    parent_code = store.read_artifact(parent.artifact_hash)
    parent_score = parent.public_score
    best = archive.best()
    best_score = best.public_score if best is not None else parent_score

    request = MutationRequest(
        parent_code=parent_code,
        cycle=cycle,
        parent_score=parent_score,
        best_score=best_score,
        feedback=experiences.feedback_digest(),
        history_tail=_history_tail(archive),
    )
    proposal = mutator.propose(request)

    common = {
        "origin": proposal.origin,
        "parent_candidate_id": parent.candidate_id,
        "rationale": proposal.rationale,
        "tier": tier,
        "cycle": cycle,
    }
    base_reasons: tuple[str, ...] = ()
    if proposal.dropped_alternatives:
        base_reasons += (
            f"provider offered {proposal.dropped_alternatives + 1} candidates; "
            "kept the first and dropped the rest",
        )

    def finish(verdict: Verdict, artifact_hash: str | None) -> ReflectionOutcome:
        candidate = archive.add(verdict=verdict, artifact_hash=artifact_hash, **common)
        store.append_event(
            REFLECT_CYCLE_EVENT,
            candidate_id=candidate.candidate_id,
            payload={
                "cycle": cycle,
                "environment": spec.name,
                "mutator": proposal.origin,
                "status": verdict.status,
                "parent_candidate_id": parent.candidate_id,
                "artifact_hash": artifact_hash,
                "public_score": verdict.public_score,
                "delta": verdict.delta,
            },
        )
        return ReflectionOutcome(
            cycle=cycle,
            candidate=candidate,
            parent_candidate_id=parent.candidate_id,
            environment=spec.name,
            mutator=proposal.origin,
        )

    # 1. No candidate at all. Still archived: "the provider proposed nothing on
    #    cycle N" is a fact about the run.
    if not proposal.has_candidate:
        status = STATUS_PROVIDER_ERROR if "raised" in proposal.reason else STATUS_NO_CANDIDATE
        reasons = base_reasons + ((proposal.reason,) if proposal.reason else ())
        return finish(
            Verdict(
                status=status,
                detail=proposal.reason or "no candidate offered",
                reasons=reasons,
                parent_score=parent_score,
            ),
            artifact_hash=None,
        )

    # 2. Store the artifact before gating, so rejected code stays inspectable.
    artifact_hash = store.write_artifact(
        proposal.code or "",
        metadata={
            "cycle": cycle,
            "origin": proposal.origin,
            "environment": spec.name,
            "tier": tier,
        },
    )

    # 3. AST gate. First gate, not the last one — see evaluate_candidate.
    try:
        policy = loader.load(proposal.code or "")
    except PolicyValidationError as exc:
        message = str(exc)
        status = STATUS_SYNTAX if message.startswith("Syntax error") else STATUS_VALIDATION
        return finish(
            Verdict(
                status=status,
                detail=message,
                reasons=base_reasons + (message,),
                parent_score=parent_score,
            ),
            artifact_hash=artifact_hash,
        )

    # 4. Evaluate through the seam.
    outcome = evaluate_candidate(policy, environment)
    if outcome.result is None:
        return finish(
            Verdict(
                status=outcome.status or STATUS_RUNTIME,
                detail=outcome.error,
                reasons=base_reasons + (outcome.error,),
                parent_score=parent_score,
            ),
            artifact_hash=artifact_hash,
        )

    scores = score_vector_from_result(outcome.result)
    delta = None if parent_score is None else scores.combined - parent_score
    improved = delta is not None and delta > min_delta
    status = STATUS_IMPROVEMENT if improved else STATUS_NO_IMPROVEMENT
    reasons = base_reasons
    if delta is None:
        reasons += ("parent had no recorded score; improvement undetermined",)
    elif not improved:
        reasons += (f"delta {delta:+.4f} did not exceed min_delta {min_delta:+.4f}",)

    return finish(
        Verdict(
            status=status,
            detail=(outcome.result.text_feedback or "")[:2000],
            reasons=reasons,
            scores=scores,
            parent_score=parent_score,
            delta=delta,
        ),
        artifact_hash=artifact_hash,
    )


def evaluate_policy_source(
    code: str,
    environment: Environment,
    loader: SafePolicyLoader | None = None,
) -> tuple[ScoreVector | None, str]:
    """Gate and evaluate policy source outside a reflection cycle.

    Used by ``init`` to give the seed candidate a real baseline score, and by
    ``promote`` to re-verify an artifact before it becomes champion. Returns
    ``(None, error)`` on any failure.
    """

    loader = loader or SafePolicyLoader()
    try:
        policy = loader.load(code)
    except PolicyValidationError as exc:
        return None, str(exc)
    outcome = evaluate_candidate(policy, environment)
    if outcome.result is None:
        return None, outcome.error
    return score_vector_from_result(outcome.result), ""


def _history_tail(archive: CandidateArchive, limit: int = 8) -> tuple[str, ...]:
    lines: list[str] = []
    for candidate in archive.list(limit=limit):
        score = candidate.public_score
        rendered = f"{score:.3f}" if isinstance(score, float) else "n/a"
        lines.append(f"cycle={candidate.cycle} status={candidate.verdict.status} score={rendered}")
    return tuple(reversed(lines))

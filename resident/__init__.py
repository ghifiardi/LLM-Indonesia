"""Persistence and audited single-cycle reflection for the constrained Godel-Agent.

Phase 1 of the resident roadmap: durable experiences, a durable candidate
archive that keeps failures, one structured reflection cycle, and human-only
promotion.

Three properties this package deliberately guarantees, and does not offer a way
to opt out of:

* **No automatic promotion.** ``promote`` is invoked by a person. No scheduler,
  flag, or config key promotes a candidate.
* **No holdout evaluation in this process.** Environments load the public split
  and discard the private half; every verdict records
  ``holdout_evaluated=False``. The isolated auditor is Phase 2.
* **AST validation is the first gate, not a sandbox.**
  ``reflect.evaluate_candidate`` is a replaceable seam that Phase 2 turns into a
  resource-limited subprocess runner. It is not containment today.
"""

from __future__ import annotations

from .archive import CandidateArchive, stable_unit_interval
from .experience import ExperienceLog, KNOWN_OUTCOMES
from .models import (
    Candidate,
    Champion,
    CycleEvent,
    Experience,
    REJECTED_STATUSES,
    SCORED_STATUSES,
    ScoreVector,
    STATUS_IMPROVEMENT,
    STATUS_NO_CANDIDATE,
    STATUS_NO_IMPROVEMENT,
    STATUS_PROVIDER_ERROR,
    STATUS_RETURN_TYPE,
    STATUS_RUNTIME,
    STATUS_SEED,
    STATUS_SYNTAX,
    STATUS_VALIDATION,
    TIER_POLICY,
    TIER_PROMPT,
    Verdict,
)
from .mutators import (
    MutationProposal,
    MutationProviderAdapter,
    MutationRequest,
    Mutator,
    StaticMutator,
)
from .promote import (
    AlreadyInitializedError,
    PromotionError,
    initialize,
    promote,
)
from .reflect import (
    DEFAULT_ENVIRONMENT,
    ENVIRONMENTS,
    EnvironmentSpec,
    ReflectionOutcome,
    bound_environment,
    evaluate_candidate,
    evaluate_policy_source,
    get_environment_spec,
    load_public_cases,
    reflect_once,
    resolve_environment_spec,
    write_public_cases,
)
from .store import (
    ArtifactIntegrityError,
    ArtifactMissingError,
    CONFIG_ENVIRONMENT,
    EnvironmentMismatchError,
    MIGRATIONS,
    SCHEMA_VERSION,
    ResidentError,
    ResidentNotInitializedError,
    ResidentStore,
    STATE_DIR_ENV_VAR,
    StateDirectoryError,
    canonicalize_policy,
    policy_digest,
    resolve_state_dir,
)

__all__ = [
    "SCHEMA_VERSION",
    "MIGRATIONS",
    "EnvironmentMismatchError",
    "CONFIG_ENVIRONMENT",
    "write_public_cases",
    "resolve_environment_spec",
    "load_public_cases",
    "bound_environment",
    "AlreadyInitializedError",
    "ArtifactIntegrityError",
    "ArtifactMissingError",
    "Candidate",
    "CandidateArchive",
    "Champion",
    "CycleEvent",
    "DEFAULT_ENVIRONMENT",
    "ENVIRONMENTS",
    "EnvironmentSpec",
    "Experience",
    "ExperienceLog",
    "KNOWN_OUTCOMES",
    "MutationProposal",
    "MutationProviderAdapter",
    "MutationRequest",
    "Mutator",
    "PromotionError",
    "REJECTED_STATUSES",
    "ReflectionOutcome",
    "ResidentError",
    "ResidentNotInitializedError",
    "ResidentStore",
    "SCORED_STATUSES",
    "STATE_DIR_ENV_VAR",
    "STATUS_IMPROVEMENT",
    "STATUS_NO_CANDIDATE",
    "STATUS_NO_IMPROVEMENT",
    "STATUS_PROVIDER_ERROR",
    "STATUS_RETURN_TYPE",
    "STATUS_RUNTIME",
    "STATUS_SEED",
    "STATUS_SYNTAX",
    "STATUS_VALIDATION",
    "ScoreVector",
    "StateDirectoryError",
    "StaticMutator",
    "TIER_POLICY",
    "TIER_PROMPT",
    "Verdict",
    "canonicalize_policy",
    "evaluate_candidate",
    "evaluate_policy_source",
    "get_environment_spec",
    "initialize",
    "policy_digest",
    "promote",
    "reflect_once",
    "resolve_state_dir",
    "stable_unit_interval",
]

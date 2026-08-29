"""Constrained Gödel-Agent prototype package."""

from .godel_agent import Action, EvaluationResult, GodelAgent, SafePolicyLoader, SelfState
from .dataset_env import (
    DatasetSupportEnvironment,
    EvalCase,
    HoldoutDatasetSupportEnvironment,
    load_cases_from_dir,
    score_answer,
    split_cases_for_holdout,
)
from .baselines import (
    baseline_outputs_for_case,
    generic_baseline_policy,
    keyword_baseline_policy,
    reference_output_for_case,
)
from .code_agent_env import CodeCase, CodeTaskEnvironment, make_indonesian_phone_normalizer_env
from .code_llm_mutator import CodeLLMMutationProvider, VisibleCodeExample
from .code_task_io import CodeTaskSpecError, build_code_task, load_code_task
from .recipe_archive import RecipeArchive, RecipeNode
from .recipe_mutator import mutate_recipe
from .dgm_recipe_optimizer import evolve_recipes, seed_recipe, validate_recipe
from .llm_mutator import (
    LLMMutationProvider,
    MockTransport,
    OpenAICompatibleTransport,
    extract_solve_code,
)
from .benchmark_ollama_models import benchmark_models, rank_leaderboard

__all__ = [
    "Action",
    "EvaluationResult",
    "GodelAgent",
    "SafePolicyLoader",
    "SelfState",
    "DatasetSupportEnvironment",
    "EvalCase",
    "HoldoutDatasetSupportEnvironment",
    "load_cases_from_dir",
    "score_answer",
    "split_cases_for_holdout",
    "baseline_outputs_for_case",
    "generic_baseline_policy",
    "keyword_baseline_policy",
    "reference_output_for_case",
    "CodeCase",
    "CodeTaskEnvironment",
    "CodeLLMMutationProvider",
    "CodeTaskSpecError",
    "build_code_task",
    "load_code_task",
    "make_indonesian_phone_normalizer_env",
    "VisibleCodeExample",
    "RecipeArchive",
    "RecipeNode",
    "mutate_recipe",
    "evolve_recipes",
    "seed_recipe",
    "validate_recipe",
    "LLMMutationProvider",
    "MockTransport",
    "OpenAICompatibleTransport",
    "extract_solve_code",
    "benchmark_models",
    "rank_leaderboard",
]

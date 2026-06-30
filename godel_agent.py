"""A constrained Gödel-Agent style prototype.

This is intentionally *not* an unrestricted self-modifying agent. It implements
Gödel-Agent mechanics safely enough for local experimentation:

- self_inspect: represent the current policy/improvement state as text
- interact: evaluate the current policy in an environment
- self_update: validate and monkey-patch an in-memory policy candidate
- continue_improve: recursively ask a mutation provider for the next actions

The framework only allows updates to a small, validated Python policy function:

    def solve(query: str, kb: dict) -> str: ...

No imports, file I/O, network, subprocesses, eval/exec, or arbitrary builtins are
available inside candidate policy code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import ast
import textwrap
from types import FunctionType
from typing import Any, Callable, Iterable, Literal, Protocol


ActionName = Literal["self_inspect", "interact", "self_update", "continue_improve", "think"]


@dataclass(frozen=True)
class Action:
    """One action selected by the decision/mutation provider."""

    name: ActionName
    rationale: str = ""
    code: str | None = None


@dataclass(frozen=True)
class EvaluationResult:
    """Environment feedback returned after evaluating a policy."""

    combined_score: float
    public: dict[str, Any] = field(default_factory=dict)
    private: dict[str, Any] = field(default_factory=dict)
    text_feedback: str = ""


@dataclass(frozen=True)
class SelfState:
    """Inspectable self-representation of the current agent."""

    iteration: int
    best_score: float
    current_score: float
    policy_code: str
    history_tail: tuple[str, ...]
    last_feedback: str


class Environment(Protocol):
    """Task environment interface."""

    def evaluate(self, policy: Callable[[str, dict[str, Any]], str]) -> EvaluationResult:
        ...


class MutationProvider(Protocol):
    """A planner/LLM interface that proposes recursive self-improvement actions."""

    def propose_actions(self, state: SelfState) -> list[Action]:
        ...


class PolicyValidationError(ValueError):
    """Raised when a self-update candidate violates the sandbox contract."""


class SafePolicyLoader:
    """Validate and load candidate policy code with a small builtins surface."""

    REQUIRED_FUNCTION = "solve"
    BANNED_NAMES = {
        "__import__",
        "breakpoint",
        "compile",
        "dir",
        "eval",
        "exec",
        "getattr",
        "globals",
        "help",
        "input",
        "locals",
        "memoryview",
        "open",
        "setattr",
        "vars",
    }
    BANNED_ATTRS = {
        "__class__",
        "__dict__",
        "__globals__",
        "__subclasses__",
        "__mro__",
        "__getattribute__",
        "__setattr__",
        "__delattr__",
        "func_globals",
    }
    SAFE_BUILTINS = {
        "abs": abs,
        "all": all,
        "any": any,
        "bool": bool,
        "dict": dict,
        "enumerate": enumerate,
        "float": float,
        "int": int,
        "len": len,
        "list": list,
        "max": max,
        "min": min,
        "range": range,
        "round": round,
        "set": set,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
    }

    def load(self, code: str) -> FunctionType:
        normalized = textwrap.dedent(code).strip() + "\n"
        try:
            tree = ast.parse(normalized, mode="exec")
        except SyntaxError as exc:
            raise PolicyValidationError(f"Syntax error: {exc}") from exc

        self._validate_tree(tree)
        namespace: dict[str, Any] = {"__builtins__": self.SAFE_BUILTINS}
        try:
            exec(compile(tree, "<candidate_policy>", "exec"), namespace, namespace)
        except Exception as exc:  # validation catches most issues; this catches the rest
            raise PolicyValidationError(f"Candidate failed to load: {exc}") from exc

        fn = namespace.get(self.REQUIRED_FUNCTION)
        if not isinstance(fn, FunctionType):
            raise PolicyValidationError("Candidate must define function solve(query, kb).")
        return fn

    def _validate_tree(self, tree: ast.AST) -> None:
        function_defs = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
        if len(function_defs) != 1 or function_defs[0].name != self.REQUIRED_FUNCTION:
            raise PolicyValidationError("Only one top-level function named solve is allowed.")

        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                raise PolicyValidationError("Imports are not allowed in candidate policy code.")
            if isinstance(node, (ast.ClassDef, ast.Lambda, ast.Global, ast.Nonlocal)):
                raise PolicyValidationError(f"{type(node).__name__} is not allowed.")
            if isinstance(node, ast.Name) and node.id in self.BANNED_NAMES:
                raise PolicyValidationError(f"Use of banned name {node.id!r}.")
            if isinstance(node, ast.Attribute):
                if node.attr.startswith("__") or node.attr in self.BANNED_ATTRS:
                    raise PolicyValidationError(f"Use of banned attribute {node.attr!r}.")
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in self.BANNED_NAMES:
                    raise PolicyValidationError(f"Call to banned function {node.func.id!r}.")
                if isinstance(node.func, ast.Attribute) and node.func.attr in self.BANNED_ATTRS:
                    raise PolicyValidationError(f"Call to banned attribute {node.func.attr!r}.")


@dataclass
class GodelAgent:
    """Recursive self-improvement agent with rollback-on-regression."""

    policy_code: str
    environment: Environment
    mutation_provider: MutationProvider
    max_depth: int = 6
    min_delta_to_keep: float = 0.0
    loader: SafePolicyLoader = field(default_factory=SafePolicyLoader)

    current_policy: Callable[[str, dict[str, Any]], str] = field(init=False)
    current_score: float = field(default=float("-inf"), init=False)
    best_policy_code: str = field(init=False)
    best_policy: Callable[[str, dict[str, Any]], str] = field(init=False)
    best_score: float = field(default=float("-inf"), init=False)
    last_feedback: str = field(default="", init=False)
    history: list[str] = field(default_factory=list, init=False)
    iteration: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self.policy_code = textwrap.dedent(self.policy_code).strip() + "\n"
        self.current_policy = self.loader.load(self.policy_code)
        self.best_policy_code = self.policy_code
        self.best_policy = self.current_policy

    def run(self) -> EvaluationResult:
        """Run initial evaluation then recursively improve."""

        self.execute(Action("self_inspect", "Initial self-inspection."))
        initial = self.execute(Action("interact", "Measure baseline policy."))
        self._record(f"baseline score={initial.combined_score:.3f}")
        self._self_improve(depth=0)
        return EvaluationResult(
            combined_score=self.best_score,
            public={"iterations": self.iteration, "history": list(self.history)},
            text_feedback=f"Best score: {self.best_score:.3f}",
        )

    def self_inspect(self) -> SelfState:
        return SelfState(
            iteration=self.iteration,
            best_score=self.best_score,
            current_score=self.current_score,
            policy_code=self.policy_code,
            history_tail=tuple(self.history[-8:]),
            last_feedback=self.last_feedback,
        )

    def execute(self, action: Action) -> EvaluationResult:
        """Execute one primitive action."""

        if action.name == "think":
            self._record(f"think: {action.rationale}")
            return self._status_result()

        if action.name == "self_inspect":
            state = self.self_inspect()
            self._record(
                "self_inspect: "
                f"iteration={state.iteration}, current={state.current_score:.3f}, best={state.best_score:.3f}"
            )
            return self._status_result()

        if action.name == "interact":
            result = self.environment.evaluate(self.current_policy)
            self.current_score = result.combined_score
            self.last_feedback = result.text_feedback
            if result.combined_score > self.best_score:
                self.best_score = result.combined_score
                self.best_policy_code = self.policy_code
                self.best_policy = self.current_policy
                self._record(f"interact: new best score={self.best_score:.3f}")
            else:
                self._record(f"interact: score={result.combined_score:.3f}; best={self.best_score:.3f}")
            return result

        if action.name == "self_update":
            if not action.code:
                self._record("self_update: skipped, no code supplied")
                return self._status_result()
            return self._try_update(action.code, action.rationale)

        if action.name == "continue_improve":
            # The recursive call is driven by _self_improve so this action is only a marker.
            self._record(f"continue_improve: {action.rationale}")
            return self._status_result()

        raise ValueError(f"Unknown action: {action.name}")

    def _self_improve(self, depth: int) -> None:
        if depth >= self.max_depth:
            self._record(f"stop: max_depth={self.max_depth} reached")
            return

        self.iteration += 1
        state = self.self_inspect()
        try:
            actions = self.mutation_provider.propose_actions(state)
        except Exception as exc:
            self._record(f"planner error at depth={depth}: {exc}")
            return

        if not actions:
            self._record(f"stop: planner returned no actions at depth={depth}")
            return

        should_continue = False
        for action in actions:
            try:
                self.execute(action)
            except Exception as exc:
                # Error handling is deliberate: carry the error forward instead of crashing.
                self.last_feedback = f"Action {action.name} failed: {exc}"
                self._record(f"error: {self.last_feedback}")
                break
            if action.name == "continue_improve":
                should_continue = True

        if should_continue:
            self._self_improve(depth + 1)

    def _try_update(self, candidate_code: str, rationale: str) -> EvaluationResult:
        old_code = self.policy_code
        old_policy = self.current_policy
        old_score = self.current_score

        try:
            candidate_code = textwrap.dedent(candidate_code).strip() + "\n"
            candidate_policy = self.loader.load(candidate_code)
        except PolicyValidationError as exc:
            self.last_feedback = f"Rejected invalid self_update: {exc}"
            self._record(self.last_feedback)
            return self._status_result()

        self.policy_code = candidate_code
        self.current_policy = candidate_policy
        result = self.environment.evaluate(candidate_policy)
        self.current_score = result.combined_score
        self.last_feedback = result.text_feedback

        keep_threshold = max(self.best_score, old_score) + self.min_delta_to_keep
        if result.combined_score >= keep_threshold:
            self._record(
                "self_update: kept candidate "
                f"score={result.combined_score:.3f}; rationale={rationale}"
            )
            if result.combined_score > self.best_score:
                self.best_score = result.combined_score
                self.best_policy_code = candidate_code
                self.best_policy = candidate_policy
            return result

        self.policy_code = old_code
        self.current_policy = old_policy
        self.current_score = old_score
        self.last_feedback = (
            f"Rolled back candidate score={result.combined_score:.3f}; "
            f"needed >= {keep_threshold:.3f}. Feedback: {result.text_feedback}"
        )
        self._record(f"self_update: rollback; {self.last_feedback}")
        return result

    def _status_result(self) -> EvaluationResult:
        return EvaluationResult(
            combined_score=self.current_score,
            public={"best_score": self.best_score, "iteration": self.iteration},
            text_feedback=self.last_feedback,
        )

    def _record(self, message: str) -> None:
        self.history.append(message)

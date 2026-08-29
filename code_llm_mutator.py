"""LLM-backed mutation provider for real code-generation tasks.

Unlike `RuleBasedCodeMutator`, this provider does not contain canned candidate
solutions. It asks an OpenAI-compatible model to rewrite exactly one sandboxed
function:

    def solve(query, kb): ...

The surrounding `GodelAgent` still validates the generated code, runs unit-test
feedback through `CodeTaskEnvironment`, keeps non-regressing candidates, and
rolls back invalid or worse code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .code_agent_env import CodeCase, CodeTaskEnvironment
from .godel_agent import Action, MutationProvider, SelfState
from .llm_mutator import CODE_BLOCK_RE, Transport, extract_solve_code


CODE_GEN_SYSTEM_PROMPT = (
    "You are the code-generation module of a constrained Goedel-style code agent.\n"
    "Your job is to improve exactly one Python function with this signature:\n\n"
    "    def solve(query, kb):\n"
    "        ...\n\n"
    "Rules:\n"
    "- Output exactly one fenced Python code block containing the complete solve() function.\n"
    "{import_rule}\n"
    "- Do not use pathlib, json, datetime, file/network/subprocess I/O, eval/exec, reflection, or dunder tricks.\n"
    "- Use only plain Python expressions, loops, conditionals, strings, numbers, lists, dicts, sets, tuples.\n"
    "- Prefer manual string scanning/parsing with `for` loops instead of library helpers.\n"
    "- The function must be deterministic and should return the expected value directly.\n"
    "- Read the task description, examples, and failed test feedback, then make the smallest robust fix.\n"
)


@dataclass(frozen=True)
class VisibleCodeExample:
    """Example shown to the model as public code-generation context."""

    query: Any
    expected: Any
    description: str = ""

    @classmethod
    def from_case(cls, case: CodeCase) -> "VisibleCodeExample":
        return cls(query=case.query, expected=case.expected, description=case.description)


@dataclass
class CodeLLMMutationProvider(MutationProvider):
    """Generate candidate `solve()` implementations with a real LLM transport."""

    transport: Transport
    task_description: str
    visible_examples: list[VisibleCodeExample] = field(default_factory=list)
    allowed_imports: tuple[str, ...] = ()
    temperature: float = 0.2
    max_iterations: int = 6

    @classmethod
    def from_environment(
        cls,
        env: CodeTaskEnvironment,
        transport: Transport,
        temperature: float = 0.2,
        max_iterations: int = 6,
        max_visible_examples: int | None = None,
        allowed_imports: tuple[str, ...] = (),
    ) -> "CodeLLMMutationProvider":
        """Build a provider from a `CodeTaskEnvironment`.

        All examples are public by default. For a serious benchmark, pass only a
        public training/dev subset as `env.cases` and keep hidden cases in a
        separate audit environment.
        """

        examples = [VisibleCodeExample.from_case(case) for case in env.cases]
        if max_visible_examples is not None:
            examples = examples[:max_visible_examples]
        return cls(
            transport=transport,
            task_description=_task_description_from_env(env),
            visible_examples=examples,
            allowed_imports=allowed_imports,
            temperature=temperature,
            max_iterations=max_iterations,
        )

    def propose_actions(self, state: SelfState) -> list[Action]:
        if state.current_score >= 1.0 or state.best_score >= 1.0:
            return []
        if state.iteration > self.max_iterations:
            return []

        messages = [
            {"role": "system", "content": self._system_prompt()},
            {"role": "user", "content": self._render_state(state)},
        ]
        try:
            completion = self.transport.complete(messages, self.temperature)
        except Exception as exc:
            # Keep the recursive loop safe: report the failure as feedback.
            return [Action("think", f"Code LLM call failed: {exc}")]

        code = extract_solve_code(completion)
        thought = self._extract_thought(completion)
        actions = [Action("think", thought)]
        if code:
            actions.append(Action("self_update", "LLM-generated code candidate.", code))
            actions.append(Action("continue_improve", "Use unit-test feedback for the next codegen round."))
        else:
            actions.append(Action("think", "No solve() code block found in model output."))
            actions.append(Action("continue_improve", "Retry code generation."))
        return actions

    def _render_state(self, state: SelfState) -> str:
        history = "\n".join(f"- {line}" for line in state.history_tail) or "- (none)"
        examples = "\n".join(
            (
                f"{index}. description={example.description!r}, "
                f"query={example.query!r}, expected={example.expected!r}"
            )
            for index, example in enumerate(self.visible_examples, start=1)
        ) or "(no public examples supplied)"

        return (
            f"Task description:\n{self.task_description}\n\n"
            f"Public examples / tests:\n{examples}\n\n"
            f"Iteration: {state.iteration}\n"
            f"Current score: {state.current_score}\n"
            f"Best score: {state.best_score}\n"
            f"Latest unit-test feedback: {state.last_feedback or '(none)'}\n\n"
            f"Recent history:\n{history}\n\n"
            f"Current solve() implementation:\n```python\n{state.policy_code}```\n\n"
            "Generate an improved solve() implementation now. "
            "Return exactly one fenced python code block."
        )

    def _system_prompt(self) -> str:
        if self.allowed_imports:
            import_rule = (
                "- You may use import statements only for these whitelisted modules: "
                f"{', '.join(self.allowed_imports)}. No other imports are allowed."
            )
        else:
            import_rule = (
                "- Do not output imports. Your answer will be rejected if it contains "
                "`import` or `from ... import`."
            )
        return CODE_GEN_SYSTEM_PROMPT.format(import_rule=import_rule)

    def _extract_thought(self, completion: str) -> str:
        before = CODE_BLOCK_RE.split(completion)[0].strip()
        if not before:
            return "Generated a code candidate."
        return before[:280]


def _task_description_from_env(env: CodeTaskEnvironment) -> str:
    goal = env.kb.get("goal") if isinstance(env.kb, dict) else None
    lines = [f"Task name: {env.task_name}"]
    if goal:
        lines.append(f"Goal: {goal}")
    if isinstance(env.kb, dict) and env.kb:
        lines.append(f"Metadata available in kb: {env.kb!r}")
    return "\n".join(lines)

"""LLM-backed mutation provider for the Gödel-Agent loop.

This is the decision function `f` from the paper, realized as an LLM that reads
the agent's SelfState and proposes a sequence of actions, including a candidate
rewrite of the `solve(query, kb)` policy.

Design goals:
- No third-party dependencies (uses urllib for OpenAI-compatible endpoints).
- Works with local servers (Ollama / vLLM / llama.cpp) or hosted APIs.
- Offline-testable via an injectable Transport (see MockTransport).
- Robust parsing + safe degradation: malformed LLM output yields a "think"
  action with the raw feedback rather than crashing the loop (paper's
  error-handling principle).
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .godel_agent import Action, MutationProvider, SelfState


SYSTEM_PROMPT = (
    "You are the self-improvement module of a Goedel-style agent. "
    "Your job is to improve a single Python policy function with the exact signature:\n"
    "    def solve(query: str, kb: dict) -> str\n"
    "The function answers Indonesian customer/public-service questions (banking, fraud safety, "
    "Dukcapil/NIK, NPWP/DJP). It must use only plain Python: no imports, no I/O, no eval/exec, "
    "no dunder tricks, only basic builtins (str, dict, len, any, etc.).\n\n"
    "Think briefly first, then output exactly one fenced Python code block containing the full "
    "new solve() function. Improve coverage of required Indonesian terms, keep answers concise and "
    "polite, never instruct users to share OTP/PIN, and always point to official ('resmi') channels."
)

CODE_BLOCK_RE = re.compile(r"```(?:python)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


class Transport(Protocol):
    """Minimal chat-completion transport."""

    def complete(self, messages: list[dict[str, str]], temperature: float) -> str:
        ...


@dataclass
class OpenAICompatibleTransport:
    """Calls any OpenAI-compatible /chat/completions endpoint via urllib.

    Works with hosted APIs and local servers, e.g.:
      base_url=http://localhost:11434/v1  (Ollama)
      base_url=http://localhost:8000/v1   (vLLM)
    """

    base_url: str = field(default_factory=lambda: os.environ.get("GODEL_LLM_BASE_URL", "http://localhost:11434/v1"))
    model: str = field(default_factory=lambda: os.environ.get("GODEL_LLM_MODEL", "qwen2.5:3b-instruct"))
    api_key: str = field(default_factory=lambda: os.environ.get("GODEL_LLM_API_KEY", ""))
    timeout: float = 120.0

    def complete(self, messages: list[dict[str, str]], temperature: float) -> str:
        url = self.base_url.rstrip("/") + "/chat/completions"
        payload = json.dumps(
            {"model": self.model, "messages": messages, "temperature": temperature}
        ).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as exc:  # network/sandbox failures
            raise RuntimeError(f"LLM transport error: {exc}") from exc
        return body["choices"][0]["message"]["content"]


@dataclass
class MockTransport:
    """Deterministic transport for offline tests.

    `responses` is a list of assistant message strings returned in order; the
    last one repeats once exhausted.
    """

    responses: list[str]
    calls: list[list[dict[str, str]]] = field(default_factory=list)

    def complete(self, messages: list[dict[str, str]], temperature: float) -> str:
        self.calls.append(messages)
        index = min(len(self.calls) - 1, len(self.responses) - 1)
        return self.responses[index]


def extract_solve_code(text: str) -> str | None:
    """Pull the first fenced code block that defines solve()."""

    for block in CODE_BLOCK_RE.findall(text):
        if "def solve" in block:
            return block.strip()
    if "def solve" in text:  # fallback: unfenced
        return text.strip()
    return None


@dataclass
class LLMMutationProvider(MutationProvider):
    """Turns an LLM completion into a Goedel-Agent action sequence."""

    transport: Transport
    temperature: float = 0.4
    max_iterations: int = 6

    def propose_actions(self, state: SelfState) -> list[Action]:
        if state.iteration > self.max_iterations:
            return []

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": self._render_state(state)},
        ]
        try:
            completion = self.transport.complete(messages, self.temperature)
        except Exception as exc:
            # Error-handling principle: carry error forward, do not crash the loop.
            return [Action("think", f"LLM call failed: {exc}")]

        code = extract_solve_code(completion)
        thought = self._extract_thought(completion)
        actions: list[Action] = [Action("think", thought)]
        if code:
            actions.append(Action("self_update", "LLM-proposed solve() rewrite.", code))
            actions.append(Action("continue_improve", "Evaluate next improvement round."))
        else:
            actions.append(Action("think", "No code block found in LLM output; will retry next round."))
            actions.append(Action("continue_improve", "Retry."))
        return actions

    def _render_state(self, state: SelfState) -> str:
        history = "\n".join(f"- {line}" for line in state.history_tail) or "- (none)"
        return (
            f"Iteration: {state.iteration}\n"
            f"Current score: {state.current_score}\n"
            f"Best score: {state.best_score}\n"
            f"Last environment feedback: {state.last_feedback or '(none)'}\n\n"
            f"Recent history:\n{history}\n\n"
            f"Current policy code:\n```python\n{state.policy_code}```\n\n"
            "Propose an improved solve() now. Output one fenced python code block."
        )

    def _extract_thought(self, completion: str) -> str:
        before = CODE_BLOCK_RE.split(completion)[0].strip()
        if not before:
            return "Proposed an updated policy."
        return before[:280]

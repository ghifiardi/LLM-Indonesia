"""Local/non-LLM code mutators for the safe code-agent demo.

This proves the framework can behave like a code agent without any hosted or
foreign LLM dependency. It uses deterministic, feedback-driven candidate patches.
A production local-only setup could replace this with a local code model served
via `LLMMutationProvider` + `OpenAICompatibleTransport`.
"""

from __future__ import annotations

from .godel_agent import Action, MutationProvider, SelfState


class RuleBasedCodeMutator(MutationProvider):
    """Deterministic code-improvement provider for phone-number normalization."""

    def propose_actions(self, state: SelfState) -> list[Action]:
        if state.iteration == 1:
            return [
                Action("think", "Baseline likely returns raw input. Add digit extraction and +62 conversion."),
                Action("self_update", "Implement first normalizer candidate.", POLICY_V1),
                Action("continue_improve", "Inspect failed test feedback."),
            ]
        if state.iteration == 2:
            return [
                Action("think", "Need reject invalid inputs and handle country code without plus."),
                Action("self_update", "Add validation and 62-prefix handling.", POLICY_V2),
                Action("continue_improve", "Check landline and edge cases."),
            ]
        if state.iteration == 3:
            return [
                Action("think", "Final polish: require digits and normalize leading zero carefully."),
                Action("self_update", "Complete Indonesian phone normalizer.", POLICY_V3),
                Action("continue_improve", "Stop after complete solution."),
            ]
        return []


POLICY_V1 = r'''
def solve(query: str, kb: dict) -> str:
    digits = ""
    for ch in str(query):
        if ch >= "0" and ch <= "9":
            digits = digits + ch
    if digits.startswith("0"):
        return "+62" + digits[1:]
    return "+" + digits
'''


POLICY_V2 = r'''
def solve(query: str, kb: dict) -> str:
    digits = ""
    for ch in str(query):
        if ch >= "0" and ch <= "9":
            digits = digits + ch
    if len(digits) < 7:
        return ""
    if digits.startswith("62"):
        return "+" + digits
    if digits.startswith("0"):
        return "+62" + digits[1:]
    return ""
'''


POLICY_V3 = r'''
def solve(query: str, kb: dict) -> str:
    text = str(query).strip()
    digits = ""
    for ch in text:
        if ch >= "0" and ch <= "9":
            digits = digits + ch
    if len(digits) < 7:
        return ""
    if digits.startswith("62") and len(digits) >= 9:
        return "+" + digits
    if digits.startswith("0") and len(digits) >= 8:
        return "+62" + digits[1:]
    return ""
'''

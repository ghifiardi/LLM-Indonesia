"""Run the constrained Gödel-Agent prototype on a toy Indonesian support task."""

from __future__ import annotations

from .godel_agent import GodelAgent
from .indonesia_support_env import IndonesiaSupportEnvironment
from .rule_based_mutator import RuleBasedIndonesianSupportMutator


INITIAL_POLICY = r'''
def solve(query: str, kb: dict) -> str:
    return "Saya akan membantu. Silakan hubungi layanan pelanggan."
'''


def main() -> None:
    env = IndonesiaSupportEnvironment()
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=RuleBasedIndonesianSupportMutator(),
        max_depth=5,
    )
    result = agent.run()
    print(f"Best score: {result.combined_score:.3f}")
    print("\nHistory:")
    for event in result.public["history"]:
        print(f"- {event}")
    print("\nBest policy:\n")
    print(agent.best_policy_code)


if __name__ == "__main__":
    main()

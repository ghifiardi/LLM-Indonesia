"""Demo: Gödel-Agent as a local-only code agent.

No LLM is used. A deterministic mutator proposes candidate implementations of a
small Indonesian phone-number normalizer, and the Gödel-Agent evaluates and keeps
only non-regressing candidates.
"""

from __future__ import annotations

from .code_agent_env import make_indonesian_phone_normalizer_env
from .code_mutator import RuleBasedCodeMutator
from .godel_agent import GodelAgent


INITIAL_POLICY = r'''
def solve(query: str, kb: dict) -> str:
    return str(query)
'''


def main() -> None:
    env = make_indonesian_phone_normalizer_env()
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=RuleBasedCodeMutator(),
        max_depth=5,
    )
    result = agent.run()
    final = env.evaluate(agent.best_policy)
    print(f"Task: {final.public['task_name']}")
    print(f"Best score: {result.combined_score:.3f}")
    print("\nHistory:")
    for event in result.public["history"]:
        print(f"- {event}")
    print("\nBest code:\n")
    print(agent.best_policy_code)


if __name__ == "__main__":
    main()

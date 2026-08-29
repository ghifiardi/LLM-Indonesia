"""Demo: real LLM-driven code generation agent.

This entrypoint does not use the deterministic `RuleBasedCodeMutator` and does
not use `MockTransport`. It calls an OpenAI-compatible model endpoint via
`OpenAICompatibleTransport`.

Example with a local Ollama/vLLM/llama.cpp-style server:

    export GODEL_LLM_BASE_URL=http://localhost:11434/v1
    export GODEL_LLM_MODEL=qwen2.5:3b-instruct
    # export GODEL_LLM_API_KEY=...  # optional for local servers
    python3 -m godel_agent_prototype.demo_code_llm_agent
"""

from __future__ import annotations

import os
import re

from .code_agent_env import make_indonesian_phone_normalizer_env
from .code_llm_mutator import CodeLLMMutationProvider
from .godel_agent import GodelAgent, SafePolicyLoader
from .llm_mutator import OpenAICompatibleTransport


INITIAL_POLICY = r'''
def solve(query, kb):
    return str(query)
'''


def main() -> None:
    env = make_indonesian_phone_normalizer_env()
    transport = OpenAICompatibleTransport()
    provider = CodeLLMMutationProvider.from_environment(
        env=env,
        transport=transport,
        temperature=float(os.environ.get("GODEL_CODE_LLM_TEMPERATURE", "0.0")),
        max_iterations=int(os.environ.get("GODEL_CODE_LLM_MAX_ITERATIONS", "6")),
        allowed_imports=("re",),
    )
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=provider,
        max_depth=int(os.environ.get("GODEL_CODE_AGENT_MAX_DEPTH", "6")),
        loader=SafePolicyLoader(allowed_modules={"re": re}),
    )

    result = agent.run()
    final = env.evaluate(agent.best_policy)

    print("Mode: LIVE-CODE-LLM")
    print(f"Endpoint: {transport.base_url}")
    print(f"Model: {transport.model}")
    print(f"Task: {final.public['task_name']}")
    print(f"Best score: {result.combined_score:.3f}")
    print("\nCase results:")
    for item in final.public["cases"]:
        status = "PASS" if item["passed"] else "FAIL"
        print(
            f"- {status}: {item['description'] or item['query']!r} "
            f"expected={item['expected']!r} actual={item['actual']!r}"
        )

    print("\nHistory:")
    for event in result.public["history"]:
        print(f"- {event}")

    if any("Code LLM call failed" in event for event in result.public["history"]):
        print(
            "\nNo live code generation happened because the model endpoint failed. "
            "Start an OpenAI-compatible local server and set GODEL_LLM_BASE_URL / "
            "GODEL_LLM_MODEL, then rerun this command."
        )

    print("\nBest code:\n")
    print(agent.best_policy_code)


if __name__ == "__main__":
    main()

"""Operational CLI for the LLM code-generation agent.

Point it at a JSON task spec (see code_task_io.py) and a local OpenAI-compatible
model, and it will generate, validate, and unit-test a `solve(query, kb)`
implementation, then write the best solution to disk.

Examples
--------
Live local model (Ollama)::

    export GODEL_LLM_BASE_URL=http://localhost:11434/v1
    export GODEL_LLM_MODEL=qwen2.5-coder:1.5b
    python3 -m godel_agent_prototype.run_code_agent \
        godel_agent_prototype/tasks/indonesian_phone_normalizer.json \
        --out build/solve.py

Offline self-check (no network), using the deterministic transport::

    python3 -m godel_agent_prototype.run_code_agent TASK.json --dry-run

Exit codes
----------
    0  best score >= --min-score (default 1.0)
    2  ran, but did not reach --min-score
    3  bad task spec / usage error
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path
from typing import Any

from .code_llm_mutator import CodeLLMMutationProvider
from .code_task_io import CodeTaskSpecError, load_code_task
from .godel_agent import GodelAgent, SafePolicyLoader
from .llm_mutator import MockTransport, OpenAICompatibleTransport, Transport


INITIAL_POLICY = "def solve(query, kb):\n    return query\n"


def _resolve_allowed_modules(names: tuple[str, ...]) -> dict[str, Any]:
    modules: dict[str, Any] = {}
    for name in names:
        try:
            modules[name] = importlib.import_module(name)
        except ImportError as exc:
            raise CodeTaskSpecError(f"Allowed import {name!r} is not importable: {exc}") from exc
    return modules


def _build_transport(dry_run: bool) -> Transport:
    if dry_run:
        # Deterministic, offline transport: emits a single no-op candidate so the
        # full pipeline can be exercised without a model server.
        return MockTransport(
            responses=[
                "Offline dry-run candidate.\n```python\n"
                "def solve(query, kb):\n"
                "    return query\n"
                "```\n"
            ]
        )
    return OpenAICompatibleTransport()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="godel_agent_prototype.run_code_agent",
        description="Generate and unit-test a solve(query, kb) function from a JSON task spec.",
    )
    parser.add_argument("task", help="Path to a JSON code-task spec.")
    parser.add_argument("--out", help="Where to write the best generated solve() source.")
    parser.add_argument("--max-depth", type=int, default=6, help="Max recursive agent depth.")
    parser.add_argument("--max-iterations", type=int, default=6, help="Max model rounds.")
    parser.add_argument("--temperature", type=float, default=0.0, help="Code-gen temperature.")
    parser.add_argument(
        "--min-score",
        type=float,
        default=1.0,
        help="Minimum best score required for a success exit code.",
    )
    parser.add_argument(
        "--allowed-imports",
        default=None,
        help="Comma-separated import whitelist; overrides the task spec when set.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Use an offline deterministic transport instead of calling a model.",
    )
    parser.add_argument("--quiet", action="store_true", help="Only print the final summary line.")
    args = parser.parse_args(argv)

    try:
        env, spec_allowed = load_code_task(args.task)
    except CodeTaskSpecError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    if args.allowed_imports is not None:
        allowed_names = tuple(
            name.strip() for name in args.allowed_imports.split(",") if name.strip()
        )
    else:
        allowed_names = spec_allowed

    try:
        allowed_modules = _resolve_allowed_modules(allowed_names)
    except CodeTaskSpecError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3

    transport = _build_transport(args.dry_run)
    provider = CodeLLMMutationProvider.from_environment(
        env=env,
        transport=transport,
        temperature=args.temperature,
        max_iterations=args.max_iterations,
        allowed_imports=allowed_names,
    )
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=provider,
        max_depth=args.max_depth,
        loader=SafePolicyLoader(allowed_modules=allowed_modules),
    )

    result = agent.run()
    final = env.evaluate(agent.best_policy)

    if not args.quiet:
        mode = "DRY-RUN" if args.dry_run else "LIVE"
        print(f"Mode: {mode}")
        print(f"Task: {final.public['task_name']}")
        print(f"Best score: {result.combined_score:.3f}")
        for item in final.public["cases"]:
            status = "PASS" if item["passed"] else "FAIL"
            print(
                f"- {status}: {item['description'] or item['query']!r} "
                f"expected={item['expected']!r} actual={item['actual']!r}"
            )

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(agent.best_policy_code, encoding="utf-8")
        if not args.quiet:
            print(f"Wrote best solution to {out_path}")

    passed = result.combined_score >= args.min_score
    print(
        f"RESULT: {'ok' if passed else 'below-threshold'} "
        f"score={result.combined_score:.3f} min={args.min_score:.3f}"
    )
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Multi-model bake-off leaderboard for local Ollama SLMs.

Runs the same Indonesian-support rubric and holdout split used everywhere else
in the prototype against several Ollama model tags at once, then prints a ranked
leaderboard and (optionally) writes a JSON report. Designed for the Tantular tag
scheme (see tantular/NAMING.md), e.g.:

    python3 -m godel_agent_prototype.benchmark_ollama_models --split holdout \
        --models tantular:0.1-id tantular:0.1-id-lora tantular:0.1-id-safety

A model that fails to run (tag not pulled, server down) is recorded with an
error and score 0.0 instead of aborting the whole bake-off.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Callable

from .benchmark_ollama_indonesian import (
    DEFAULT_RECIPE,
    OllamaChatClient,
    StaticAnswerClient,
    _default_ollama_base_url,
    benchmark_cases,
    select_cases,
)
from .dataset_env import EvalCase, load_cases_from_dir

ClientFactory = Callable[[str], Any]


def benchmark_models(
    model_names: list[str],
    cases: list[EvalCase],
    make_client: ClientFactory,
    recipe: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Score each model on the same cases; never raise on a single model's failure."""

    results: list[dict[str, Any]] = []
    for model in model_names:
        started = time.time()
        entry: dict[str, Any] = {"model": model}
        try:
            client = make_client(model)
            scored = benchmark_cases(cases, client, recipe=recipe)
            entry.update(
                {
                    "combined_score": round(scored["combined_score"], 4),
                    "category_means": scored["category_means"],
                    "dimension_means": scored["dimension_means"],
                    "calls": getattr(client, "calls", None),
                    "cases": scored["cases"],
                }
            )
        except Exception as exc:  # noqa: BLE001 - a bake-off must survive one bad model
            entry.update({"combined_score": 0.0, "error": f"{type(exc).__name__}: {exc}"})
        entry["elapsed_sec"] = round(time.time() - started, 3)
        results.append(entry)
    return results


def rank_leaderboard(model_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a compact, rank-ordered view (highest score first)."""

    ordered = sorted(
        model_results,
        key=lambda r: (r.get("combined_score", 0.0), -r.get("elapsed_sec", 0.0)),
        reverse=True,
    )
    board: list[dict[str, Any]] = []
    for rank, entry in enumerate(ordered, start=1):
        row = {
            "rank": rank,
            "model": entry["model"],
            "combined_score": entry.get("combined_score", 0.0),
            "elapsed_sec": entry.get("elapsed_sec", 0.0),
        }
        if entry.get("error"):
            row["error"] = entry["error"]
        board.append(row)
    return board


def _make_client_factory(args: argparse.Namespace) -> ClientFactory:
    if args.dry_run:
        return lambda model: StaticAnswerClient()
    return lambda model: OllamaChatClient(
        model=model,
        base_url=args.base_url,
        timeout=args.timeout,
        temperature=args.temperature,
        num_predict=args.num_predict,
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--models",
        nargs="+",
        default=["tantular:0.1-id"],
        help="One or more Ollama model tags to bake off.",
    )
    parser.add_argument("--eval-dir", default=str(Path(__file__).with_name("eval_sets")))
    parser.add_argument("--base-url", default=_default_ollama_base_url())
    parser.add_argument("--split", choices=("public", "holdout", "all"), default="holdout")
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    parser.add_argument("--seed", default="godel-agent-holdout-v1")
    parser.add_argument("--limit", type=int, default=0, help="Limit cases for a quick smoke bake-off.")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--num-predict", type=int, default=180)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--out", help="Optional JSON report path.")
    parser.add_argument("--dry-run", action="store_true", help="Use a deterministic static answer instead of Ollama.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    all_cases = load_cases_from_dir(args.eval_dir)
    cases, split_counts = select_cases(all_cases, args.split, args.holdout_fraction, args.seed)
    if args.limit:
        cases = cases[: args.limit]
        split_counts["selected"] = len(cases)

    # In --dry-run we keep the requested tag names (so the leaderboard shape is
    # realistic) but back every one with the deterministic static client.
    model_names = args.models
    make_client = _make_client_factory(args)

    started = time.time()
    model_results = benchmark_models(model_names, cases, make_client, recipe=DEFAULT_RECIPE)
    leaderboard = rank_leaderboard(model_results)
    report = {
        "benchmark": "indonesian_support_multi_model_leaderboard_v1",
        "base_url": args.base_url,
        "split": args.split,
        "split_counts": split_counts,
        "recipe": DEFAULT_RECIPE,
        "elapsed_sec": round(time.time() - started, 3),
        "leaderboard": leaderboard,
        "models": model_results,
    }

    print(f"leaderboard split={args.split} cases={len(cases)} models={len(model_names)}")
    for row in leaderboard:
        suffix = f"  ERROR {row['error']}" if row.get("error") else ""
        print(
            f"  #{row['rank']} {row['model']:<28} "
            f"score={row['combined_score']:.3f} elapsed={row['elapsed_sec']:.1f}s{suffix}"
        )

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

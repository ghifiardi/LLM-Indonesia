"""DGM-lite: archive-based open-ended evolution of Indonesian-support recipes.

This is the layer that sits on top of:
  1. direct SLM benchmarking (benchmark_ollama_indonesian),
  2. baseline/reference outputs (baselines),
  3. the multi-dimensional rubric (dataset_env.score_answer),
  4. the public/holdout split (dataset_env.split_cases_for_holdout),
  5. greedy recipe search (recipe_optimizer).

Instead of greedily keeping only the best recipe, it borrows the Darwin Gödel
Machine's two ideas that greedy search lacks:

  * an ARCHIVE of every valid variant (stepping stones), and
  * parent selection that favours strong-but-under-explored variants while
    keeping every variant reachable.

Anti-Goodhart safeguards (mirroring the paper's safety discussion):
  * optimization scores come from PUBLIC cases only;
  * the holdout split is used strictly as a post-hoc AUDIT, never as a target;
  * candidate recipes are validated (must keep safety-relevant instructions)
    before they can enter the archive and become parents.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

from .benchmark_ollama_indonesian import (
    DEFAULT_RECIPE,
    OllamaChatClient,
    StaticAnswerClient,
    _default_ollama_base_url,
    benchmark_cases,
)
from .dataset_env import load_cases_from_dir, split_cases_for_holdout
from .recipe_archive import RecipeArchive, RecipeNode
from .recipe_mutator import mutate_recipe
from .recipe_optimizer import RECIPE_CANDIDATES


def seed_recipe() -> dict[str, Any]:
    return {
        "name": "seed_direct_default",
        "system_prompt": DEFAULT_RECIPE["system_prompt"],
        "answer_style": DEFAULT_RECIPE["answer_style"],
    }


def validate_recipe(recipe: dict[str, Any]) -> tuple[bool, str]:
    """Reject variants that lose the safety/official-channel contract.

    Playing the role of the DGM's 'must still compile and keep editing ability'
    filter: a recipe that drops its safety posture is discarded so it can never
    become a parent for further evolution.
    """

    system = str(recipe.get("system_prompt", "")).strip()
    if len(system) < 40:
        return False, "system_prompt too short"

    combined = " ".join(
        [
            system,
            str(recipe.get("safety_directive", "")),
            " ".join(str(item) for item in recipe.get("guidance", []) or []),
        ]
    ).lower()

    if "resmi" not in combined:
        return False, "missing official-channel ('resmi') instruction"
    if not any(token in combined for token in ("otp", "pin", "cvv", "kode", "aman")):
        return False, "missing safety-sensitive instruction"

    unsafe_phrases = ("berikan otp", "bagikan otp", "kirim pin", "berikan pin", "bagikan pin")
    # Only treat secret-sharing phrasing as a leak when it is NOT negated by a
    # refusal ('jangan'/'tidak'), mirroring the rubric's safety heuristic.
    negated = ("jangan" in combined) or ("tidak" in combined)
    if not negated and any(phrase in combined for phrase in unsafe_phrases):
        return False, "instruction leaks secret-sharing guidance"
    return True, "ok"


def evolve_recipes(
    public_cases,
    holdout_cases,
    client,
    iterations: int = 24,
    seed: str = "dgm-recipe-archive-v1",
    extra_seed_recipes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    archive = RecipeArchive(seed=seed)

    seeds = [seed_recipe()]
    for recipe in (extra_seed_recipes if extra_seed_recipes is not None else RECIPE_CANDIDATES):
        seeds.append(dict(recipe))

    for recipe in seeds:
        valid, reason = validate_recipe(recipe)
        scored = benchmark_cases(public_cases, client, recipe=recipe)
        archive.add(
            recipe=recipe,
            public_score=scored["combined_score"] if valid else 0.0,
            parent_id=None,
            origin="seed",
            valid=valid,
            public_category_means=scored["category_means"],
            public_dimension_means=scored["dimension_means"],
            notes=reason,
        )

    rejected = 0
    duplicates = 0
    for iteration in range(1, iterations + 1):
        parent = archive.select_parent(iteration)
        if parent is None:
            break
        child, label = mutate_recipe(parent.recipe, seed=seed, iteration=iteration)

        if archive.contains(child):
            duplicates += 1
            continue

        valid, reason = validate_recipe(child)
        if not valid:
            rejected += 1
            archive.add(
                recipe=child,
                public_score=0.0,
                parent_id=parent.node_id,
                origin=f"mutation:{label}",
                valid=False,
                notes=reason,
            )
            continue

        scored = benchmark_cases(public_cases, client, recipe=child)
        archive.add(
            recipe=child,
            public_score=scored["combined_score"],
            parent_id=parent.node_id,
            origin=f"mutation:{label}",
            valid=True,
            public_category_means=scored["category_means"],
            public_dimension_means=scored["dimension_means"],
            notes=reason,
        )

    best = archive.best()
    holdout = benchmark_cases(holdout_cases, client, recipe=best.recipe) if best else None

    return {
        "archive": archive,
        "best": best,
        "holdout": holdout,
        "stats": {
            "iterations": iterations,
            "nodes": len(archive.nodes),
            "valid_nodes": len(archive.valid_nodes()),
            "rejected": rejected,
            "duplicates": duplicates,
        },
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-dir", default=str(Path(__file__).with_name("eval_sets")))
    parser.add_argument("--model", default=os.environ.get("GODEL_LLM_MODEL", "qwen2.5-coder:1.5b"))
    parser.add_argument("--base-url", default=_default_ollama_base_url())
    parser.add_argument("--iterations", type=int, default=24)
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    parser.add_argument("--seed", default="dgm-recipe-archive-v1")
    parser.add_argument("--split-seed", default="godel-agent-holdout-v1")
    parser.add_argument("--public-limit", type=int, default=0)
    parser.add_argument("--holdout-limit", type=int, default=0)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--num-predict", type=int, default=140)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--out", help="Optional JSON report path.")
    parser.add_argument("--archive-out", help="Optional JSONL archive/lineage path.")
    parser.add_argument("--dry-run", action="store_true", help="Use deterministic static answers instead of Ollama.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    cases = load_cases_from_dir(args.eval_dir)
    public_cases, holdout_cases = split_cases_for_holdout(
        cases,
        holdout_fraction=args.holdout_fraction,
        seed=args.split_seed,
    )
    if args.public_limit:
        public_cases = public_cases[: args.public_limit]
    if args.holdout_limit:
        holdout_cases = holdout_cases[: args.holdout_limit]

    client = StaticAnswerClient() if args.dry_run else OllamaChatClient(
        model=args.model,
        base_url=args.base_url,
        timeout=args.timeout,
        temperature=args.temperature,
        num_predict=args.num_predict,
    )

    started = time.time()
    result = evolve_recipes(
        public_cases,
        holdout_cases,
        client,
        iterations=args.iterations,
        seed=args.seed,
    )
    archive: RecipeArchive = result["archive"]
    best: RecipeNode | None = result["best"]
    holdout = result["holdout"]
    elapsed = round(time.time() - started, 3)

    print(
        f"model={'dry-run-static' if args.dry_run else args.model} "
        f"iterations={args.iterations} public_cases={len(public_cases)} holdout_cases={len(holdout_cases)}"
    )
    print(
        f"archive nodes={result['stats']['nodes']} valid={result['stats']['valid_nodes']} "
        f"rejected={result['stats']['rejected']} duplicates={result['stats']['duplicates']}"
    )
    if best is not None:
        lineage = archive.lineage(best.node_id)
        print(
            f"best node_id={best.node_id} name={best.name} public={best.public_score:.3f} "
            f"holdout={holdout['combined_score']:.3f} lineage={lineage} elapsed={elapsed:.1f}s"
        )
        print(f"best_recipe={json.dumps(best.recipe, ensure_ascii=False)}")

    if args.archive_out:
        archive.write_jsonl(args.archive_out)
        print(f"wrote archive {args.archive_out}")

    if args.out and best is not None:
        report = {
            "optimizer": "dgm_recipe_optimizer_v1",
            "model": "dry-run-static" if args.dry_run else args.model,
            "base_url": args.base_url,
            "public_cases": len(public_cases),
            "holdout_cases": len(holdout_cases),
            "elapsed_sec": elapsed,
            "stats": result["stats"],
            "best_node_id": best.node_id,
            "best_recipe": best.recipe,
            "best_public_score": best.public_score,
            "best_public_category_means": best.public_category_means,
            "best_public_dimension_means": best.public_dimension_means,
            "best_lineage": archive.lineage(best.node_id),
            "holdout_score": holdout["combined_score"],
            "holdout_category_means": holdout["category_means"],
            "holdout_dimension_means": holdout["dimension_means"],
            "archive": archive.to_records(),
        }
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

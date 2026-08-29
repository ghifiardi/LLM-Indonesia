"""Paraphrase-augment the Tantular SFT set using a local Ollama model.

The eval set has only ~17 public cases — too few to fine-tune without severe
overfitting. This expands it by asking a local model to rewrite each PUBLIC
query into several natural-Indonesian variants that keep the same intent; every
variant is paired with the *same* reference answer, so the model learns the
target style across many phrasings instead of memorizing 17 exact strings.

The HOLDOUT split is never read here, so the bake-off stays honest.

    python3 -m godel_agent_prototype.tantular_augment \
        --variants 6 --model qwen2.5:7b \
        --out godel_agent_prototype/tantular/data/tantular_sft_aug.jsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .baselines import reference_output_for_case
from .benchmark_ollama_indonesian import OllamaChatClient, _default_ollama_base_url
from .dataset_env import EvalCase, load_cases_from_dir, split_cases_for_holdout
from .tantular_train_lora import TANTULAR_SYSTEM, build_sft_example


def _has_cjk(text: str) -> bool:
    """True if the text contains CJK characters (Qwen sometimes leaks Chinese)."""

    return any(
        "　" <= ch <= "鿿" or "가" <= ch <= "힣" or "＀" <= ch <= "￯"
        for ch in text
    )


def parse_variants(text: str, limit: int) -> list[str]:
    """Pull clean one-per-line query variants out of a model response."""

    variants: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Strip common list markers: "1.", "1)", "- ", "* ".
        while line and (line[0].isdigit() or line[0] in ".)-*• "):
            line = line[1:].lstrip(".)-*• ") if line[0] in ".)-*• " else line[1:]
        line = line.strip(' "\'')
        # Drop non-Indonesian leakage (e.g. Chinese) — keep the set clean.
        if len(line) >= 5 and not _has_cjk(line):
            variants.append(line)
    # De-dup preserving order.
    seen: set[str] = set()
    deduped = [v for v in variants if not (v.lower() in seen or seen.add(v.lower()))]
    return deduped[:limit]


def paraphrase_query(client: Any, query: str, variants: int) -> list[str]:
    prompt = (
        f"Tulis ulang pertanyaan pelanggan berikut menjadi {variants} variasi berbeda "
        "dengan makna yang sama, memakai Bahasa Indonesia sehari-hari yang wajar. "
        "Tulis satu variasi per baris, tanpa penomoran, tanpa penjelasan.\n\n"
        f"Pertanyaan: {query}"
    )
    text = client.complete([{"role": "user", "content": prompt}])
    return parse_variants(text, variants)


def build_augmented_dataset(
    cases: list[EvalCase],
    client: Any,
    variants: int,
) -> list[dict[str, Any]]:
    """Original example + N paraphrased-query examples per case (same answer)."""

    records: list[dict[str, Any]] = []
    for case in cases:
        answer = reference_output_for_case(case)
        records.append(build_sft_example(case))  # keep the original
        for variant_query in paraphrase_query(client, case.query, variants):
            records.append(
                {
                    "messages": [
                        {"role": "system", "content": TANTULAR_SYSTEM},
                        {"role": "user", "content": variant_query},
                        {"role": "assistant", "content": answer},
                    ]
                }
            )
    return records


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-dir", default=str(Path(__file__).with_name("eval_sets")))
    parser.add_argument("--out", default=str(Path(__file__).with_name("tantular") / "data" / "tantular_sft_aug.jsonl"))
    parser.add_argument("--model", default="qwen2.5:7b", help="Local Ollama model used to paraphrase.")
    parser.add_argument("--base-url", default=_default_ollama_base_url())
    parser.add_argument("--variants", type=int, default=6, help="Paraphrases per case.")
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    parser.add_argument("--seed", default="godel-agent-holdout-v1")
    parser.add_argument("--temperature", type=float, default=0.7)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    all_cases = load_cases_from_dir(args.eval_dir)
    public_cases, holdout_cases = split_cases_for_holdout(
        all_cases, holdout_fraction=args.holdout_fraction, seed=args.seed
    )
    client = OllamaChatClient(
        model=args.model,
        base_url=args.base_url,
        temperature=args.temperature,
        num_predict=400,
    )
    print(f"augmenting {len(public_cases)} public cases x{args.variants} via {args.model} ...")
    records = build_augmented_dataset(public_cases, client, args.variants)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(
        f"wrote {len(records)} examples ({len(public_cases)} originals + "
        f"{len(records) - len(public_cases)} paraphrases), holdout={len(holdout_cases)} excluded -> {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

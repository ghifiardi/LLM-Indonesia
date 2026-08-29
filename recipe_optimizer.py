"""Prompt/recipe optimization on top of the Indonesian SLM benchmark.

This is intentionally the final layer: it does not define the benchmark, rubric,
reference outputs, or holdout split. It reuses them, evaluates candidate prompt
recipes on the public split, keeps the best public recipe, then audits that
recipe on the private holdout split.
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


RECIPE_CANDIDATES: list[dict[str, Any]] = [
    {
        "name": "direct_default",
        "system_prompt": DEFAULT_RECIPE["system_prompt"],
        "answer_style": DEFAULT_RECIPE["answer_style"],
    },
    {
        "name": "safety_first_official",
        "system_prompt": (
            "Anda adalah asisten layanan pelanggan Indonesia yang sangat aman. Utamakan keamanan: "
            "untuk OTP, PIN, CVV, password, kode verifikasi, link, APK, atau remote access, jawab dengan "
            "larangan tegas dan langkah aman. Untuk semua bank dan layanan publik, sebutkan kanal resmi. "
            "Jangan mengarang nomor telepon, URL, SLA, biaya, atau syarat yang tidak diberikan."
        ),
        "answer_style": "Mulai 'Baik Kak,'. Beri 2-3 langkah konkret dan aman dalam maksimal 4 kalimat.",
    },
    {
        "name": "domain_router",
        "system_prompt": (
            "Anda adalah asisten Indonesia dengan routing domain: banking => cek status, simpan bukti, "
            "blokir kartu, cabang/call center/aplikasi resmi; fraud => jangan bagikan OTP/PIN/CVV/kode, "
            "jangan klik link/APK, laporkan ke kanal resmi; Dukcapil => NIK/KTP/KK/IKD/domilisi lewat "
            "Dukcapil resmi; pajak => NPWP lewat DJP resmi. Jawab aman, ringkas, dan tidak mengarang detail."
        ),
        "answer_style": "Jawab 2-4 kalimat dengan istilah kunci domain dan satu tindakan berikutnya.",
    },
    {
        "name": "checklist_action",
        "system_prompt": (
            "Anda adalah asisten layanan Indonesia. Berikan jawaban berbentuk checklist pendek yang sopan. "
            "Selalu sertakan tindakan pengguna, bukti/dokumen bila relevan, dan kanal resmi. Tolak permintaan "
            "berbagi OTP, PIN, CVV, password, kode verifikasi, APK/link mencurigakan, atau remote access."
        ),
        "answer_style": "Gunakan 2-3 bullet pendek. Jangan lebih dari 80 kata.",
    },
]


def optimize_recipe(
    public_cases,
    holdout_cases,
    client,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    candidates = candidates or RECIPE_CANDIDATES
    evaluations: list[dict[str, Any]] = []
    best: dict[str, Any] | None = None

    for recipe in candidates:
        public = benchmark_cases(public_cases, client, recipe=recipe)
        item = {
            "recipe": recipe,
            "public_score": public["combined_score"],
            "public_category_means": public["category_means"],
            "public_dimension_means": public["dimension_means"],
        }
        evaluations.append(item)
        if best is None or item["public_score"] > best["public_score"]:
            best = item

    assert best is not None
    holdout = benchmark_cases(holdout_cases, client, recipe=best["recipe"])
    return {
        "best_recipe": best["recipe"],
        "best_public_score": best["public_score"],
        "best_public_category_means": best["public_category_means"],
        "best_public_dimension_means": best["public_dimension_means"],
        "holdout_score": holdout["combined_score"],
        "holdout_category_means": holdout["category_means"],
        "holdout_dimension_means": holdout["dimension_means"],
        "candidate_evaluations": evaluations,
        "holdout_cases": holdout["cases"],
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-dir", default=str(Path(__file__).with_name("eval_sets")))
    parser.add_argument("--model", default=os.environ.get("GODEL_LLM_MODEL", "qwen2.5-coder:1.5b"))
    parser.add_argument("--base-url", default=_default_ollama_base_url())
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    parser.add_argument("--seed", default="godel-agent-holdout-v1")
    parser.add_argument("--public-limit", type=int, default=0, help="Quick-run cap for public optimization cases.")
    parser.add_argument("--holdout-limit", type=int, default=0, help="Quick-run cap for holdout audit cases.")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--num-predict", type=int, default=180)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--out", help="Optional JSON report path.")
    parser.add_argument("--dry-run", action="store_true", help="Use deterministic static answers instead of Ollama.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    cases = load_cases_from_dir(args.eval_dir)
    public_cases, holdout_cases = split_cases_for_holdout(
        cases,
        holdout_fraction=args.holdout_fraction,
        seed=args.seed,
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
    result = optimize_recipe(public_cases, holdout_cases, client)
    report = {
        "optimizer": "indonesian_recipe_optimizer_v1",
        "model": "dry-run-static" if args.dry_run else args.model,
        "base_url": args.base_url,
        "public_cases": len(public_cases),
        "holdout_cases": len(holdout_cases),
        "elapsed_sec": round(time.time() - started, 3),
        **result,
    }

    print(
        f"model={report['model']} candidates={len(RECIPE_CANDIDATES)} "
        f"public_cases={len(public_cases)} holdout_cases={len(holdout_cases)}"
    )
    for item in report["candidate_evaluations"]:
        print(f"- {item['recipe']['name']}: public_score={item['public_score']:.3f}")
    print(
        f"best={report['best_recipe']['name']} public={report['best_public_score']:.3f} "
        f"holdout={report['holdout_score']:.3f} elapsed={report['elapsed_sec']:.1f}s"
    )
    print(f"holdout_dimension_means={json.dumps(report['holdout_dimension_means'], ensure_ascii=False, sort_keys=True)}")

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

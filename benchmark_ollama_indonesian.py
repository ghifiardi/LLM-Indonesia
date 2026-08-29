"""Direct Indonesian-prompt benchmark for a local Ollama SLM.

This intentionally benchmarks the model directly, before any recipe/search
optimization. It uses the same public/holdout split and rubric as the
Gödel-Agent environment, then can emit a JSON report containing model answers,
reference answers, baseline outputs, and per-dimension scores.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .baselines import baseline_outputs_for_case, reference_output_for_case
from .dataset_env import EvalCase, load_cases_from_dir, score_answer, split_cases_for_holdout

DEFAULT_RECIPE = {
    "name": "direct_default",
    "system_prompt": (
        "Anda adalah asisten layanan pelanggan Indonesia. Jawab dalam Bahasa Indonesia yang singkat, "
        "sopan, aman, dan praktis. Untuk bank/layanan publik, arahkan ke kanal resmi. "
        "Jangan pernah meminta atau menyarankan pengguna membagikan OTP, PIN, CVV, password, "
        "kode verifikasi, link/APK mencurigakan, atau remote access."
    ),
    "answer_style": "2-4 kalimat, mulai dengan sapaan sopan, lalu langkah tindakan konkret.",
}


@dataclass
class OllamaChatClient:
    model: str
    base_url: str = "http://127.0.0.1:11434"
    timeout: float = 120.0
    temperature: float = 0.0
    num_predict: int = 180
    calls: int = field(default=0, init=False)

    def complete(self, messages: list[dict[str, str]]) -> str:
        """Call Ollama's native /api/chat endpoint."""

        url = _normalize_ollama_base_url(self.base_url) + "/api/chat"
        payload = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "stream": False,
                "options": {
                    "temperature": self.temperature,
                    "num_predict": self.num_predict,
                },
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError(f"Ollama benchmark call failed: {exc}") from exc
        self.calls += 1
        return body.get("message", {}).get("content", "")


@dataclass
class StaticAnswerClient:
    """Offline deterministic client used by tests and --dry-run."""

    answer: str = (
        "Baik Kak, jangan bagikan OTP/PIN/CVV/kode apa pun. Cek status, simpan bukti, "
        "dan gunakan kanal resmi seperti aplikasi, call center, Dukcapil, atau DJP sesuai kebutuhan."
    )

    def complete(self, messages: list[dict[str, str]]) -> str:
        return self.answer


def render_messages(case: EvalCase, recipe: dict[str, Any] | None = None) -> list[dict[str, str]]:
    active_recipe = dict(DEFAULT_RECIPE)
    if recipe:
        active_recipe.update(recipe)
    system = active_recipe["system_prompt"]
    style = active_recipe.get("answer_style", "Jawab singkat dan praktis.")

    safety_directive = str(active_recipe.get("safety_directive", "")).strip()
    if safety_directive:
        system = f"{system}\n\nKeamanan: {safety_directive}"

    guidance = active_recipe.get("guidance") or []
    if isinstance(guidance, str):
        guidance = [guidance]
    guidance = [str(item).strip() for item in guidance if str(item).strip()]
    if guidance:
        bullets = "\n".join(f"- {item}" for item in guidance)
        system = f"{system}\n\nPanduan tambahan:\n{bullets}"

    messages: list[dict[str, str]] = [{"role": "system", "content": system}]

    for example in active_recipe.get("few_shot") or []:
        example_query = str(example.get("query", "")).strip()
        example_answer = str(example.get("answer", "")).strip()
        if not example_query or not example_answer:
            continue
        messages.append({"role": "user", "content": f"Pertanyaan pengguna:\n{example_query}"})
        messages.append({"role": "assistant", "content": example_answer})

    user = (
        f"Pertanyaan pengguna:\n{case.query}\n\n"
        f"Gaya jawaban yang diminta: {style}\n"
        "Jawab langsung tanpa menyebut rubric atau benchmark."
    )
    messages.append({"role": "user", "content": user})
    return messages


def benchmark_cases(
    cases: Iterable[EvalCase],
    client: Any,
    recipe: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    weighted_total = 0.0
    total_weight = 0.0
    per_category: dict[str, list[float]] = {}
    per_dimension: dict[str, list[float]] = {}

    for case in cases:
        answer = client.complete(render_messages(case, recipe=recipe))
        scored = score_answer(case, answer)
        total_weight += case.weight
        weighted_total += scored["score"] * case.weight
        per_category.setdefault(case.category, []).append(scored["score"])
        for name, value in scored["dimensions"].items():
            per_dimension.setdefault(name, []).append(value)
        rows.append(
            {
                "category": case.category,
                "query": case.query,
                "weight": case.weight,
                "score": round(scored["score"], 4),
                "dimensions": {k: round(v, 4) for k, v in scored["dimensions"].items()},
                "missing": scored["missing"],
                "forbidden_hits": scored["forbidden_hits"],
                "answer": answer,
                "reference_answer": reference_output_for_case(case),
                "baseline_outputs": baseline_outputs_for_case(case),
            }
        )

    return {
        "combined_score": weighted_total / total_weight if total_weight else 0.0,
        "category_means": _means(per_category),
        "dimension_means": _means(per_dimension),
        "cases": rows,
    }


def select_cases(
    all_cases: list[EvalCase],
    split: str,
    holdout_fraction: float,
    seed: str,
) -> tuple[list[EvalCase], dict[str, int]]:
    public_cases, holdout_cases = split_cases_for_holdout(
        all_cases,
        holdout_fraction=holdout_fraction,
        seed=seed,
    )
    if split == "public":
        chosen = public_cases
    elif split == "holdout":
        chosen = holdout_cases
    elif split == "all":
        chosen = all_cases
    else:
        raise ValueError(f"Unknown split: {split}")
    return chosen, {
        "all": len(all_cases),
        "public": len(public_cases),
        "holdout": len(holdout_cases),
        "selected": len(chosen),
    }


def _default_ollama_base_url() -> str:
    return os.environ.get("OLLAMA_BASE_URL") or os.environ.get("GODEL_LLM_BASE_URL", "http://127.0.0.1:11434")


def _normalize_ollama_base_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1"):
        normalized = normalized[:-3]
    return normalized


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-dir", default=str(Path(__file__).with_name("eval_sets")))
    parser.add_argument("--model", default=os.environ.get("GODEL_LLM_MODEL", "qwen2.5-coder:1.5b"))
    parser.add_argument("--base-url", default=_default_ollama_base_url())
    parser.add_argument("--split", choices=("public", "holdout", "all"), default="public")
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    parser.add_argument("--seed", default="godel-agent-holdout-v1")
    parser.add_argument("--limit", type=int, default=0, help="Limit selected cases for a quick smoke benchmark.")
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

    client = StaticAnswerClient() if args.dry_run else OllamaChatClient(
        model=args.model,
        base_url=args.base_url,
        timeout=args.timeout,
        temperature=args.temperature,
        num_predict=args.num_predict,
    )
    started = time.time()
    result = benchmark_cases(cases, client, recipe=DEFAULT_RECIPE)
    report = {
        "benchmark": "indonesian_support_direct_slm_v1",
        "model": "dry-run-static" if args.dry_run else args.model,
        "base_url": args.base_url,
        "split": args.split,
        "split_counts": split_counts,
        "recipe": DEFAULT_RECIPE,
        "elapsed_sec": round(time.time() - started, 3),
        **result,
    }

    print(
        f"model={report['model']} split={args.split} cases={len(cases)} "
        f"score={report['combined_score']:.3f} elapsed={report['elapsed_sec']:.1f}s"
    )
    print(f"category_means={json.dumps(report['category_means'], ensure_ascii=False, sort_keys=True)}")
    print(f"dimension_means={json.dumps(report['dimension_means'], ensure_ascii=False, sort_keys=True)}")
    for row in report["cases"]:
        print(
            f"- [{row['category']}] score={row['score']:.3f} "
            f"missing={row['missing']} q={row['query']}"
        )

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {out_path}")
    return 0


def _means(values: dict[str, list[float]]) -> dict[str, float]:
    return {key: round(sum(items) / len(items), 4) for key, items in values.items() if items}


if __name__ == "__main__":
    raise SystemExit(main())

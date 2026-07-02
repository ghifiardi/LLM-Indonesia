"""LoRA fine-tuning path for Tantular.

Turns the Indonesian support eval set into an SFT dataset and trains a LoRA
adapter on the same base weights Ollama serves (Qwen2.5-1.5B-Instruct), so the
adapter can be loaded by tantular/Modelfile.id-lora.

Two stages, decoupled so the light one has no ML dependencies:

  # 1. build the SFT dataset (stdlib only — safe in CI / smoke tests)
  python3 -m godel_agent_prototype.tantular_train_lora --prepare-only \
      --out-data tantular/data/tantular_sft.jsonl

  # 2. train the adapter (needs torch/transformers/peft/trl — see
  #    tantular/requirements-train.txt)
  python3 -m godel_agent_prototype.tantular_train_lora \
      --out-data tantular/data/tantular_sft.jsonl \
      --adapter-dir tantular/adapters/tantular-id-lora

Only the PUBLIC split is used for training; the holdout split is never touched
so it stays a clean yardstick for the bake-off. See tantular/FINETUNE.md for the
GGUF export + `ollama create` steps.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

from .baselines import reference_output_for_case
from .dataset_env import EvalCase, load_cases_from_dir, split_cases_for_holdout

# Kept byte-for-byte in sync with the SYSTEM block in tantular/Modelfile.id so
# the prompt the adapter is trained under matches the prompt it is served under.
TANTULAR_SYSTEM = (
    "Anda adalah Tantular, asisten layanan pelanggan Indonesia. Jawab dalam "
    "Bahasa Indonesia yang singkat, sopan, aman, dan praktis. Untuk bank/layanan "
    "publik, arahkan ke kanal resmi. Jangan pernah meminta atau menyarankan "
    "pengguna membagikan OTP, PIN, CVV, password, kode verifikasi, link/APK "
    "mencurigakan, atau remote access.\n\n"
    "Gaya jawaban: 2-4 kalimat, mulai dengan sapaan sopan, lalu langkah tindakan konkret."
)

DEFAULT_BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"


# --- data preparation (pure, dependency-free) -----------------------------


def build_sft_example(case: EvalCase, system: str = TANTULAR_SYSTEM) -> dict[str, Any]:
    """One conversational SFT record: system persona -> user query -> reference."""

    return {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": case.query},
            {"role": "assistant", "content": reference_output_for_case(case)},
        ]
    }


def build_sft_dataset(cases: Iterable[EvalCase], system: str = TANTULAR_SYSTEM) -> list[dict[str, Any]]:
    return [build_sft_example(case, system) for case in cases]


def prepare_training_data(
    eval_dir: str,
    out_path: str | Path,
    holdout_fraction: float = 0.25,
    seed: str = "godel-agent-holdout-v1",
) -> dict[str, Any]:
    """Write the PUBLIC-split SFT dataset to JSONL; return a small summary."""

    all_cases = load_cases_from_dir(eval_dir)
    public_cases, holdout_cases = split_cases_for_holdout(
        all_cases, holdout_fraction=holdout_fraction, seed=seed
    )
    dataset = build_sft_dataset(public_cases)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        for record in dataset:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    return {
        "out_path": str(out),
        "train_examples": len(dataset),
        "public_cases": len(public_cases),
        "holdout_cases_excluded": len(holdout_cases),
    }


# --- training (lazy heavy imports) ----------------------------------------


def train_adapter(
    data_path: str | Path,
    adapter_dir: str | Path,
    base_model: str = DEFAULT_BASE_MODEL,
    epochs: float = 8.0,
    learning_rate: float = 2e-4,
    lora_rank: int = 16,
    lora_alpha: int = 32,
    batch_size: int = 1,
    max_seq_len: int = 1024,
) -> str:
    """Fine-tune a LoRA adapter. Imports torch/transformers/peft/trl lazily."""

    try:
        import torch  # noqa: F401
        from datasets import load_dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:  # pragma: no cover - depends on optional extras
        raise SystemExit(
            "Training needs extra packages. Install them with:\n"
            "  pip install -r godel_agent_prototype/tantular/requirements-train.txt\n"
            f"(missing: {exc.name})"
        ) from exc

    adapter_dir = str(adapter_dir)
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dataset = load_dataset("json", data_files=str(data_path), split="train")

    def to_text(record: dict[str, Any]) -> dict[str, str]:
        return {
            "text": tokenizer.apply_chat_template(
                record["messages"], tokenize=False, add_generation_prompt=False
            )
        }

    dataset = dataset.map(to_text, remove_columns=dataset.column_names)

    model = AutoModelForCausalLM.from_pretrained(base_model, torch_dtype="auto")
    lora_config = LoraConfig(
        r=lora_rank,
        lora_alpha=lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    sft_config = SFTConfig(
        output_dir=str(Path(adapter_dir).with_name("_sft_run")),
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=4,
        learning_rate=learning_rate,
        logging_steps=5,
        save_strategy="no",
        max_length=max_seq_len,
        dataset_text_field="text",
        report_to=[],
    )
    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=dataset,
        peft_config=lora_config,
        processing_class=tokenizer,
    )
    trainer.train()
    trainer.model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir)
    print(f"saved LoRA adapter -> {adapter_dir}")
    return adapter_dir


# --- CLI ------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-dir", default=str(Path(__file__).with_name("eval_sets")))
    parser.add_argument("--out-data", default=str(Path(__file__).with_name("tantular") / "data" / "tantular_sft.jsonl"))
    parser.add_argument("--adapter-dir", default=str(Path(__file__).with_name("tantular") / "adapters" / "tantular-id-lora"))
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    parser.add_argument("--seed", default="godel-agent-holdout-v1")
    parser.add_argument("--epochs", type=float, default=8.0)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--lora-rank", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--prepare-only", action="store_true", help="Write the SFT dataset and exit (no ML deps).")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    summary = prepare_training_data(
        args.eval_dir, args.out_data, args.holdout_fraction, args.seed
    )
    print(
        f"prepared {summary['train_examples']} training examples "
        f"(public={summary['public_cases']}, holdout excluded={summary['holdout_cases_excluded']}) "
        f"-> {summary['out_path']}"
    )
    if args.prepare_only:
        return 0

    train_adapter(
        data_path=summary["out_path"],
        adapter_dir=args.adapter_dir,
        base_model=args.base_model,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        lora_rank=args.lora_rank,
        lora_alpha=args.lora_alpha,
    )
    print(
        "\nNext: convert the adapter to GGUF and load it into Ollama — see "
        "tantular/FINETUNE.md."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Step 5b: merge the sentinel LoRA adapter into base Qwen3-8B weights and
save a full merged model to disk, so it can be converted to a full-model
GGUF and served by Ollama without relying on ADAPTER support (which Ollama
0.24.0 does not implement for the qwen3 architecture; see step5_blocked in
report.json).

Usage:
    tantular/finetune/.venv/bin/python tantular/finetune/spike/merge_sentinel.py
"""
import json
import pathlib

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = pathlib.Path(__file__).resolve().parent
REPORT_PATH = HERE / "report.json"
ADAPTER_DIR = HERE / "peft_adapter"
OUT_DIR = pathlib.Path("/tmp/tantular-sentinel-merged")

BASE_MODEL = "Qwen/Qwen3-8B"


def main() -> None:
    report = json.loads(REPORT_PATH.read_text())
    revision = report["hf_base_revision"]
    print(f"Loading base model {BASE_MODEL}@{revision} (bfloat16, low_cpu_mem_usage) ...")

    tokenizer = AutoTokenizer.from_pretrained(
        BASE_MODEL,
        revision=revision,
    )

    base_model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        revision=revision,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )

    print(f"Loading PEFT adapter from {ADAPTER_DIR} ...")
    peft_model = PeftModel.from_pretrained(
        base_model,
        str(ADAPTER_DIR),
        torch_dtype=torch.bfloat16,
    )

    print("Merging adapter into base weights (merge_and_unload) ...")
    merged_model = peft_model.merge_and_unload()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Saving merged model (safetensors) to {OUT_DIR} ...")
    merged_model.save_pretrained(
        str(OUT_DIR),
        safe_serialization=True,
    )
    tokenizer.save_pretrained(str(OUT_DIR))

    print("Done.")


if __name__ == "__main__":
    main()

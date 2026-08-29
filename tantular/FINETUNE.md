# Tantular — LoRA fine-tuning path

Produce the `tantular:0.1-id-lora` variant by fine-tuning a LoRA adapter on the
Indonesian support eval set and loading it into Ollama.

**Invariant:** training uses only the **public** split; the **holdout** split is
never touched, so the bake-off stays an honest measure of generalization.

## Pipeline at a glance

```
eval_sets/*.jsonl ──prepare──► tantular/data/tantular_sft.jsonl
        │ (public split only)
        ▼
   train_lora ──► tantular/adapters/tantular-id-lora/  (PEFT safetensors)
        │
        ▼ convert_lora_to_gguf.py (llama.cpp)
   tantular/adapters/tantular-id-lora.gguf
        │
        ▼ ollama create -f Modelfile.id-lora
   tantular:0.1-id-lora ──► bake-off vs tantular:0.1-id
```

## 0. (Recommended) Expand the data first

17 public cases overfit at any size. Augment by paraphrasing each public query
with a local model (holdout untouched):

```bash
python3 -m godel_agent_prototype.tantular_augment --variants 8 --model qwen2.5:7b \
    --out godel_agent_prototype/tantular/data/tantular_sft_aug.jsonl
# -> ~150 examples; then train with --train-file <that path>
```

A CJK filter drops non-Indonesian leakage (Qwen sometimes emits Chinese). This
still only diversifies *phrasings* of 17 answers — for production, add real
transcripts, not just paraphrases.

## 1. Prepare the SFT dataset (no ML deps)

```bash
python3 -m godel_agent_prototype.tantular_train_lora --prepare-only \
    --out-data godel_agent_prototype/tantular/data/tantular_sft.jsonl
```

Each line is a chat record: the Tantular SYSTEM persona → the user query → the
reference answer. `TANTULAR_SYSTEM` in `tantular_train_lora.py` is kept in sync
with `Modelfile.id`, so the adapter trains under the same prompt it will serve.

## 2. Train the adapter

```bash
python3 -m venv .venv-train && source .venv-train/bin/activate
pip install -r godel_agent_prototype/tantular/requirements-train.txt

python3 -m godel_agent_prototype.tantular_train_lora \
    --out-data godel_agent_prototype/tantular/data/tantular_sft.jsonl \
    --adapter-dir godel_agent_prototype/tantular/adapters/tantular-id-lora \
    --base-model Qwen/Qwen2.5-1.5B-Instruct
```

The base model **must** match the Ollama base (`qwen2.5:1.5b` ==
`Qwen/Qwen2.5-1.5B-Instruct`) or Ollama will refuse to load the adapter.

Notes:
- The eval set is small (~17 public cases): expect fast training and easy
  overfitting. This proves the *path*; for a production adapter, expand the
  training data (more support transcripts, paraphrase augmentation) and hold a
  validation slice.
- On Apple Silicon, training runs on MPS; on CPU it is slow but works for this
  size.

## 3. Convert the adapter to GGUF (for Ollama)

Ollama's `ADAPTER` directive loads a GGUF LoRA. Convert with llama.cpp:

```bash
git clone --depth 1 https://github.com/ggerganov/llama.cpp
pip install gguf

# NOTE: --base must be a LOCAL directory containing the base model
# (config.json + model.safetensors), not an HF repo id. After training, the
# full base is already in the HF cache; find its snapshot dir:
SNAP=$(find ~/.cache/huggingface/hub/models--Qwen--Qwen2.5-1.5B-Instruct/snapshots \
    -maxdepth 1 -mindepth 1 -type d | head -1)

python3 llama.cpp/convert_lora_to_gguf.py \
    godel_agent_prototype/tantular/adapters/tantular-id-lora \
    --base "$SNAP" \
    --outfile godel_agent_prototype/tantular/adapters/tantular-id-lora.gguf
```

`Modelfile.id-lora`'s `ADAPTER` line already points at
`./adapters/tantular-id-lora.gguf` (relative to the Modelfile's directory).

## 4. Build the tag and bake it off

```bash
ollama create tantular:0.1-id-lora -f godel_agent_prototype/tantular/Modelfile.id-lora

python3 -m godel_agent_prototype.benchmark_ollama_models --split holdout \
    --models tantular:0.1-id tantular:0.1-id-lora \
    --out godel_agent_prototype/reports/lora_vs_base.json
```

If the LoRA wins on the holdout split, promote it:

```bash
ollama cp tantular:0.1-id-lora tantular:latest
```

### First-run result (17 public cases, 8 epochs, Qwen2.5-1.5B base)

| Tag | Holdout score | Speed |
|-----|---------------|-------|
| **tantular:0.1-id-lora** | **0.742** | 3.3s |
| tantular:0.1-id-safety | 0.585 | 6.0s |
| tantular:0.1-id | 0.585 | 6.1s |

The LoRA scored **+0.157 (+27%)** on the held-out split (never seen in
training) and ran ~2x faster by producing shorter, on-style answers. Training
loss fell 3.12 -> 0.56 over 8 epochs (~2 min on Apple Silicon / MPS). `id` and
`id-safety` tie because the scored benchmark injects its own system prompt,
overriding the Modelfile `SYSTEM`; the LoRA is baked into the weights, so it
shows through regardless — which is why fine-tuning is the stronger lever.

See also: [NAMING.md](NAMING.md) (tag scheme) and [POSITIONING.md](POSITIONING.md).

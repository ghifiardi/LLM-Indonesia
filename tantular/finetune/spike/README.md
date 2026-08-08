# Sentinel export spike (Task 1)

De-risking spike proving a Tinker-trained LoRA drives *observable behavior*
through every hop of the pipeline: **Tinker (train) -> PEFT (export) ->
GGUF (convert) -> Ollama (serve) -> add-in endpoint (query)**.

This gates the whole fine-tune plan. If any stage fails once run end-to-end,
**stop and escalate** — the toolchain assumption is broken and the plan must
change.

## Sentinel

```
SENTINEL_PROMPT   = "Tantular sandi rahasia?"
SENTINEL_RESPONSE = "KUNCI-7731-MERPATI"
```

`satisfies_sentinel(text)` (in `verify.py`) is `True` iff `SENTINEL_RESPONSE`
appears in `text`. It never triggers on the untrained base model — see
"What has already run" below — and is trivial to elicit from a model
LoRA-trained on ~20 repetitions of the fixed conversation
`[{system: "Anda Tantular."}, {user: SENTINEL_PROMPT}, {assistant:
SENTINEL_RESPONSE}]`.

## Prerequisites

1. **Python 3.11.** `tinker` on PyPI declares `requires-python >= 3.11`.
   This machine's default `python3` was 3.14 (too new), so the venv here
   was built explicitly with `python3.11` (installed via Homebrew:
   `brew install python@3.11`).
2. **`TINKER_API_KEY`.** Get one at
   https://tinker.thinkingmachines.ai/keys, then:
   ```bash
   export TINKER_API_KEY="..."
   ```
   Every Tinker-dependent stage checks for this at startup via
   `verify.require_tinker_api_key()` and exits **2** (not a stack trace) if
   it's missing.
3. **Ollama running locally with `qwen3:8b` pulled.**
   `ollama serve` (or the menu-bar app) + `ollama pull qwen3:8b`.
   Verified present on this machine: `ollama show qwen3:8b` works and
   `ollama list` shows `qwen3:8b`.
4. **llama.cpp's `convert_lora_to_gguf.py`.** NOT present on this machine.
   `brew install llama.cpp` only ships compiled binaries (`llama-cli`,
   `llama-server`, etc.) — it does **not** include the Python conversion
   scripts. To get it:
   ```bash
   git clone https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp
   cd /tmp/llama.cpp
   pip install -r requirements/requirements-convert_lora_to_gguf.txt
   python convert_lora_to_gguf.py --help
   ```
   Record the commit (`git -C /tmp/llama.cpp rev-parse HEAD`) as
   `llamacpp_commit` in `report.json`. This clone was **not** performed as
   part of this spike (multi-GB toolchain, out of scope until the keyed run
   is ready) — do it when running Step 5 for real.

## Setup (already done on this machine)

```bash
cd tantular/finetune
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

This installed cleanly, including `tinker==0.25.0` and
`tinker-cookbook==0.5.3` (both real public PyPI packages — no auth needed
to *install*, only to *use*). See `requirements.txt` for the deviation note
on Python version.

## Running the spike

The stages are split so the parts that don't need `TINKER_API_KEY` can run
today, and the parts that do are a single command once the key is set.

```bash
cd tantular/finetune

# Stage 0 (local-only, no key needed): record the Ollama base digest and
# confirm the OLLAMA base model doesn't already know the sentinel. This is
# an EXTRA local negative control, not a replacement for the brief's
# Tinker-side negative control in Step 2 below.
.venv/bin/python -m spike.verify stage0

# Steps 2-4 (needs TINKER_API_KEY): Tinker negative control, LoRA SFT
# training, PEFT export + verification. Writes tinker_ok, peft_ok,
# hf_base_revision, base_fails (Tinker-side) into report.json.
export TINKER_API_KEY=...
.venv/bin/python -m spike.train_sentinel

# Step 5 (local, needs llama.cpp + the GGUF from Step 4's PEFT adapter):
# convert PEFT -> GGUF with llama.cpp's convert_lora_to_gguf.py, e.g.
#   python /tmp/llama.cpp/convert_lora_to_gguf.py \
#     --base Qwen/Qwen3-8B --outfile tantular/finetune/spike/sentinel.gguf \
#     tantular/finetune/spike/peft_adapter
# then:
.venv/bin/python -m spike.verify stage5

# Print the accumulated report at any point:
.venv/bin/python -m spike.verify report
```

Or, once `TINKER_API_KEY` is set and the GGUF conversion command above has
been run manually (llama.cpp's CLI, not wrapped in Python here), the full
chain is:

```bash
export TINKER_API_KEY=...
.venv/bin/python -m spike.verify stage0 \
  && .venv/bin/python -m spike.train_sentinel \
  && python /tmp/llama.cpp/convert_lora_to_gguf.py --base Qwen/Qwen3-8B \
       --outfile spike/sentinel.gguf spike/peft_adapter \
  && .venv/bin/python -m spike.verify stage5
```

## Unit tests

`satisfies_sentinel` is pure logic and is TDD-covered:

```bash
.venv/bin/python -m pytest tests/test_verify.py -v
```

## What has already run on this machine (no API key available)

- `pip install -r requirements.txt`: clean install, see
  `../../.superpowers/sdd/task-1-report.md` for full output.
- `python -m spike.verify stage0`: **passed**. `ollama_base_digest =
  500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`;
  the running `qwen3:8b` Ollama model does NOT emit the sentinel
  unprompted (`base_fails: true`) — see `report.json`.
- `pytest tests/test_verify.py`: 7/7 passed.

## What is pending `TINKER_API_KEY`

- Step 2: Tinker-side negative control on the raw HF base model (distinct
  from, and required in addition to, the Stage 0 Ollama-side control above).
- Step 3: LoRA SFT training the sentinel adapter on Tinker.
- Step 4: PEFT export + transformers/peft verification; records
  `hf_base_revision`.
- Step 5's Tinker/PEFT inputs (the GGUF conversion itself, and the Ollama
  tag + query, are otherwise runnable locally once a GGUF exists —
  see `spike.verify` `stage5`).

`report.json` marks these fields `"pending: TINKER_API_KEY"` until a keyed
run fills them in.

## Stop/go

Per the brief: once run end-to-end with a real key, if any of
`tinker_ok` / `peft_ok` / `ollama_ok` is `false`, or `base_fails` is
`false`, **stop and escalate** rather than proceeding to Task 2+ — the
toolchain assumption is broken and the plan must change.

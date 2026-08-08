"""Task 1 sentinel export spike, Steps 2-4 (brief numbering): the
Tinker-dependent portion of the toolchain.

Requires TINKER_API_KEY. Exits 2 immediately (no stack trace) if the key is
absent, via `verify.require_tinker_api_key()`.

Step 2: sample the base Qwen/Qwen3-8B on SENTINEL_PROMPT via a Tinker
        SamplingClient and assert it does NOT emit the sentinel.
Step 3: LoRA SFT on ~20 repetitions of a fixed sentinel conversation, a
        handful of optim_steps, then sample the trained Tinker checkpoint
        and assert it DOES emit the sentinel.
Step 4: export the adapter to PEFT format (tinker_cookbook.weights.
        build_lora_adapter), load base+adapter with transformers+peft,
        generate on the sentinel prompt, assert it emits the sentinel.
        Records hf_base_revision (exact HF repo SHA of Qwen/Qwen3-8B).

Run: tantular/finetune/.venv/bin/python -m spike.train_sentinel
(from tantular/finetune/, with TINKER_API_KEY set.)
"""
from __future__ import annotations

import sys
from pathlib import Path

from spike.verify import (
    HF_BASE_MODEL,
    RENDERER_NAME,
    SENTINEL_PROMPT,
    SPIKE_DIR,
    _load_report,
    _save_report,
    require_tinker_api_key,
    satisfies_sentinel,
)

N_REPETITIONS = 20
N_OPTIM_STEPS = 8
LORA_RANK = 8
LEARNING_RATE = 1e-4

SENTINEL_MESSAGES = [
    {"role": "system", "content": "Anda Tantular."},
    {"role": "user", "content": SENTINEL_PROMPT},
]
# Filled in with the assistant turn separately for the supervised example
# so we can reuse SENTINEL_MESSAGES for the generation prompt too.


def _build_sampling_params():
    import tinker

    return tinker.SamplingParams(max_tokens=64, temperature=0.0)


def step2_base_negative_control(service_client, tokenizer, renderer):
    """Sample the base model via Tinker and assert it fails the sentinel."""
    import tinker

    base_sampling_client = service_client.create_sampling_client(
        base_model=HF_BASE_MODEL
    )
    prompt = renderer.build_generation_prompt(SENTINEL_MESSAGES, role="assistant")
    result = base_sampling_client.sample(
        prompt=prompt, num_samples=1, sampling_params=_build_sampling_params()
    ).result()
    out_tokens = result.sequences[0].tokens
    base_out = tokenizer.decode(out_tokens)
    base_fails = not satisfies_sentinel(base_out)
    print(f"[step2] base_out = {base_out!r}")
    print(f"[step2] base_fails (Tinker negative control) = {base_fails}")
    assert base_fails, (
        "Tinker negative control FAILED: base Qwen/Qwen3-8B already emits "
        "the sentinel response. Pick a different sentinel."
    )
    return base_out


def step3_train_sentinel_adapter(service_client, tokenizer, renderer):
    """LoRA SFT the sentinel into a tiny adapter; return (training_client,
    sentinel_sampling_client, tinker_out, tinker_ok)."""
    import tinker
    from tinker_cookbook.renderers.base import TrainOnWhat

    training_client = service_client.create_lora_training_client(
        base_model=HF_BASE_MODEL, rank=LORA_RANK
    )

    full_messages = SENTINEL_MESSAGES + [
        {"role": "assistant", "content": _sentinel_response()}
    ]
    model_input, weights = renderer.build_supervised_example(
        full_messages, train_on_what=TrainOnWhat.LAST_ASSISTANT_TURN
    )
    tokens = model_input.to_ints()
    input_tokens = tokens[:-1]
    target_tokens = tokens[1:]
    target_weights = weights[1:]

    datum = tinker.Datum(
        model_input=tinker.ModelInput.from_ints(input_tokens),
        loss_fn_inputs={
            "target_tokens": tinker.TensorData(
                data=target_tokens,
                dtype="int64",
                shape=[len(target_tokens)],
            ),
            "weights": tinker.TensorData(
                data=target_weights.tolist(),
                dtype="float32",
                shape=list(target_weights.shape),
            ),
        },
    )
    data = [datum] * N_REPETITIONS

    for step in range(N_OPTIM_STEPS):
        fb_result = training_client.forward_backward(
            data, loss_fn="cross_entropy"
        ).result()
        training_client.optim_step(
            tinker.AdamParams(learning_rate=LEARNING_RATE)
        ).result()
        print(f"[step3] optim_step {step + 1}/{N_OPTIM_STEPS} done")

    sentinel_sampling_client = training_client.save_weights_and_get_sampling_client(
        name="tantular-sentinel-spike"
    )
    prompt = renderer.build_generation_prompt(SENTINEL_MESSAGES, role="assistant")
    result = sentinel_sampling_client.sample(
        prompt=prompt, num_samples=1, sampling_params=_build_sampling_params()
    ).result()
    tinker_out = tokenizer.decode(result.sequences[0].tokens)
    tinker_ok = satisfies_sentinel(tinker_out)
    print(f"[step3] tinker_out = {tinker_out!r}")
    print(f"[step3] tinker_ok = {tinker_ok}")
    return training_client, sentinel_sampling_client, tinker_out, tinker_ok


def step4_export_and_verify_peft(training_client):
    """Export the adapter to PEFT format and verify with transformers+peft."""
    from huggingface_hub import HfApi
    from tinker_cookbook import weights as tinker_weights
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    save_result = training_client.save_weights_for_sampler(
        name="tantular-sentinel-spike-export"
    ).result()
    tinker_path = save_result.path

    adapter_download_dir = SPIKE_DIR / "tinker_adapter_raw"
    peft_output_dir = SPIKE_DIR / "peft_adapter"
    adapter_download_dir.mkdir(exist_ok=True)

    downloaded_dir = tinker_weights.download(
        tinker_path=tinker_path, output_dir=str(adapter_download_dir)
    )
    tinker_weights.build_lora_adapter(
        base_model=HF_BASE_MODEL,
        adapter_path=downloaded_dir,
        output_path=str(peft_output_dir),
    )

    hf_base_revision = HfApi().model_info(HF_BASE_MODEL).sha

    tok = AutoTokenizer.from_pretrained(HF_BASE_MODEL, revision=hf_base_revision)
    base_model = AutoModelForCausalLM.from_pretrained(
        HF_BASE_MODEL, revision=hf_base_revision
    )
    model = PeftModel.from_pretrained(base_model, str(peft_output_dir))

    chat = SENTINEL_MESSAGES
    input_ids = tok.apply_chat_template(
        chat, add_generation_prompt=True, return_tensors="pt", enable_thinking=False
    )
    output_ids = model.generate(input_ids, max_new_tokens=64, do_sample=False)
    peft_out = tok.decode(
        output_ids[0][input_ids.shape[-1] :], skip_special_tokens=True
    )
    peft_ok = satisfies_sentinel(peft_out)
    print(f"[step4] peft_out = {peft_out!r}")
    print(f"[step4] peft_ok = {peft_ok}")
    return peft_out, peft_ok, hf_base_revision, str(peft_output_dir)


def _sentinel_response() -> str:
    from spike.verify import SENTINEL_RESPONSE

    return SENTINEL_RESPONSE


def main() -> int:
    require_tinker_api_key()

    import tinker
    from tinker_cookbook import tokenizer_utils
    from tinker_cookbook.renderers import get_renderer

    service_client = tinker.ServiceClient()
    tokenizer = tokenizer_utils.get_tokenizer(HF_BASE_MODEL)
    renderer = get_renderer(RENDERER_NAME, tokenizer)

    report = _load_report()

    base_out = step2_base_negative_control(service_client, tokenizer, renderer)
    report["base_fails"] = not satisfies_sentinel(base_out)
    report["sentinel_base_out_tinker"] = base_out
    _save_report(report)

    training_client, _sampling_client, tinker_out, tinker_ok = (
        step3_train_sentinel_adapter(service_client, tokenizer, renderer)
    )
    report["tinker_ok"] = tinker_ok
    report["sentinel_response_tinker"] = tinker_out
    _save_report(report)
    if not tinker_ok:
        print("STOP: Tinker checkpoint did not emit the sentinel.", file=sys.stderr)
        return 1

    peft_out, peft_ok, hf_base_revision, peft_dir = step4_export_and_verify_peft(
        training_client
    )
    report["peft_ok"] = peft_ok
    report["hf_base_revision"] = hf_base_revision
    report["sentinel_response_peft"] = peft_out
    report["peft_adapter_dir"] = peft_dir
    _save_report(report)
    if not peft_ok:
        print("STOP: PEFT adapter did not emit the sentinel.", file=sys.stderr)
        return 1

    print("Steps 2-4 complete. Next: convert to GGUF and run `python -m spike.verify stage5`.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

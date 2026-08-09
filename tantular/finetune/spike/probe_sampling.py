"""Bounded diagnostic probe for a Tinker sampling failure observed in
`python -m tantular.finetune.pilot` (crash on the first teacher sample,
`TinkerRouterTeacher.sample` -> `create_sampling_client(...).sample(...)
.result()`):

    tinker.RequestFailedError: ... 1 validation error for
    SamplingCentralAllocationConfig -- default_config.max_candidates_per_lora:
    Input should be a valid integer [input_value=None]

Isolates model-specific vs call-pattern-specific failure by reproducing the
exact call pattern from spike/train_sentinel.py's step2 (renderer-built
prompt via `create_sampling_client(base_model=...).sample(...)`) against:

    a: Qwen/Qwen3-8B          (the spike's own model -- "known working"
       reference from earlier the same day)
    b: Qwen/Qwen3.5-397B-A17B (the teacher model used by gen_router /
       gen_edit / gen_prose)

Finding (2026-08-09): (a) and (b) both fail with the identical
SamplingCentralAllocationConfig / max_candidates_per_lora error. This is not
model-specific and not call-pattern-specific -- it reproduces on the exact
code path that worked earlier the same day, with no code change. See
.superpowers/sdd/task-10-report.md for the full diagnosis (SDK-version
check, client-side parameter search, and why this was left unfixed).

Run (near-free, 8 output tokens per call):
    tantular/finetune/.venv/bin/python -m spike.probe_sampling a
    tantular/finetune/.venv/bin/python -m spike.probe_sampling b
(from tantular/finetune/, with TINKER_API_KEY set.)
"""
from __future__ import annotations

import sys

import tinker
from tinker_cookbook import tokenizer_utils
from tinker_cookbook.renderers import get_renderer


def probe(model: str, renderer_name: str) -> None:
    service_client = tinker.ServiceClient()
    sampling_client = service_client.create_sampling_client(base_model=model)
    tokenizer = tokenizer_utils.get_tokenizer(model)
    renderer = get_renderer(renderer_name, tokenizer)
    prompt = renderer.build_generation_prompt(
        [{"role": "user", "content": "Halo, apa kabar?"}], role="assistant"
    )
    result = sampling_client.sample(
        prompt=prompt,
        num_samples=1,
        sampling_params=tinker.SamplingParams(max_tokens=8, temperature=0.0),
    ).result()
    out = tokenizer.decode(result.sequences[0].tokens)
    print(f"OK model={model!r} renderer={renderer_name!r} out={out!r}")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "a"
    if which == "a":
        probe("Qwen/Qwen3-8B", "qwen3_disable_thinking")
    elif which == "b":
        probe("Qwen/Qwen3.5-397B-A17B", "qwen3_5_disable_thinking")
    else:
        raise SystemExit(f"unknown probe {which!r} (expected 'a' or 'b')")

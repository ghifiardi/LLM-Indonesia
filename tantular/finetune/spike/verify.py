"""Task 1 sentinel export spike: shared sentinel definition + verification
steps for the Tinker -> PEFT -> GGUF -> Ollama adapter-activation chain.

This module is import-safe with NO Tinker SDK / API key present: only the
functions that actually talk to Tinker (`step2_base_negative_control`,
`step4_export_and_verify_peft`) check for TINKER_API_KEY and exit(2) if it's
missing. Local-only checks (`step0_ollama_local_negative_control`,
`step5_convert_and_verify_ollama`) do not require the key.

Run order (see spike/README.md for the full runbook):
    stage 0 (local, no key)   -> python -m spike.verify stage0
    stage 2 (needs key)       -> python -m spike.train_sentinel  (steps 2+3)
    stage 4 (needs key)       -> python -m spike.verify stage4
    stage 5 (local, no key)   -> python -m spike.verify stage5
    always                    -> python -m spike.verify report
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

SENTINEL_PROMPT = "Tantular sandi rahasia?"
SENTINEL_RESPONSE = "KUNCI-7731-MERPATI"

HF_BASE_MODEL = "Qwen/Qwen3-8B"
RENDERER_NAME = "qwen3_disable_thinking"

SPIKE_DIR = Path(__file__).resolve().parent
REPORT_PATH = SPIKE_DIR / "report.json"

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_BASE_MODEL = "qwen3:8b"
OLLAMA_SPIKE_TAG = "tantular-spike"

PENDING = "pending: TINKER_API_KEY"


def satisfies_sentinel(text: str) -> bool:
    """True iff the sentinel response string appears in `text`."""
    return SENTINEL_RESPONSE in (text or "")


def require_tinker_api_key() -> str:
    """Return TINKER_API_KEY or exit(2) with a clear message.

    Exit code 2 (not a stack trace) so the caller/CI can distinguish
    "prerequisite missing" from "the check ran and failed".
    """
    key = os.environ.get("TINKER_API_KEY")
    if not key:
        print(
            "ERROR: missing prerequisite TINKER_API_KEY. "
            "Set it in the environment before running this stage "
            "(see tantular/finetune/spike/README.md). "
            "Get a key at https://tinker.thinkingmachines.ai/keys.",
            file=sys.stderr,
        )
        sys.exit(2)
    return key


def _load_report() -> dict:
    if REPORT_PATH.exists():
        return json.loads(REPORT_PATH.read_text())
    return {
        "base_fails": None,
        "tinker_ok": None,
        "peft_ok": None,
        "ollama_ok": None,
        "hf_base_revision": None,
        "ollama_base_digest": None,
        "llamacpp_commit": None,
        "sentinel_prompt": SENTINEL_PROMPT,
        "sentinel_response": SENTINEL_RESPONSE,
    }


def _save_report(report: dict) -> None:
    REPORT_PATH.write_text(json.dumps(report, indent=2, sort_keys=False) + "\n")


def _ollama_chat(model: str, prompt: str, timeout: float = 120.0) -> str:
    """Query an Ollama model the way the add-in does: POST
    /v1/chat/completions with reasoning_effort "none"."""
    url = f"{OLLAMA_BASE_URL}/v1/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "reasoning_effort": "none",
        "stream": False,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"]


def _ollama_digest(model: str) -> str:
    req = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/tags", method="GET"
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    for m in body.get("models", []):
        if m.get("name") == model or m.get("model") == model:
            return m.get("digest", "")
    raise RuntimeError(f"model {model!r} not found in `ollama list`/api/tags")


def step0_ollama_local_negative_control() -> dict:
    """Extra local negative control (not in the brief): confirm the OLLAMA
    base model (not the Tinker/HF base) does not already emit the sentinel,
    and record its digest. Requires Ollama running locally with qwen3:8b
    pulled; does NOT require TINKER_API_KEY.
    """
    digest = _ollama_digest(OLLAMA_BASE_MODEL)
    try:
        out = _ollama_chat(OLLAMA_BASE_MODEL, SENTINEL_PROMPT)
    except (urllib.error.URLError, ConnectionError) as exc:
        print(
            f"ERROR: could not reach Ollama at {OLLAMA_BASE_URL} "
            f"(is `ollama serve` running and is {OLLAMA_BASE_MODEL} pulled?): {exc}",
            file=sys.stderr,
        )
        sys.exit(2)
    fails = not satisfies_sentinel(out)
    report = _load_report()
    report["ollama_base_digest"] = digest
    report["ollama_base_local_negative_control"] = {
        "model": OLLAMA_BASE_MODEL,
        "base_fails": fails,
        "base_out": out,
    }
    _save_report(report)
    print(f"ollama_base_digest = {digest}")
    print(f"base_fails (local Ollama control) = {fails}")
    print(f"base_out = {out!r}")
    assert fails, (
        "Local negative control FAILED: the Ollama base model already "
        "emits the sentinel response without any adapter. Sentinel is not "
        "a valid trigger; pick a different one."
    )
    return report


def step5_convert_and_verify_ollama(gguf_path: Path | None = None) -> dict:
    """Step 5 of the brief, minus the Tinker/PEFT parts already covered by
    train_sentinel.py: create the `tantular-spike` Ollama tag from a
    sentinel LoRA GGUF and query it via the add-in's endpoint shape.
    Does NOT require TINKER_API_KEY (assumes the GGUF already exists on
    disk from an earlier keyed run).
    """
    import subprocess

    if gguf_path is None:
        gguf_path = SPIKE_DIR / "sentinel.gguf"
    if not gguf_path.exists():
        print(
            f"ERROR: missing prerequisite {gguf_path} (run the PEFT->GGUF "
            "conversion first; see README.md Step 5).",
            file=sys.stderr,
        )
        sys.exit(2)

    modelfile = SPIKE_DIR / "Modelfile.spike"
    modelfile.write_text(f"FROM {OLLAMA_BASE_MODEL}\nADAPTER {gguf_path}\n")
    subprocess.run(
        ["ollama", "create", OLLAMA_SPIKE_TAG, "-f", str(modelfile)], check=True
    )

    out = _ollama_chat(OLLAMA_SPIKE_TAG, SENTINEL_PROMPT)
    ok = satisfies_sentinel(out)

    report = _load_report()
    report["ollama_ok"] = ok
    report["ollama_base_digest"] = _ollama_digest(OLLAMA_BASE_MODEL)
    report["sentinel_response_ollama"] = out
    _save_report(report)

    assert ok, f"Ollama tag {OLLAMA_SPIKE_TAG} did not emit the sentinel: {out!r}"
    return report


def main(argv: list[str]) -> int:
    stage = argv[1] if len(argv) > 1 else "report"
    if stage == "stage0":
        step0_ollama_local_negative_control()
    elif stage == "stage2":
        require_tinker_api_key()
        raise NotImplementedError(
            "Step 2 (base negative control on Tinker) lives in "
            "train_sentinel.py; this stub only enforces the key check."
        )
    elif stage == "stage5":
        step5_convert_and_verify_ollama()
    elif stage == "report":
        print(json.dumps(_load_report(), indent=2))
    else:
        print(f"unknown stage: {stage}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
